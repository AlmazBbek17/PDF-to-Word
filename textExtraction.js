import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Decides whether a page is safe to extract directly from its PDF text
// layer (fast, free, and zero hallucination risk since it's a literal copy —
// not a model "reading" the page) versus needing the slower, paid Claude
// vision path (needed for tables, forms, right/centered alignment, boxed
// content, formulas — anything where LAYOUT carries meaning).
//
// Biased conservative on purpose: any ambiguity routes to Claude, since a
// wrong "simple" classification would silently degrade quality, which
// matters more than shaving a few seconds off one page.
export async function analyzeTextLayer(pdfPath, pageNum) {
  let layoutText;
  try {
    layoutText = (await execFileAsync('pdftotext', ['-layout', '-f', String(pageNum), '-l', String(pageNum), pdfPath, '-'])).stdout;
  } catch {
    return { simple: false, text: null }; // extraction itself failed — let Claude handle it
  }

  const lines = layoutText.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return { simple: false, text: null };

  // Signal 1: internal multi-space gaps -> likely a table/column grid.
  const gappedLines = lines.filter(l => /\S {3,}\S/.test(l)).length;
  const gapRatio = gappedLines / lines.length;

  // Signal 2: lines starting with significant leading whitespace -> likely
  // centered or right-aligned content (a header block, a signature line),
  // which plain left-flowing text extraction would flatten and lose.
  const indentedLines = lines.filter(l => /^ {10,}\S/.test(l)).length;
  const indentRatio = indentedLines / lines.length;

  // Signal 3: many very short lines relative to page length -> could be a
  // form or a table without wide gaps (narrow columns), still risky to flatten.
  const avgLen = lines.reduce((s, l) => s + l.trim().length, 0) / lines.length;
  const shortLineRatio = lines.filter(l => l.trim().length < 20).length / lines.length;

  const looksComplex = gapRatio > 0.12 || indentRatio > 0.15 || (avgLen < 25 && shortLineRatio > 0.4);

  if (looksComplex) return { simple: false, text: null };
  return { simple: true, text: layoutText };
}

// Converts plain extracted text into paragraph blocks — literal copy, no
// interpretation, so there's nothing for a model to get wrong here.
export function textToParagraphBlocks(text) {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map(p => p.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim())
    .filter(p => p.length > 0);
  return paragraphs.map(text => ({ type: 'paragraph', text }));
}
