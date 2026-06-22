// Copyright (c) Opendatalab. All rights reserved.
/**
 * PDF text extraction utilities using pdfjs-dist.
 *
 * Browser workaround: Python uses pdftext library (get_chars, get_spans, get_lines, get_blocks).
 * Here we use pdfjs-dist getTextContent() and reconstruct the same page dict structure.
 */

const LINE_TOLERANCE = 4;  // px — y-proximity threshold for grouping spans into lines
const BLOCK_GAP = 16;      // px — vertical gap threshold for splitting lines into blocks

/**
 * Extract text page data from a pdfjs PDFPageProxy.
 * Returns a dict matching the Python `page` structure:
 *   { size, bbox, width, height, rotation, blocks }
 *
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @param {object} [opts]
 * @param {boolean}   [opts.quoteLoosebox=true]
 * @param {number}    [opts.superscriptHeightThreshold=0.7]
 * @param {number}    [opts.lineDistanceThreshold=0.1]
 * @returns {Promise<object>}
 */
export async function getPage(page, {
  quoteLoosebox = true,
  superscriptHeightThreshold = 0.7,
  lineDistanceThreshold = 0.1,
} = {}) {
  if (!page) {
    return { size: [0, 0], bbox: [0, 0, 0, 0], width: 0, height: 0, rotation: 0, blocks: [] };
  }

  const viewport = page.getViewport({ scale: 1 });
  const pageWidth = Math.ceil(viewport.width);
  const pageHeight = Math.ceil(viewport.height);
  const pageBbox = [0, 0, pageWidth, pageHeight];
  const pageRotation = page.rotate ?? 0;

  const textContent = await page.getTextContent();
  const blocks = groupTextContentToBlocks(textContent.items, pageHeight);

  return {
    size: [pageWidth, pageHeight],
    bbox: pageBbox,
    width: pageWidth,
    height: pageHeight,
    rotation: pageRotation,
    blocks,
  };
}

/**
 * Group pdfjs TextItem[] into block→line→span hierarchy.
 *
 * @param {Array<import('pdfjs-dist').TextItem>} items
 * @param {number} pageHeight
 * @returns {Array<object>}
 */
function groupTextContentToBlocks(items, pageHeight) {
  if (!items || items.length === 0) return [];

  const spans = buildSpansFromItems(items, pageHeight);
  if (spans.length === 0) return [];

  // Sort top→bottom, left→right
  spans.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);

  const lines = groupSpansIntoLines(spans);
  const lineObjects = lines.map(lineSpans => ({
    bbox: mergeBboxes(lineSpans.map(s => s.bbox)),
    spans: lineSpans,
  }));

  return groupLinesIntoBlocks(lineObjects);
}

/**
 * Transform pdfjs text items into span objects with bounding boxes.
 */
function buildSpansFromItems(items, pageHeight) {
  const spans = [];
  let charIdx = 0;

  for (const item of items) {
    if (!item.str || item.str.length === 0) continue;

    const [, , , , tx, ty] = item.transform;
    const x0 = tx;
    const y1 = pageHeight - ty;
    const y0 = y1 - (item.height || 8);
    const x1 = x0 + (item.width || 0);
    const bbox = [x0, y0, x1, y1];
    const chars = buildChars(item.str, bbox, charIdx);
    charIdx += chars.length;

    spans.push({
      bbox,
      content: item.str,
      text: item.str,
      type: 'text',
      score: 1.0,
      chars,
      original_order: null,
    });
  }

  return spans;
}

/**
 * Group spans into lines by y-proximity.
 */
function groupSpansIntoLines(spans) {
  const lines = [];
  let currentLine = [spans[0]];

  for (let i = 1; i < spans.length; i++) {
    const prev = currentLine[currentLine.length - 1];
    const curr = spans[i];
    const yDiff = Math.abs(curr.bbox[1] - prev.bbox[1]);
    if (yDiff <= LINE_TOLERANCE) {
      currentLine.push(curr);
    } else {
      lines.push(currentLine);
      currentLine = [curr];
    }
  }
  lines.push(currentLine);
  return lines;
}

/**
 * Group line objects into blocks by vertical gap.
 */
function groupLinesIntoBlocks(lineObjects) {
  if (lineObjects.length === 0) return [];

  const blocks = [];
  let currentBlock = [lineObjects[0]];

  for (let i = 1; i < lineObjects.length; i++) {
    const prevLine = currentBlock[currentBlock.length - 1];
    const currLine = lineObjects[i];
    const gap = currLine.bbox[1] - prevLine.bbox[3];
    if (gap <= BLOCK_GAP) {
      currentBlock.push(currLine);
    } else {
      blocks.push(currentBlock);
      currentBlock = [currLine];
    }
  }
  blocks.push(currentBlock);

  return blocks.map(blockLines => ({
    bbox: mergeBboxes(blockLines.map(l => l.bbox)),
    lines: blockLines,
  }));
}

/**
 * Build character-level bounding boxes from text and its span bbox.
 */
function buildChars(text, bbox, startIdx) {
  const graphemes = Array.from(String(text || ''));
  if (!graphemes.length) return [];

  const [x0, y0, x1, y1] = bbox;
  const totalWidth = Math.max(0, x1 - x0);
  const fallbackWidth = Math.max(1, (y1 - y0) * 0.5);
  const charWidth = totalWidth > 0 ? totalWidth / graphemes.length : fallbackWidth;

  return graphemes.map((char, i) => {
    const cx0 = x0 + i * charWidth;
    const cx1 = i === graphemes.length - 1 ? x1 : x0 + (i + 1) * charWidth;
    return {
      bbox: [cx0, y0, cx1, y1],
      char,
      text: char,
      char_idx: startIdx + i,
    };
  });
}

/**
 * Merge multiple bboxes into a single bounding box.
 * @param {number[][]} bboxes
 * @returns {number[]}
 */
function mergeBboxes(bboxes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [bx0, by0, bx1, by1] of bboxes) {
    if (bx0 < x0) x0 = bx0;
    if (by0 < y0) y0 = by0;
    if (bx1 > x1) x1 = bx1;
    if (by1 > y1) y1 = by1;
  }
  return [x0, y0, x1, y1];
}
