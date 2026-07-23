// Parses a LaTeX string into real docx.js Math elements (fractions, radicals,
// sub/superscripts, functions, sums/integrals, delimiters) — the same
// approach as the reference backend, but built on docx.js's native Math
// primitives instead of hand-rolled OMML XML.
//
// Why LaTeX instead of a custom JSON schema: models are extensively trained
// on LaTeX, so asking for it is far more reliable than inventing a bespoke
// token format the model has never seen.

import {
  MathRun, MathFraction, MathRadical, MathSubScript, MathSuperScript,
  MathSubSuperScript, MathFunction, MathSum, MathIntegral,
  MathRoundBrackets, MathSquareBrackets, MathCurlyBrackets, MathAngledBrackets,
  createMathNAryProperties, createMathBase, createMathSubScriptElement, createMathSuperScriptElement,
} from 'docx';

const SYMBOLS = {
  '\\alpha':'α','\\beta':'β','\\gamma':'γ','\\delta':'δ','\\epsilon':'ε','\\zeta':'ζ','\\eta':'η','\\theta':'θ',
  '\\iota':'ι','\\kappa':'κ','\\lambda':'λ','\\mu':'μ','\\nu':'ν','\\xi':'ξ','\\pi':'π','\\rho':'ρ',
  '\\sigma':'σ','\\tau':'τ','\\upsilon':'υ','\\phi':'φ','\\chi':'χ','\\psi':'ψ','\\omega':'ω',
  '\\Alpha':'Α','\\Beta':'Β','\\Gamma':'Γ','\\Delta':'Δ','\\Epsilon':'Ε','\\Zeta':'Ζ','\\Eta':'Η','\\Theta':'Θ',
  '\\Iota':'Ι','\\Kappa':'Κ','\\Lambda':'Λ','\\Mu':'Μ','\\Nu':'Ν','\\Xi':'Ξ','\\Pi':'Π','\\Rho':'Ρ',
  '\\Sigma':'Σ','\\Tau':'Τ','\\Upsilon':'Υ','\\Phi':'Φ','\\Chi':'Χ','\\Psi':'Ψ','\\Omega':'Ω',
  '\\infty':'∞','\\partial':'∂','\\nabla':'∇','\\pm':'±','\\mp':'∓','\\times':'×','\\div':'÷',
  '\\cdot':'·','\\circ':'∘','\\bullet':'•','\\leq':'≤','\\geq':'≥','\\ll':'≪','\\gg':'≫',
  '\\neq':'≠','\\ne':'≠','\\approx':'≈','\\equiv':'≡','\\sim':'∼','\\simeq':'≃','\\propto':'∝',
  '\\in':'∈','\\notin':'∉','\\subset':'⊂','\\supset':'⊃','\\cup':'∪','\\cap':'∩','\\emptyset':'∅',
  '\\forall':'∀','\\exists':'∃','\\nexists':'∄',
  '\\rightarrow':'→','\\leftarrow':'←','\\Rightarrow':'⇒','\\Leftarrow':'⇐','\\leftrightarrow':'↔','\\Leftrightarrow':'⇔',
  '\\uparrow':'↑','\\downarrow':'↓','\\ldots':'…','\\cdots':'⋯','\\vdots':'⋮','\\ddots':'⋱',
  '\\hbar':'ℏ','\\ell':'ℓ','\\Re':'ℜ','\\Im':'ℑ','\\aleph':'ℵ','\\wp':'℘',
  '\\oplus':'⊕','\\otimes':'⊗','\\odot':'⊙','\\perp':'⊥','\\parallel':'∥','\\angle':'∠',
  '\\triangle':'△','\\square':'□','\\diamond':'◇','\\star':'⋆','\\dagger':'†','\\ddagger':'‡',
  '\\langle':'⟨','\\rangle':'⟩','\\{':'{','\\}':'}','\\|':'‖',
  '\\%':'%','\\$':'$','\\#':'#','\\&':'&','\\quad':' ','\\qquad':'  ','\\ ':' ','\\,':' ',
  '\\mathbb{R}':'ℝ','\\mathbb{N}':'ℕ','\\mathbb{Z}':'ℤ','\\mathbb{Q}':'ℚ','\\mathbb{C}':'ℂ',
};
const SYMBOL_KEYS = Object.keys(SYMBOLS).sort((a, b) => b.length - a.length);

const FUNCTIONS = new Set(['sin','cos','tan','cot','sec','csc','arcsin','arccos','arctan',
  'sinh','cosh','tanh','log','ln','exp','lim','max','min','sup','inf','det','dim','ker','gcd']);
const NARY = { sum:'∑', prod:'∏', int:'∫', oint:'∮', iint:'∬', iiint:'∭', bigcup:'⋃', bigcap:'⋂', bigoplus:'⊕', bigotimes:'⊗' };
const TEXT_MODE_CMDS = new Set(['mathbf','mathit','mathrm','mathsf','mathtt','mathcal','mathbb','mathfrak',
  'text','textrm','textit','textbf','operatorname']);

function findMatchingBrace(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { if (depth === 0) return i; depth--; }
  }
  return s.length;
}
function readGroup(s, pos) {
  while (pos < s.length && s[pos] === ' ') pos++;
  if (pos >= s.length) return ['', pos];
  if (s[pos] === '{') {
    const end = findMatchingBrace(s, pos + 1);
    return [s.slice(pos + 1, end), end + 1];
  }
  return [s[pos], pos + 1];
}
// Used specifically for ^ and _ targets: unlike readGroup, a bare command
// like \infty is captured whole (not just its leading backslash) when not
// wrapped in braces — e.g. x^\infty needs the full "\infty", not "\".
function readGroupOrChar(s, pos) {
  while (pos < s.length && s[pos] === ' ') pos++;
  if (pos >= s.length) return ['', pos];
  if (s[pos] === '{') return readGroup(s, pos);
  if (s[pos] === '\\') {
    const m = s.slice(pos).match(/^\\([a-zA-Z]+)\*?/);
    if (m) return [s.slice(pos, pos + m[0].length), pos + m[0].length];
  }
  return [s[pos], pos + 1];
}

// Generic n-ary builder (covers ∏ and other symbols MathSum/MathIntegral don't expose directly).
function makeNary(symbol, children, subScript, superScript) {
  const el = { root: [] };
  // Mirrors MathSum/MathIntegral's own construction, using the same exported helpers.
  const props = createMathNAryProperties({ accent: symbol, hasSuperScript: !!superScript, hasSubScript: !!subScript });
  const parts = [props];
  if (subScript) parts.push(createMathSubScriptElement({ children: subScript }));
  if (superScript) parts.push(createMathSuperScriptElement({ children: superScript }));
  parts.push(createMathBase({ children }));
  // Wrap using MathSum's own XML tag ("m:nary") by piggybacking a MathSum instance's shape.
  const dummy = new MathSum({ children: [new MathRun('')] });
  dummy.root = parts;
  return dummy;
}

export function parseLatex(latex) {
  latex = (latex || '').trim();
  const elements = [];
  let i = 0;

  while (i < latex.length) {
    const ch = latex[i];

    if (ch === '\\') {
      let matched = false;
      for (const key of SYMBOL_KEYS) {
        if (latex.startsWith(key, i)) {
          const after = i + key.length;
          if (after < latex.length && /[a-zA-Z]/.test(latex[after])) continue; // avoid partial command match
          elements.push(new MathRun(SYMBOLS[key]));
          i = after;
          if (latex[i] === ' ') i++;
          matched = true;
          break;
        }
      }
      if (matched) continue;

      const cmdMatch = latex.slice(i).match(/^\\([a-zA-Z]+)\*?/);
      if (!cmdMatch) { elements.push(new MathRun(latex[i])); i++; continue; }
      const cmd = cmdMatch[1];
      let after = i + cmdMatch[0].length;

      if (cmd === 'frac') {
        const [numG, a1] = readGroup(latex, after);
        const [denG, a2] = readGroup(latex, a1);
        elements.push(new MathFraction({ numerator: parseLatex(numG), denominator: parseLatex(denG) }));
        i = a2;
      } else if (cmd === 'sqrt') {
        if (latex[after] === '[') {
          const end = latex.indexOf(']', after);
          const degree = parseLatex(latex.slice(after + 1, end));
          const [contentG, a2] = readGroup(latex, end + 1);
          elements.push(new MathRadical({ children: parseLatex(contentG), degree }));
          i = a2;
        } else {
          const [contentG, a2] = readGroup(latex, after);
          elements.push(new MathRadical({ children: parseLatex(contentG) }));
          i = a2;
        }
      } else if (cmd === 'left') {
        const beg = latex[after] === '\\' ? latex[after + 1] : latex[after];
        const begLen = latex[after] === '\\' ? 2 : 1;
        const rightPos = latex.indexOf('\\right', after);
        if (rightPos === -1) { elements.push(new MathRun('(')); i = after + begLen; }
        else {
          const inner = latex.slice(after + begLen, rightPos);
          let a2 = rightPos + 6; // len('\right')
          const innerEls = parseLatex(inner);
          if (beg === '(') elements.push(new MathRoundBrackets({ children: innerEls }));
          else if (beg === '[') elements.push(new MathSquareBrackets({ children: innerEls }));
          else if (beg === '{') elements.push(new MathCurlyBrackets({ children: innerEls }));
          else if (beg === '<') elements.push(new MathAngledBrackets({ children: innerEls }));
          else { elements.push(new MathRun(beg), ...innerEls, new MathRun(latex[a2 - 1] || ')')); }
          // Skip the closing delimiter char after \right
          if (latex[a2] === '\\') a2 += 2; else a2 += 1;
          i = a2;
        }
      } else if (NARY[cmd]) {
        const symbol = NARY[cmd];
        let sub = null, sup = null, t = after;
        if (latex[t] === '_') { t++; const [g, a] = readGroupOrChar(latex, t); sub = parseLatex(g); t = a; }
        if (latex[t] === '^') { t++; const [g, a] = readGroupOrChar(latex, t); sup = parseLatex(g); t = a; }
        let contentG = '';
        if (latex[t] === '{') { const [g, a] = readGroup(latex, t); contentG = g; t = a; }
        const content = contentG ? parseLatex(contentG) : [new MathRun('')];
        if (cmd === 'sum') elements.push(new MathSum({ children: content, subScript: sub || undefined, superScript: sup || undefined }));
        else if (cmd === 'int' || cmd === 'oint') elements.push(new MathIntegral({ children: content, subScript: sub || undefined, superScript: sup || undefined }));
        else elements.push(makeNary(symbol, content, sub, sup));
        i = t;
      } else if (FUNCTIONS.has(cmd)) {
        while (latex[after] === ' ') after++;
        let argEls;
        if (latex[after] === '{') { const [g, a] = readGroup(latex, after); argEls = parseLatex(g); after = a; }
        else if (after < latex.length) { argEls = [new MathRun(latex[after])]; after++; }
        else argEls = [];
        elements.push(new MathFunction({ name: [new MathRun(cmd)], children: argEls }));
        i = after;
      } else if (cmd === 'boldsymbol' || cmd === 'bm') {
        // Bold isn't visually applied (docx.js Math styling for this is more
        // effort than it's worth right now), but the content is still parsed
        // as real math — e.g. \boldsymbol{\Sigma} still becomes Σ, not literal text.
        const [g, a] = readGroup(latex, after);
        elements.push(...parseLatex(g));
        i = a;
      } else if (TEXT_MODE_CMDS.has(cmd)) {
        const [g, a] = readGroup(latex, after);
        elements.push(new MathRun(g));
        i = a;
      } else {
        elements.push(new MathRun('\\' + cmd));
        i = after;
      }
      continue;
    }

    if (ch === '^') {
      i++;
      const [g, a] = readGroupOrChar(latex, i);
      const sup = parseLatex(g);
      i = a;
      const base = elements.length ? [elements.pop()] : [new MathRun('')];
      if (latex[i] === '_') {
        i++;
        const [g2, a2] = readGroupOrChar(latex, i);
        const sub = parseLatex(g2);
        i = a2;
        elements.push(new MathSubSuperScript({ children: base, subScript: sub, superScript: sup }));
      } else {
        elements.push(new MathSuperScript({ children: base, superScript: sup }));
      }
      continue;
    }
    if (ch === '_') {
      i++;
      const [g, a] = readGroupOrChar(latex, i);
      const sub = parseLatex(g);
      i = a;
      const base = elements.length ? [elements.pop()] : [new MathRun('')];
      if (latex[i] === '^') {
        i++;
        const [g2, a2] = readGroupOrChar(latex, i);
        const sup = parseLatex(g2);
        i = a2;
        elements.push(new MathSubSuperScript({ children: base, subScript: sub, superScript: sup }));
      } else {
        elements.push(new MathSubScript({ children: base, subScript: sub }));
      }
      continue;
    }
    if (ch === '{') {
      const [g, a] = readGroup(latex, i);
      elements.push(...parseLatex(g));
      i = a;
      continue;
    }
    if (ch === '}') { i++; continue; }

    elements.push(new MathRun(ch));
    i++;
  }
  return elements;
}
