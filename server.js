import express from 'express';
import multer from 'multer';
import cors from 'cors';
import dotenv from 'dotenv';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import Anthropic from '@anthropic-ai/sdk';
import { buildDocx } from './docxBuilder.js';

dotenv.config();
const execFileAsync = promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/page-count', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf2word-count-'));
    const pdfPath = path.join(tmpDir, 'input.pdf');
    await fs.writeFile(pdfPath, req.file.buffer);
    const { stdout } = await execFileAsync('pdfinfo', [pdfPath]);
    await fs.rm(tmpDir, { recursive: true, force: true });
    const match = stdout.match(/Pages:\s+(\d+)/);
    res.json({ pages: match ? parseInt(match[1], 10) : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not read PDF' });
  }
});

// Real, low-resolution page thumbnails for the page-picker screen — fast,
// separate from the higher-res render used for the actual Claude vision call.
app.post('/page-preview', upload.single('file'), async (req, res) => {
  let tmpDir;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf2word-preview-'));
    const pdfPath = path.join(tmpDir, 'input.pdf');
    await fs.writeFile(pdfPath, req.file.buffer);
    const prefix = path.join(tmpDir, 'p');
    await execFileAsync('pdftoppm', ['-jpeg', '-r', '70', pdfPath, prefix]);
    const files = (await fs.readdir(tmpDir))
      .filter(f => f.startsWith('p') && f.endsWith('.jpg'))
      .sort((a, b) => {
        const na = parseInt(a.match(/-(\d+)\.jpg$/)?.[1] || '0', 10);
        const nb = parseInt(b.match(/-(\d+)\.jpg$/)?.[1] || '0', 10);
        return na - nb;
      });
    const pages = [];
    for (const f of files) {
      const buf = await fs.readFile(path.join(tmpDir, f));
      pages.push(buf.toString('base64'));
    }
    res.json({ pages });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not render preview' });
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// Renders every page of a PDF to JPEG (for the Claude vision call) inside
// the given tmpDir, which the caller is responsible for cleaning up.
async function renderPdfPagesInto(tmpDir, pdfPath) {
  const prefix = path.join(tmpDir, 'page');
  await execFileAsync('pdftoppm', ['-jpeg', '-r', '150', pdfPath, prefix]);
  const files = (await fs.readdir(tmpDir))
    .filter(f => f.startsWith('page') && f.endsWith('.jpg'))
    .sort((a, b) => {
      const na = parseInt(a.match(/-(\d+)\.jpg$/)?.[1] || '0', 10);
      const nb = parseInt(b.match(/-(\d+)\.jpg$/)?.[1] || '0', 10);
      return na - nb;
    });
  const buffers = [];
  for (const f of files) buffers.push(await fs.readFile(path.join(tmpDir, f)));
  return buffers;
}

// Extracts embedded raster images (logos, photos) that live on one specific
// page of the PDF, as real binary JPEGs — no model involved, no hallucination risk.
async function extractPageImages(tmpDir, pdfPath, pageNum) {
  const prefix = path.join(tmpDir, `pgimg-${pageNum}`);
  try {
    await execFileAsync('pdfimages', ['-j', '-f', String(pageNum), '-l', String(pageNum), pdfPath, prefix]);
  } catch {
    return [];
  }
  const files = (await fs.readdir(tmpDir)).filter(f => f.startsWith(`pgimg-${pageNum}-`));
  const bufs = [];
  for (const f of files) bufs.push(await fs.readFile(path.join(tmpDir, f)));
  return bufs;
}

const PAGE_PROMPT = `You are converting a scanned or digital document page into structured content for a Word document.
Look at the page image and return ONLY valid JSON (no markdown fences, no commentary) matching this shape:

{
  "blocks": [
    { "type": "heading", "text": "..." },
    { "type": "paragraph", "text": "..." },
    { "type": "table", "rows": [["cell","cell"], ["cell","cell"]] }
  ]
}

Rules:
- Preserve the original language of the document exactly — do not translate.
- Preserve reading order top to bottom.
- Use "heading" only for real section titles, not for emphasis.
- For any word or number you are not confident about (blurry, cut off, ambiguous), wrap ONLY that fragment in double curly braces, e.g. "the total is {{4,850.00}}". Do not wrap text you are confident about.
- Never invent text that is not visibly present on the page.
- Do NOT describe or transcribe photos/illustrations/logos — those are handled separately. Only transcribe actual text and tables.
- If the page is blank or has no extractable text, return {"blocks": []}.
- Do not include page numbers, headers/footers that just repeat, as separate noise blocks unless they carry real information.`;

async function parsePageWithClaude(imageBuffer) {
  const base64 = imageBuffer.toString('base64');
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        { type: 'text', text: PAGE_PROMPT }
      ]
    }]
  });
  const text = msg.content.find(b => b.type === 'text')?.text || '{"blocks":[]}';
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { blocks: [{ type: 'paragraph', text: '[Не удалось разобрать страницу]' }] };
  }
}

app.post('/convert', upload.single('file'), async (req, res) => {
  let tmpDir;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf2word-'));
    const pdfPath = path.join(tmpDir, 'input.pdf');
    await fs.writeFile(pdfPath, req.file.buffer);

    const pageImages = await renderPdfPagesInto(tmpDir, pdfPath);
    if (pageImages.length === 0) return res.status(422).json({ error: 'Could not render any pages from this PDF' });

    let indices = pageImages.map((_, i) => i);
    if (req.body.pages) {
      const wanted = String(req.body.pages).split(',').map(n => parseInt(n.trim(), 10) - 1);
      const filtered = wanted.filter(i => i >= 0 && i < pageImages.length);
      if (filtered.length) indices = filtered;
    }

    const pageResults = [];
    for (const i of indices) {
      const pageNumber = i + 1;
      const [parsed, images] = await Promise.all([
        parsePageWithClaude(pageImages[i]),
        extractPageImages(tmpDir, pdfPath, pageNumber)
      ]);
      pageResults.push({ pageNumber, blocks: parsed.blocks || [], images });
    }

    const docxBuffer = await buildDocx(pageResults);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="converted.docx"`);
    res.setHeader('X-Pages-Converted', String(indices.length));
    res.send(docxBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Conversion failed' });
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`pdf-to-word backend listening on :${PORT}`));
