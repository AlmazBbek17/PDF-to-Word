import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execFileAsync = promisify(execFile);

// All 10 UI languages the extension supports, grouped by script. Combining
// every language in one OCR pass works but is noticeably slower (~5x) than
// running only the languages that actually match the page — Tesseract still
// evaluates every loaded dictionary even when most don't apply. A cheap OSD
// (script detection) pre-pass lets us pick the right group instead.
const LATIN_LANGS = 'eng+deu+fra+spa+por+ita+nld'; // en, de, fr, es, pt, it, nl — OSD can't tell these apart
const SCRIPT_TO_LANGS = {
  Latin: LATIN_LANGS,
  Cyrillic: 'rus+eng',
  Japanese: 'jpn+eng',
  Han: 'jpn+eng',        // Kanji-heavy pages are usually Japanese in our supported set (no Chinese UI language)
  Hiragana: 'jpn+eng',
  Katakana: 'jpn+eng',
  Korean: 'kor+eng',
  Hangul: 'kor+eng',
};

const ALL_LANGS = 'eng+rus+deu+fra+spa+por+ita+nld+jpn+kor';

// Fast (~0.5s) pass that only detects the writing system, not the actual
// text — used to pick a small, fast language subset for the real OCR pass
// below instead of always loading all 10 languages (~9s vs ~2-6s).
// Returns null if OSD couldn't confidently classify the script (common on
// short or sparse text, e.g. a single header line) — callers should treat
// null as "unknown", not "Latin", since guessing wrong silently breaks
// non-Latin scripts (Japanese/Korean/Cyrillic) entirely.
async function detectScript(imagePath) {
  try {
    const { stdout } = await execFileAsync('tesseract', [imagePath, 'stdout', '--psm', '0']);
    const match = stdout.match(/Script:\s*(\w+)/);
    return match ? match[1] : null;
  } catch {
    return null; // OSD itself failed (e.g. "too few characters") — genuinely unknown
  }
}

async function resolveOcrLangs(imagePath) {
  const script = await detectScript(imagePath);
  if (!script) return ALL_LANGS; // unknown script — pay the slower full pass rather than guess wrong
  return SCRIPT_TO_LANGS[script] || LATIN_LANGS;
}

// Runs Tesseract on a page image and returns word-level bounding boxes.
// TSV columns: level,page_num,block_num,par_num,line_num,word_num,left,top,width,height,conf,text
async function ocrWords(imagePath, lang) {
  const { stdout } = await execFileAsync('tesseract', [imagePath, 'stdout', '-l', lang, '--psm', '3', 'tsv']);
  const lines = stdout.split('\n').slice(1); // drop header
  const words = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 12) continue;
    const [level, , blockNum, parNum, lineNum, , left, top, width, height, conf, ...textParts] = cols;
    const text = textParts.join('\t');
    if (level !== '5' || !text.trim()) continue; // level 5 = word
    words.push({
      block: parseInt(blockNum, 10),
      par: parseInt(parNum, 10),
      line: parseInt(lineNum, 10),
      x: parseInt(left, 10),
      y: parseInt(top, 10),
      w: parseInt(width, 10),
      h: parseInt(height, 10),
      conf: parseFloat(conf),
      text,
    });
  }
  return words;
}

// Groups OCR words (already in reading order from Tesseract) into lines, then
// lines into paragraphs based on vertical gaps, then estimates column breaks
// from horizontal gaps — giving us real measured structure instead of a guess.
function groupIntoParagraphs(words) {
  if (words.length === 0) return [];

  const lineMap = new Map(); // key "block-par-line" -> words[]
  for (const w of words) {
    const key = `${w.block}-${w.par}-${w.line}`;
    if (!lineMap.has(key)) lineMap.set(key, []);
    lineMap.get(key).push(w);
  }

  const lines = [...lineMap.values()].map(lineWords => {
    lineWords.sort((a, b) => a.x - b.x);
    const text = lineWords.map(w => w.text).join(' ');
    const y = Math.min(...lineWords.map(w => w.y));
    const height = Math.max(...lineWords.map(w => w.y + w.h)) - y;
    const avgConf = lineWords.reduce((s, w) => s + w.conf, 0) / lineWords.length;
    return { text, y, height, avgConf, block: lineWords[0].block, par: lineWords[0].par };
  }).sort((a, b) => a.y - b.y);

  // Group lines into paragraphs: a new paragraph starts when the gap to the
  // previous line is noticeably larger than the typical line height, or
  // Tesseract's own paragraph index changes.
  const paragraphs = [];
  let current = null;
  let prevBottom = null;
  const typicalHeight = median(lines.map(l => l.height)) || 20;

  for (const line of lines) {
    const gap = prevBottom === null ? 0 : line.y - prevBottom;
    const isNewParagraph = !current
      || gap > typicalHeight * 0.9
      || (line.block !== current.block || line.par !== current.par);

    if (isNewParagraph) {
      current = { block: line.block, par: line.par, lines: [line.text], avgConf: [line.avgConf] };
      paragraphs.push(current);
    } else {
      current.lines.push(line.text);
      current.avgConf.push(line.avgConf);
    }
    prevBottom = line.y + line.height;
  }

  return paragraphs.map(p => ({
    text: p.lines.join(' '),
    avgConf: p.avgConf.reduce((s, c) => s + c, 0) / p.avgConf.length,
  }));
}

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Full pipeline for one scanned page: detect script -> OCR with the matching
// language subset -> measured paragraphs, plus raw text (for Claude to clean
// up wording without re-guessing layout). Covers all 10 UI languages.
export async function ocrPage(imagePath) {
  const lang = await resolveOcrLangs(imagePath);
  const words = await ocrWords(imagePath, lang);
  const paragraphs = groupIntoParagraphs(words);
  return {
    paragraphs,
    rawText: paragraphs.map(p => p.text).join('\n\n'),
    lowConfidenceCount: paragraphs.filter(p => p.avgConf < 60).length,
    detectedLang: lang,
  };
}
