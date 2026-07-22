import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, PageBreak, ShadingType, ImageRun, AlignmentType, BorderStyle } from 'docx';
import sizeOf from 'image-size';

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
// highlighting the marked (low-confidence) fragments.
function runsForText(text) {
  const parts = String(text).split(/(\{\{[^{}]*\}\})/g).filter(p => p.length > 0);
  return parts.map(part => {
    const m = part.match(/^\{\{([^{}]*)\}\}$/);
    if (m) {
      return new TextRun({ text: m[1], shading: { type: ShadingType.CLEAR, fill: 'FCE4C8' }, color: '8A4B0F' });
    }
    return new TextRun(part);
  });
}

function blockToParagraphs(block) {
  if (block.type === 'heading') {
    return [new Paragraph({
      heading: HeadingLevel.HEADING_2,
      alignment: resolveAlign(block.align),
      children: runsForText(block.text || '')
    })];
  }
  if (block.type === 'paragraph') {
    return [new Paragraph({
      spacing: { after: 160 },
      alignment: resolveAlign(block.align),
      style: styleForAlign(block.align),
      children: runsForText(block.text || '')
    })];
  }
  if (block.type === 'boxed') {
    return [new Paragraph({
      spacing: { after: 160, before: 40 },
      alignment: resolveAlign(block.align),
      border: BOXED_BORDER,
      style: 'BoxedText',
      children: runsForText(block.text || '')
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
            children: [new Paragraph({ children: runsForText(row[ci] ?? '') })]
          })
        )
      })
    );
    return [new Table({ width: { size: 9000, type: WidthType.DXA }, rows }), new Paragraph({ text: '', spacing: { after: 160 } })];
  }
  return [];
}

export async function buildDocx(pageResults) {
  const children = [];
  pageResults.forEach((page, idx) => {
    for (const block of page.blocks) {
      children.push(...blockToParagraphs(block));
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
  return Packer.toBuffer(doc);
}
