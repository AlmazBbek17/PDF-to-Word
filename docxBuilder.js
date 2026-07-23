import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, PageBreak, ShadingType, ImageRun, AlignmentType, BorderStyle, Math as DocxMath, MathRun, MathFraction, MathSubScript, MathSuperScript } from 'docx';
import sizeOf from 'image-size';

// Converts our formula-token JSON (from the model) into real docx.js Math
// elements — actual editable Word equations (fractions, subscripts,
// superscripts), not a flattened text approximation.
function tokensToMathChildren(tokens) {
  if (!Array.isArray(tokens)) return [];
  const out = [];
  for (const tok of tokens) {
    if (typeof tok === 'string') {
      if (tok.length) out.push(new MathRun(tok));
    } else if (tok && typeof tok === 'object') {
      if ('sub' in tok) {
        out.push(new MathSubScript({
          children: [new MathRun(String(tok.sub ?? ''))],
          subScript: [new MathRun(String(tok.text ?? ''))],
        }));
      } else if ('sup' in tok) {
        out.push(new MathSuperScript({
          children: [new MathRun(String(tok.sup ?? ''))],
          superScript: [new MathRun(String(tok.text ?? ''))],
        }));
      } else if (tok.frac) {
        out.push(new MathFraction({
          numerator: tokensToMathChildren(tok.frac.num || []),
          denominator: tokensToMathChildren(tok.frac.den || []),
        }));
      }
    }
  }
  return out;
}

const MAX_IMG_WIDTH = 460; // px in the resulting docx

const ALIGN_MAP = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT };
function resolveAlign(align) {
  return ALIGN_MAP[align] || AlignmentType.LEFT;
}

// Only non-default alignments need a named style — plain left-aligned text
// already renders correctly in the preview as a normal paragraph.
function styleForAlign(align) {
  if (align === 'right') return 'AlignRight';
  if (align === 'center') return 'AlignCenter';
  return undefined;
}

// A thin single-line border on all four sides, with some breathing room
// between the text and the border — for text that visually sits inside a
// drawn box on the original page but isn't a table (stamps, signature
// blocks, bordered notes).
const BOXED_BORDER = {
  top:    { style: BorderStyle.SINGLE, size: 6, color: '444444', space: 8 },
  bottom: { style: BorderStyle.SINGLE, size: 6, color: '444444', space: 8 },
  left:   { style: BorderStyle.SINGLE, size: 6, color: '444444', space: 8 },
  right:  { style: BorderStyle.SINGLE, size: 6, color: '444444', space: 8 },
};

function imageParagraph(buffer) {
  let width = MAX_IMG_WIDTH, height = MAX_IMG_WIDTH * 0.6;
  try {
    const dim = sizeOf(buffer);
    if (dim.width && dim.height) {
      width = Math.min(MAX_IMG_WIDTH, dim.width);
      height = Math.round(width * (dim.height / dim.width));
    }
  } catch { /* fall back to default box if dimensions can't be read */ }

  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 200 },
    children: [ new ImageRun({ type: 'jpg', data: buffer, transformation: { width, height } }) ]
  });
}

// Splits text on {{...}} markers and returns an array of TextRun,
// highlighting the marked (low-confidence) fragments. Also tallies word
// counts into `stats` so the caller can report a real confidence percentage
// and a real count of flagged spots — not a placeholder.
function runsForText(text, stats) {
  const parts = String(text).split(/(\{\{[^{}]*\}\})/g).filter(p => p.length > 0);
  return parts.map(part => {
    const m = part.match(/^\{\{([^{}]*)\}\}$/);
    if (m) {
      const flaggedWords = m[1].trim().split(/\s+/).filter(Boolean).length;
      stats.totalWords += flaggedWords;
      stats.flaggedWords += flaggedWords;
      stats.flaggedCount += 1;
      return new TextRun({ text: m[1], shading: { type: ShadingType.CLEAR, fill: 'FCE4C8' }, color: '8A4B0F' });
    }
    stats.totalWords += part.trim().split(/\s+/).filter(Boolean).length;
    return new TextRun(part);
  });
}

function blockToParagraphs(block, stats) {
  if (block.type === 'heading') {
    return [new Paragraph({
      heading: HeadingLevel.HEADING_2,
      alignment: resolveAlign(block.align),
      children: runsForText(block.text || '', stats)
    })];
  }
  if (block.type === 'paragraph') {
    return [new Paragraph({
      spacing: { after: 160 },
      alignment: resolveAlign(block.align),
      style: styleForAlign(block.align),
      children: runsForText(block.text || '', stats)
    })];
  }
  if (block.type === 'boxed') {
    return [new Paragraph({
      spacing: { after: 160, before: 40 },
      alignment: resolveAlign(block.align),
      border: BOXED_BORDER,
      style: 'BoxedText',
      children: runsForText(block.text || '', stats)
    })];
  }
  if (block.type === 'formula') {
    const mathChildren = tokensToMathChildren(block.tokens);
    if (mathChildren.length === 0) return [];
    return [new Paragraph({
      spacing: { after: 160, before: 80 },
      alignment: resolveAlign(block.align || 'center'),
      children: [ new DocxMath({ children: mathChildren }) ]
    })];
  }
  if (block.type === 'table' && Array.isArray(block.rows) && block.rows.length) {
    const colCount = Math.max(...block.rows.map(r => r.length));
    const rows = block.rows.map((row, ri) =>
      new TableRow({
        children: Array.from({ length: colCount }, (_, ci) =>
          new TableCell({
            width: { size: Math.floor(9000 / colCount), type: WidthType.DXA },
            shading: ri === 0 ? { type: ShadingType.CLEAR, fill: 'EEF0F6' } : undefined,
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
            children: [new Paragraph({ children: runsForText(row[ci] ?? '', stats) })]
          })
        )
      })
    );
    return [new Table({ width: { size: 9000, type: WidthType.DXA }, rows }), new Paragraph({ text: '', spacing: { after: 160 } })];
  }
  return [];
}

export async function buildDocx(pageResults) {
  const stats = { totalWords: 0, flaggedWords: 0, flaggedCount: 0 };
  const children = [];
  pageResults.forEach((page, idx) => {
    for (const block of page.blocks) {
      children.push(...blockToParagraphs(block, stats));
    }
    for (const imgBuf of (page.images || [])) {
      children.push(imageParagraph(imgBuf));
    }
    if (idx < pageResults.length - 1) {
      // Tagged with a named style (not just a bare page break) so the frontend
      // preview (via mammoth's styleMap) can detect exactly where pages split
      // and render the result as separate sheets, matching the original PDF view.
      children.push(new Paragraph({ style: 'PageBreakMarker', children: [new PageBreak()] }));
    }
  });

  if (children.length === 0) {
    children.push(new Paragraph({ text: 'Не удалось извлечь содержимое из выбранных страниц.' }));
  }

  const doc = new Document({
    styles: {
      paragraphStyles: [
        { id: 'PageBreakMarker', name: 'Page Break Marker', basedOn: 'Normal', next: 'Normal' },
        { id: 'AlignRight', name: 'Align Right', basedOn: 'Normal', next: 'Normal', paragraph: { alignment: AlignmentType.RIGHT } },
        { id: 'AlignCenter', name: 'Align Center', basedOn: 'Normal', next: 'Normal', paragraph: { alignment: AlignmentType.CENTER } },
        { id: 'BoxedText', name: 'Boxed Text', basedOn: 'Normal', next: 'Normal', paragraph: { border: BOXED_BORDER } },
      ]
    },
    sections: [{ children }]
  });
  const buffer = await Packer.toBuffer(doc);

  const confidencePct = stats.totalWords > 0
    ? Math.round(((stats.totalWords - stats.flaggedWords) / stats.totalWords) * 100)
    : 100;

  return { buffer, stats: { ...stats, confidencePct } };
}
