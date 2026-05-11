// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: pdf_text_tool.py → pdf_text_tool.js
 *
 * WORKAROUND: pdftext library (get_chars, get_spans, get_lines, get_blocks, etc.)
 * REASON: pdftext is a Python-only library using pypdfium2 internally
 * SOLUTION: Use pdfjs-dist getTextContent() to extract text spans and reconstruct
 *   the same page dict structure expected by downstream pipeline.
 *
 * WORKAROUND: PyPDFium2Parser.lock (threading.Lock)
 * REASON: No threading in browser
 * SOLUTION: Single-threaded; lock is a no-op (already stubbed in PyPDFium2Parser.js).
 */

/**
 * Extract text page data from a pdfjs PDFPageProxy.
 * PORTING NOTE: get_page(page, ...) → getPage(page, opts)
 *
 * Returns a dict matching the Python `page` structure:
 *   { size, bbox, width, height, rotation, blocks }
 *
 * PORTING NOTE: pdftext get_chars/get_spans/get_lines/get_blocks pipeline
 *   → pdfjs getTextContent() + manual span/line/block grouping
 *
 * NOTE: The `blocks` structure is simplified compared to pdftext output.
 *   Each block contains { bbox, lines: [{ bbox, spans: [{ bbox, content, ... }] }] }.
 *
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @param {object} [opts]
 * @param {boolean}   [opts.quoteLoosebox=true]     - unused (pdftext specific)
 * @param {number}    [opts.superscriptHeightThreshold=0.7] - unused
 * @param {number}    [opts.lineDistanceThreshold=0.1]      - unused
 * @returns {Promise<object>}
 */
export async function getPage(page, {
  quoteLoosebox = true,
  superscriptHeightThreshold = 0.7,
  lineDistanceThreshold = 0.1,
} = {}) {
  const viewport = page.getViewport({ scale: 1 });
  const pageWidth = Math.ceil(viewport.width);
  const pageHeight = Math.ceil(viewport.height);

  // pdfjs viewport bbox: [x0, y0, x1, y1] in user space (origin bottom-left in pdf spec, top-left in pdfjs)
  const pageBbox = [0, 0, pageWidth, pageHeight];
  const pageRotation = page.rotate ?? 0;

  // Extract text content
  const textContent = await page.getTextContent();

  // Group items into lines by approximate y coordinate, then into blocks
  const blocks = groupTextContentToBlocks(textContent.items, viewport, pageHeight);

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
 * PORTING NOTE: replaces pdftext get_spans / get_lines / get_blocks
 *
 * @param {Array<import('pdfjs-dist').TextItem>} items
 * @param {import('pdfjs-dist').PageViewport} viewport
 * @param {number} pageHeight
 * @returns {Array<object>}
 */
function groupTextContentToBlocks(items, viewport, pageHeight) {
  if (!items || items.length === 0) return [];

  // Transform each item's transform matrix to [x0, y0, x1, y1] bounding box
  const spans = [];
  let charIdx = 0;
  for (const item of items) {
    if (!item.str || item.str.length === 0) continue;

    const [, , , , tx, ty] = item.transform;
    // flip y: pdfjs y increases downward from top
    const x0 = tx;
    const y1 = pageHeight - ty;           // bottom of text in top-left coords
    const y0 = y1 - (item.height || 8);   // top of text
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

  if (spans.length === 0) return [];

  // Sort top→bottom, left→right
  spans.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);

  // Group into lines by y proximity
  const LINE_TOLERANCE = 4; // px
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

  // Compute line bbox and group into blocks by vertical proximity
  const BLOCK_GAP = 16; // px gap > BLOCK_GAP → new block
  const lineObjects = lines.map(lineSpans => ({
    bbox: mergeBboxes(lineSpans.map(s => s.bbox)),
    spans: lineSpans,
  }));

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
