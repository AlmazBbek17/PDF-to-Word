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
import { ocrPage } from './ocr.js';
import { initDb, pool, FREE_PAGES, findOrCreateAnonUser, findOrCreateUserFromGoogle, getUserByEmail, incrementUsageById } from './db.js';
import { verifyGoogleAccessToken, issueSessionToken, requireAuth, identifyQuotaSubject } from './auth.js';
import { createCheckoutSession, verifyAndParseWebhook, handleDodoEvent } from './billing.js';

dotenv.config();
const execFileAsync = promisify(execFile);

const app = express();
app.use(cors());

await initDb();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

app.get('/health', (req, res) => res.json({ ok: true }));

// Resolves the DB row for either a signed-in user (req.userEmail, set by
// identifyQuotaSubject/requireAuth) or an anonymous free-tier visitor (req.anonId).
// Returns null if no Postgres is attached — callers should treat that as "quota not tracked".
async function resolveQuotaUser(req) {
  if (!pool) return null;
  if (req.userEmail) return getUserByEmail(req.userEmail);
  if (req.anonId) return findOrCreateAnonUser(req.anonId);
  return null;
}

// ---------- Auth ----------
// Called only when the person actually starts a payment (hidden behind the
// "Оплатить" button) — never a separate, visible sign-in step.
app.post('/auth/google', express.json(), async (req, res) => {
  try {
    const { access_token, anonymous_id } = req.body;
    if (!access_token) return res.status(400).json({ error: 'Missing access_token' });
    const { email, sub } = await verifyGoogleAccessToken(access_token);
    const user = await findOrCreateUserFromGoogle({ email, googleSub: sub, anonId: anonymous_id });
    const token = issueSessionToken(email);
    res.json({ token, email: user.email, plan: user.plan, pages_limit: user.pages_limit, pages_used: user.pages_used });
  } catch (err) {
    console.error('auth/google error', err);
    res.status(401).json({ error: 'Google sign-in failed' });
  }
});

app.get('/me', requireAuth, async (req, res) => {
  const user = await getUserByEmail(req.userEmail);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ email: user.email, plan: user.plan, pages_limit: user.pages_limit, pages_used: user.pages_used });
});

// Lightweight quota check for BOTH signed-in and anonymous free-tier users —
// used to show the "N / M free" pill and to decide whether to show the paywall.
app.get('/quota', identifyQuotaSubject, async (req, res) => {
  const user = await resolveQuotaUser(req);
  if (!user) {
    if (!pool) return res.json({ signed_in: !!req.userEmail, plan: 'free', pages_limit: FREE_PAGES, pages_used: 0, tracked: false });
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ signed_in: !!req.userEmail, plan: user.plan, pages_limit: user.pages_limit, pages_used: user.pages_used });
});

// ---------- Billing ----------
app.post('/billing/checkout', requireAuth, express.json(), async (req, res) => {
  try {
    const { plan } = req.body;
    const returnUrl = `${process.env.PUBLIC_BASE_URL}/billing/success`;
    const checkoutUrl = await createCheckoutSession({ email: req.userEmail, planKey: plan, returnUrl });
    res.json({ checkout_url: checkoutUrl });
  } catch (err) {
    console.error('billing/checkout error', err);
    res.status(500).json({ error: err.message || 'Could not start checkout' });
  }
});

app.get('/billing/success', (req, res) => {
  res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;">
    <h2>Оплата прошла успешно 🎉</h2>
    <p>Можешь закрыть эту вкладку и вернуться в расширение — подписка активируется в течение нескольких секунд.</p>
  </body></html>`);
});

// Dodo needs the raw, unparsed body to verify the signature — must NOT go through express.json().
app.post('/webhooks/dodo', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const payload = await verifyAndParseWebhook(req.body.toString(), req.headers);
    await handleDodoEvent(payload);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('webhook error', err);
    res.status(400).json({ error: 'Invalid webhook' });
  }
});

// ---------- PDF utilities (no quota needed — cheap, no Claude calls) ----------
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
  const filePaths = [];
  for (const f of files) {
    const fp = path.join(tmpDir, f);
    buffers.push(await fs.readFile(fp));
    filePaths.push(fp);
  }
  return { buffers, filePaths };
}

// A page with no meaningful text layer is almost certainly a scan (raster-only) —
// pdftotext returns nothing useful for it, unlike a normal digital PDF page.
async function isScannedPage(pdfPath, pageNum) {
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-f', String(pageNum), '-l', String(pageNum), pdfPath, '-']);
    return stdout.replace(/\s/g, '').length < 20;
  } catch {
    return true;
  }
}

async function getPageSizeInches(pdfPath, pageNum) {
  const { stdout } = await execFileAsync('pdfinfo', ['-f', String(pageNum), '-l', String(pageNum), pdfPath]);
  const m = stdout.match(/Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/);
  if (!m) return null;
  return { width: parseFloat(m[1]) / 72, height: parseFloat(m[2]) / 72 };
}

// Extracts embedded raster images on one page — but skips any image whose
// physical footprint covers most of the page, since that's the scan itself
// (already transcribed as text) rather than a supplementary photo/logo.
// Embedding it separately would just duplicate the page as a giant picture.
async function extractPageImages(tmpDir, pdfPath, pageNum) {
  let listOutput;
  try {
    const { stdout } = await execFileAsync('pdfimages', ['-list', '-f', String(pageNum), '-l', String(pageNum), pdfPath]);
    listOutput = stdout;
  } catch {
    return [];
  }

  const pageSize = await getPageSizeInches(pdfPath, pageNum).catch(() => null);
  const rows = listOutput.split('\n').slice(2).filter(l => l.trim());
  const skipIndices = new Set();
  rows.forEach((row, idx) => {
    const cols = row.trim().split(/\s+/);
    // pdfimages -list columns: page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio
    const width = parseFloat(cols[3]);
    const height = parseFloat(cols[4]);
    const xppi = parseFloat(cols[12]);
    const yppi = parseFloat(cols[13]);
    if (pageSize && xppi > 0 && yppi > 0) {
      const imgWidthIn = width / xppi;
      const imgHeightIn = height / yppi;
      const coversPage = imgWidthIn >= pageSize.width * 0.85 && imgHeightIn >= pageSize.height * 0.85;
      if (coversPage) skipIndices.add(idx);
    }
  });

  const prefix = path.join(tmpDir, `pgimg-${pageNum}`);
  try {
    await execFileAsync('pdfimages', ['-j', '-f', String(pageNum), '-l', String(pageNum), pdfPath, prefix]);
  } catch {
    return [];
  }
  const files = (await fs.readdir(tmpDir))
    .filter(f => f.startsWith(`pgimg-${pageNum}-`))
    .sort();
  const bufs = [];
  for (let i = 0; i < files.length; i++) {
    if (skipIndices.has(i)) continue; // this one is the full-page scan itself
    bufs.push(await fs.readFile(path.join(tmpDir, files[i])));
  }
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

const OCR_GROUNDING_PROMPT = `

This page is a scan. Below is a raw OCR transcript of it (word order and paragraph breaks were measured from the actual pixel positions on the page, not guessed) — Tesseract OCR often garbles individual characters, especially accented/Cyrillic ones, but the paragraph structure and word order are reliable.
Use it as a grounding reference: prefer matching its wording where the image confirms it, fix obvious OCR character-level mistakes using what you see in the image, and follow its paragraph breaks for how you split "paragraph" blocks. If the OCR transcript and the image clearly disagree, trust the image.

--- OCR transcript start ---
{{OCR_TEXT}}
--- OCR transcript end ---`;

async function parsePageWithClaude(imageBuffer, ocrText) {
  const base64 = imageBuffer.toString('base64');
  let prompt = PAGE_PROMPT;
  if (ocrText) {
    prompt += OCR_GROUNDING_PROMPT.replace('{{OCR_TEXT}}', ocrText.slice(0, 6000));
  }
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        { type: 'text', text: prompt }
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

// Works for both anonymous free-tier visitors (X-Anonymous-Id header) and
// signed-in paying users (Bearer session token) — identifyQuotaSubject picks whichever is present.
app.post('/convert', identifyQuotaSubject, upload.single('file'), async (req, res) => {
  let tmpDir;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });

    const user = await resolveQuotaUser(req);
    if (!user && pool) return res.status(404).json({ error: 'User not found' });
    // user === null && !pool means no Postgres attached yet — quota isn't tracked,
    // conversion proceeds unmetered (useful while you're still setting up billing).

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf2word-'));
    const pdfPath = path.join(tmpDir, 'input.pdf');
    await fs.writeFile(pdfPath, req.file.buffer);

    const { buffers: pageImages, filePaths: pageImagePaths } = await renderPdfPagesInto(tmpDir, pdfPath);
    if (pageImages.length === 0) return res.status(422).json({ error: 'Could not render any pages from this PDF' });

    let indices = pageImages.map((_, i) => i);
    if (req.body.pages) {
      const wanted = String(req.body.pages).split(',').map(n => parseInt(n.trim(), 10) - 1);
      const filtered = wanted.filter(i => i >= 0 && i < pageImages.length);
      if (filtered.length) indices = filtered;
    }

    if (user) {
      const remaining = user.pages_limit - user.pages_used;
      if (indices.length > remaining) {
        return res.status(402).json({
          error: 'quota_exceeded',
          message: `Недостаточно страниц в лимите: нужно ${indices.length}, осталось ${Math.max(remaining, 0)}`,
          pages_limit: user.pages_limit,
          pages_used: user.pages_used,
        });
      }
    }

    const pageResults = [];
    for (const i of indices) {
      const pageNumber = i + 1;
      const scanned = await isScannedPage(pdfPath, pageNumber);
      let ocrText = null;
      if (scanned) {
        try {
          const ocrResult = await ocrPage(pageImagePaths[i], 'rus+eng');
          ocrText = ocrResult.rawText;
        } catch (err) {
          console.error(`OCR failed for page ${pageNumber}`, err.message);
        }
      }
      const [parsed, images] = await Promise.all([
        parsePageWithClaude(pageImages[i], ocrText),
        extractPageImages(tmpDir, pdfPath, pageNumber)
      ]);
      pageResults.push({ pageNumber, blocks: parsed.blocks || [], images });
    }

    const docxBuffer = await buildDocx(pageResults);
    if (user) await incrementUsageById(user.id, indices.length);

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
