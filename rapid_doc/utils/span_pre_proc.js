// Copyright (c) Opendatalab. All rights reserved.

import {
  calculateOverlapAreaInBbox1AreaRatio,
  calculateIou,
  getMinboxIfOverlapByRatio,
  mergeAdjacentBboxes,
  isIn,
} from './boxbase.js';
import { BlockType, ContentType } from './enum_class.js';
import { updateDetBoxes } from './ocr_utils.js';
import { getCropNpImg } from './pdf_image_tools.js';
import { getPage } from './pdf_text_tool.js';

// ────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────

const LINE_STOP_FLAG = new Set(['.','!','?','。','！','？',')','）','"','"',':','：',';','；',']','】','}','}','>','》','、',',','，','-','—','–']);
const LINE_START_FLAG = new Set(['(','（','"','"','【','{','《','<','「','『','【','[']);

const SPAN_HEIGHT_RADIO = 0.33;
const CONTRAST_THRESHOLD = 0.17;
const CONTENT_DENSITY_FACTOR = 0.5;
const DISCARD_OVERLAP_RATIO = 0.4;
const SPAN_OVERLAP_RATIO = 0.5;
const IOU_OVERLAP_THRESHOLD = 0.9;

// ────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────

function median(arr) {
  if (!arr || !arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ────────────────────────────────────────────────
// Ligature / Unicode normalization
// ────────────────────────────────────────────────

const LIGATURES = { 'ﬁ':'fi','ﬂ':'fl','ﬀ':'ff','ﬃ':'ffi','ﬄ':'ffl','ﬅ':'ft','ﬆ':'st' };
const LIGATURE_RE = new RegExp(Object.keys(LIGATURES).map(k => k.replace(/./g, c => `\\u${c.codePointAt(0).toString(16).padStart(4,'0')}`)).join('|'), 'g');

function replaceLigatures(text) {
  if (!text) return '';
  return text.replace(LIGATURE_RE, m => LIGATURES[m] ?? m);
}

const UNICODE_MAP = { '\r\n': '', '\u0002': '-' };
const UNICODE_RE = new RegExp(Object.keys(UNICODE_MAP).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');

function replaceUnicode(text) {
  if (!text) return '';
  return text.replace(UNICODE_RE, m => UNICODE_MAP[m] ?? m);
}


// ────────────────────────────────────────────────
// Block bbox helpers
// ────────────────────────────────────────────────

function getBlockBboxes(blocks, typeList) {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter(b => typeList.includes(b[7])).map(b => b.slice(0, 4));
}

function spanOverlapsAny(spanBbox, bboxes, ratio) {
  return bboxes.some(bb => calculateOverlapAreaInBbox1AreaRatio(spanBbox, bb) > ratio);
}

// ────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────

/**
 * Remove spans that are not covered by any layout block.
 * @param {Array<object>} spans
 * @param {Array[]} allBboxes
 * @param {Array[]} allDiscardedBlocks
 * @returns {Array<object>}
 */
export function removeOutsideSpans(spans, allBboxes, allDiscardedBlocks) {
  if (!Array.isArray(spans) || spans.length === 0) return [];
  if (!Array.isArray(allBboxes)) return [];

  const imageBboxes = getBlockBboxes(allBboxes, [BlockType.IMAGE_BODY]);
  const tableBboxes = getBlockBboxes(allBboxes, [BlockType.TABLE_BODY]);
  const otherTypes = Object.values(BlockType).filter(t => typeof t === 'string' && t !== BlockType.IMAGE_BODY && t !== BlockType.TABLE_BODY);
  const otherBboxes = getBlockBboxes(allBboxes, otherTypes);
  const discardedBboxes = getBlockBboxes(allDiscardedBlocks ?? [], [BlockType.DISCARDED]);

  const newSpans = [];
  for (const span of spans) {
    const spanBbox = span.bbox;
    if (!spanBbox) continue;

    if (spanOverlapsAny(spanBbox, discardedBboxes, DISCARD_OVERLAP_RATIO)) {
      newSpans.push(span);
      continue;
    }

    if (span.type === ContentType.IMAGE) {
      if (spanOverlapsAny(spanBbox, imageBboxes, SPAN_OVERLAP_RATIO)) newSpans.push(span);
    } else if (span.type === ContentType.TABLE) {
      if (spanOverlapsAny(spanBbox, tableBboxes, SPAN_OVERLAP_RATIO)) newSpans.push(span);
    } else {
      if (spanOverlapsAny(spanBbox, otherBboxes, SPAN_OVERLAP_RATIO)) newSpans.push(span);
    }
  }
  return newSpans;
}

/**
 * Remove low-confidence spans that heavily overlap higher-confidence spans.
 * @param {Array<object>} spans
 * @returns {[Array<object>, Array<object>]} [spans, droppedSpans]
 */
export function removeOverlapsLowConfidenceSpans(spans) {
  if (!Array.isArray(spans)) return [[], []];

  // FIX OP4: use Set for O(1) membership checks instead of O(N) Array.includes
  const droppedSet = new Set();
  for (let i = 0; i < spans.length; i++) {
    if (droppedSet.has(spans[i])) continue;
    for (let j = i + 1; j < spans.length; j++) {
      if (droppedSet.has(spans[j])) continue;
      if (calculateIou(spans[i].bbox, spans[j].bbox) > IOU_OVERLAP_THRESHOLD) {
        droppedSet.add(spans[i].score < spans[j].score ? spans[i] : spans[j]);
      }
    }
  }
  const droppedSpans = [...droppedSet];
  for (const s of droppedSpans) {
    const idx = spans.indexOf(s);
    if (idx !== -1) spans.splice(idx, 1);
  }
  return [spans, droppedSpans];
}

/**
 * Remove smaller overlapping spans (protects seal labels).
 * @param {Array<object>} spans
 * @returns {[Array<object>, Array<object>]}
 */
export function removeOverlapsMinSpans(spans) {
  if (!Array.isArray(spans)) return [[], []];

  // FIX OP5: use Set for O(1) membership checks instead of O(N) Array.includes
  // getMinboxIfOverlapByRatio returns a reference to one of its input arrays,
  // so === reference comparison is safe (no need for JSON.stringify).
  const droppedSet = new Set();
  for (let i = 0; i < spans.length; i++) {
    if (droppedSet.has(spans[i])) continue;
    for (let j = i + 1; j < spans.length; j++) {
      if (droppedSet.has(spans[j])) continue;

      const overlapBox = getMinboxIfOverlapByRatio(spans[i].bbox, spans[j].bbox, 0.65);
      if (overlapBox === null) continue;

      if (spans[i].original_label === "seal" || spans[j].original_label === "seal") continue;

      // FIX OP5: overlapBox is === spans[i].bbox or spans[j].bbox (reference equality)
      const toRemove = overlapBox === spans[i].bbox ? spans[i] : spans[j];
      if (toRemove.original_label !== "seal") {
        droppedSet.add(toRemove);
      }
    }
  }
  const droppedSpans = [...droppedSet];
  for (const s of droppedSpans) {
    const idx = spans.indexOf(s);
    if (idx !== -1) spans.splice(idx, 1);
  }
  return [spans, droppedSpans];
}


// ────────────────────────────────────────────────
// PDF text span extraction helpers
// ────────────────────────────────────────────────

/**
 * Resolve span bbox from either typed Bbox object or plain array.
 */
function resolveSpanBbox(span) {
  return Array.isArray(span?.bbox?.bbox) ? span.bbox.bbox : span?.bbox;
}

/**
 * Get text content from a span object.
 */
function resolveSpanText(span) {
  return span?.text ?? span?.content ?? '';
}

/**
 * Scale a bbox and transform to OCR coordinate space.
 */
function scaleBboxToOcrCoords(bbox, scale, pasteX, pasteY, xmin, ymin) {
  const s0 = bbox[0] * scale;
  const s1 = bbox[1] * scale;
  const s2 = bbox[2] * scale;
  const s3 = bbox[3] * scale;
  return [
    [s0 + pasteX - xmin, s1 + pasteY - ymin],
    [s2 + pasteX - xmin, s1 + pasteY - ymin],
    [s2 + pasteX - xmin, s3 + pasteY - ymin],
    [s0 + pasteX - xmin, s3 + pasteY - ymin],
  ];
}

/**
 * Extract text bbox from pdf_text spans, matching OCR det format.
 * @param {object} pageDict
 * @param {object} inputRes
 * @param {object|null} mfdRes
 * @param {number} scale
 * @param {number[]} usefulList
 * @returns {number[][][]}
 */
export function txtSpansBboxExtract(pageDict, inputRes, mfdRes, scale, usefulList) {
  if (!pageDict || !inputRes || !usefulList) return [];

  const [pasteX, pasteY, xmin, ymin] = usefulList;
  const poly = inputRes.poly;
  if (!poly) return [];

  const inputResBbox = [poly[0] / scale, poly[1] / scale, poly[4] / scale, poly[5] / scale];

  let pageTextSpan = [];
  for (const block of pageDict.blocks ?? []) {
    for (const line of block.lines ?? []) {
      const rot = line.rotation ?? 0;
      if (rot > 0 && rot < 90) continue;
      for (const span of line.spans ?? []) {
        const bbox = resolveSpanBbox(span);
        const text = resolveSpanText(span);
        if (bbox && calculateTextInSpan(bbox, inputResBbox, text)) {
          pageTextSpan.push({ bbox, text });
        }
      }
    }
  }

  pageTextSpan = mergeAdjacentBboxes(pageTextSpan);
  const pageTextBbox = pageTextSpan.map(item => item.bbox).filter(Boolean);

  const dtBoxes = pageTextBbox.map(bbox =>
    scaleBboxToOcrCoords(bbox, scale, pasteX, pasteY, xmin, ymin)
  );

  const result = mfdRes ? updateDetBoxes(dtBoxes, mfdRes) : dtBoxes;
  if (!result || !result.length) {
    inputRes.need_ocr_det = true;
  }
  return result ?? [];
}

/**
 * Extract the dominant rotation angle of text inside a table region.
 * @param {object} pageDict
 * @param {object} tableResDict
 * @param {number} scale
 * @returns {number}
 */
export function txtMostAngleExtractTable(pageDict, tableResDict, scale) {
  if (!pageDict || !tableResDict?.table_res) return { mostAngle: 0, hasAngles: false };

  const inputRes = tableResDict.table_res;
  const poly = inputRes.poly;
  if (!poly) return { mostAngle: 0, hasAngles: false };

  const inputResBbox = [poly[0] / scale, poly[1] / scale, poly[4] / scale, poly[5] / scale];
  const angles = [];

  for (const block of pageDict.blocks ?? []) {
    for (const line of block.lines ?? []) {
      const rot = line.rotation ?? 0;
      const angleDeg = Math.round(rot * 180 / Math.PI) % 360;
      for (const span of line.spans ?? []) {
        const bbox = resolveSpanBbox(span);
        const text = resolveSpanText(span);
        if (bbox && calculateTextInSpan(bbox, inputResBbox, text)) {
          angles.push(angleDeg);
        }
      }
    }
  }

  // FIX N4: return both mostAngle and hasAngles to match Python's (str, angles) return
  if (!angles.length) return { mostAngle: 0, hasAngles: false };
  const counter = {};
  for (const a of angles) counter[a] = (counter[a] ?? 0) + 1;
  const mostAngle = Number(Object.entries(counter).reduce((a, b) => b[1] > a[1] ? b : a)[0]);
  return { mostAngle, hasAngles: true };
}

/**
 * Check if any text in a page exists within a given image bounding box.
 * @param {object} pageDict
 * @param {number[]} oriImageBbox
 * @returns {boolean}
 */
export function txtInOriImage(pageDict, oriImageBbox) {
  if (!pageDict || !oriImageBbox) return false;

  for (const block of pageDict.blocks ?? []) {
    for (const line of block.lines ?? []) {
      for (const span of line.spans ?? []) {
        const bbox = resolveSpanBbox(span);
        const text = resolveSpanText(span);
        if (bbox && calculateTextInSpan(bbox, oriImageBbox, text)) return true;
      }
    }
  }
  return false;
}


/**
 * Extract images embedded within a table region.
 * @param {object} pageDict
 * @param {object} tableResDict
 * @param {number} scale
 * @param {boolean} tableExtractOriginalImage
 * @returns {Array<object>}
 */
export function extractTableFillImage(pageDict, tableResDict, scale, tableExtractOriginalImage) {
  if (!pageDict || !tableResDict?.table_res) return [];

  const inputRes = tableResDict.table_res;
  const oriImageList = pageDict.ori_image_list ?? [];
  const usefulList = tableResDict.useful_list;
  const layoutImageList = inputRes.layout_image_list ?? [];

  if (!usefulList) return [];

  const [pasteX, pasteY, xmin, ymin] = usefulList;
  const poly = inputRes.poly;
  if (!poly) return [];

  const inputResBbox = [poly[0] / scale, poly[1] / scale, poly[4] / scale, poly[5] / scale];
  let imageRes = [];

  if (tableExtractOriginalImage && oriImageList.length > 0) {
    imageRes = extractFromOriImages(oriImageList, inputResBbox, scale, pasteX, pasteY, xmin, ymin);
  }

  if (!imageRes.length && layoutImageList.length > 0) {
    imageRes = extractFromLayoutImages(layoutImageList, pasteX, pasteY, xmin, ymin);
  }

  if (!pageDict.table_fill_image_list) {
    pageDict.table_fill_image_list = imageRes;
  } else {
    pageDict.table_fill_image_list.push(...imageRes);
  }

  return imageRes;
}

function extractFromOriImages(oriImageList, inputResBbox, scale, pasteX, pasteY, xmin, ymin) {
  const results = [];
  for (const image of oriImageList) {
    const bbox = image.bbox;
    if (!bbox) continue;
    if (isIn(bbox, inputResBbox) && calculateIou(bbox, inputResBbox) < IOU_OVERLAP_THRESHOLD) {
      const scaledBbox = bbox.map(v => v * scale);
      image.ori_bbox = scaledBbox;
      image.ocr_bbox = scaleBboxToOcrCoords(bbox, scale, pasteX, pasteY, xmin, ymin);
      results.push(image);
    }
  }
  return results;
}

function extractFromLayoutImages(layoutImageList, pasteX, pasteY, xmin, ymin) {
  const results = [];
  for (const image of layoutImageList) {
    const poly = image.poly;
    if (!poly) continue;
    const bbox = [poly[0], poly[1], poly[4], poly[5]];
    image.ori_bbox = bbox;
    image.bbox = bbox;
    image.ocr_bbox = [
      [bbox[0] + pasteX - xmin, bbox[1] + pasteY - ymin],
      [bbox[2] + pasteX - xmin, bbox[1] + pasteY - ymin],
      [bbox[2] + pasteX - xmin, bbox[3] + pasteY - ymin],
      [bbox[0] + pasteX - xmin, bbox[3] + pasteY - ymin],
    ];
    results.push(image);
  }
  return results;
}


// ────────────────────────────────────────────────
// txtSpansExtract — main PDF text extraction
// ────────────────────────────────────────────────

/**
 * Extract PDF text characters into spans, filling with char-level content.
 * @param {object|import('pdfjs-dist').PDFPageProxy} pdfPageOrDict
 * @param {Array<object>} spans
 * @param {OffscreenCanvas} inputImg
 * @param {number} scale
 * @param {Array[]} allBboxes
 * @param {Array[]} allDiscardedBlocks
 * @param {boolean} [returnWordBox=false]
 * @param {number[]|null} [usefulList=null]
 * @returns {Promise<Array<object>>}
 */
export async function txtSpansExtract(pdfPageOrDict, spans, inputImg, scale, allBboxes, allDiscardedBlocks, returnWordBox = false, usefulList = null) {
  if (!pdfPageOrDict || !Array.isArray(spans)) return spans ?? [];

  const pageDict = await resolvePageDict(pdfPageOrDict);
  const { pageAllChars, pageAllLines } = collectPageContent(pageDict);

  const spanHeightList = computeSpanHeights(spans);
  if (!spanHeightList.length) return spans;

  const medianSpanHeight = median(spanHeightList);
  const { usefulSpans, unusefulSpans, verticalSpans } = classifySpans(
    spans, allBboxes, allDiscardedBlocks, medianSpanHeight
  );

  fillVerticalSpans(verticalSpans, pageAllLines, spans);

  const newSpans = usefulSpans.concat(unusefulSpans).filter(s => s.type === ContentType.TEXT);
  for (const span of newSpans) span.chars = [];

  const needOcrSpans = fillCharInSpans(newSpans, pageAllChars, medianSpanHeight, returnWordBox, usefulList, scale);

  processNeedOcrSpans(needOcrSpans, spans, inputImg, scale);

  return spans;
}

async function resolvePageDict(pdfPageOrDict) {
  if (pdfPageOrDict && typeof pdfPageOrDict === 'object' && !('getTextContent' in pdfPageOrDict)) {
    return pdfPageOrDict;
  }
  return await getPage(pdfPageOrDict);
}

function collectPageContent(pageDict) {
  const pageAllChars = [];
  const pageAllLines = [];
  for (const block of pageDict.blocks ?? []) {
    for (const line of block.lines ?? []) {
      const rot = line.rotation ?? 0;
      if (rot > 0 && rot < 90) continue;
      pageAllLines.push(line);
      for (const span of line.spans ?? []) {
        for (const char of span.chars ?? []) {
          pageAllChars.push(char);
        }
      }
    }
  }
  return { pageAllChars, pageAllLines };
}

function computeSpanHeights(spans) {
  const heights = [];
  for (const span of spans) {
    if (span.type !== ContentType.TEXT) continue;
    const h = span.bbox[3] - span.bbox[1];
    span.height = h;
    span.width = span.bbox[2] - span.bbox[0];
    heights.push(h);
  }
  return heights;
}

function classifySpans(spans, allBboxes, allDiscardedBlocks, medianSpanHeight) {
  const usefulSpans = [];
  const unusefulSpans = [];
  const verticalSpans = [];
  const allBlocks = [...(allBboxes ?? []), ...(allDiscardedBlocks ?? [])];

  for (const span of spans) {
    if (span.type !== ContentType.TEXT) continue;
    for (const block of allBlocks) {
      if ([BlockType.IMAGE_BODY, BlockType.TABLE_BODY, BlockType.INTERLINE_EQUATION].includes(block[7])) continue;
      if (calculateOverlapAreaInBbox1AreaRatio(span.bbox, block.slice(0, 4)) <= SPAN_OVERLAP_RATIO) continue;

      if (span.height > medianSpanHeight * 3 && span.height > span.width * 3) {
        verticalSpans.push(span);
      } else if (allBboxes.includes(block)) {
        usefulSpans.push(span);
      } else {
        unusefulSpans.push(span);
      }
      break;
    }
  }
  return { usefulSpans, unusefulSpans, verticalSpans };
}

function fillVerticalSpans(verticalSpans, pageAllLines, spans) {
  if (!verticalSpans.length) return;

  for (const pdfiumLine of pageAllLines) {
    for (const span of verticalSpans) {
      const lineBbox = resolveSpanBbox(pdfiumLine);
      if (!lineBbox) continue;
      if (calculateOverlapAreaInBbox1AreaRatio(lineBbox, span.bbox) > SPAN_OVERLAP_RATIO) {
        for (const pdfiumSpan of pdfiumLine.spans ?? []) {
          span.content = (span.content ?? '') + resolveSpanText(pdfiumSpan);
        }
        break;
      }
    }
  }

  for (const span of verticalSpans) {
    if (!span.content || span.content.length === 0) {
      const idx = spans.indexOf(span);
      if (idx !== -1) spans.splice(idx, 1);
    }
  }
}

function processNeedOcrSpans(needOcrSpans, spans, inputImg, scale) {
  if (!needOcrSpans.length) return;

  for (const span of needOcrSpans) {
    const spanCanvas = getCropNpImg(span.bbox, inputImg, scale);
    if (!spanCanvas || spanCanvas.cols === 0 || spanCanvas.rows === 0) {
      removeSpan(spans, span);
      continue;
    }

    const contrast = calculateContrastMat(spanCanvas);
    spanCanvas.delete?.();

    if (contrast <= CONTRAST_THRESHOLD) {
      removeSpan(spans, span);
      continue;
    }

    span.content = '';
    span.score = 1.0;
    span.np_img = null;
  }
}

function removeSpan(spans, span) {
  const idx = spans.indexOf(span);
  if (idx !== -1) spans.splice(idx, 1);
}


// ────────────────────────────────────────────────
// Character-to-span assignment
// ────────────────────────────────────────────────

/**
 * Assign characters to their enclosing spans and build span content.
 * @param {Array<object>} spans
 * @param {Array<object>} allChars
 * @param {number} medianSpanHeight
 * @param {boolean} returnWordBox
 * @param {number[]|null} usefulList
 * @param {number|null} scale
 * @returns {Array<object>} needOcrSpans
 */
export function fillCharInSpans(spans, allChars, medianSpanHeight, returnWordBox = false, usefulList = null, scale = null) {
  if (!Array.isArray(spans) || !spans.length) return [];
  if (!Array.isArray(allChars)) return spans;

  spans.sort((a, b) => a.bbox[1] - b.bbox[1]);

  const gridSize = medianSpanHeight || 1;
  const grid = buildSpatialGrid(spans, gridSize);

  assignCharsToSpans(allChars, spans, grid, gridSize);

  const needOcrSpans = [];
  for (const span of spans) {
    charsToContent(span, returnWordBox, usefulList, scale);
    if ((span.content?.length ?? 0) * (span.height ?? 1) < (span.width ?? 0) * CONTENT_DENSITY_FACTOR) {
      needOcrSpans.push(span);
    }
    delete span.height;
    delete span.width;
  }
  return needOcrSpans;
}

function buildSpatialGrid(spans, gridSize) {
  const grid = {};
  for (let i = 0; i < spans.length; i++) {
    const startCell = Math.floor(spans[i].bbox[1] / gridSize);
    const endCell = Math.floor(spans[i].bbox[3] / gridSize);
    for (let c = startCell; c <= endCell; c++) {
      grid[c] = grid[c] ?? [];
      grid[c].push(i);
    }
  }
  return grid;
}

function assignCharsToSpans(allChars, spans, grid, gridSize) {
  for (const char of allChars) {
    if (!char?.bbox) continue;
    const charCenterY = (char.bbox[1] + char.bbox[3]) / 2;
    const cellIdx = Math.floor(charCenterY / gridSize);
    const candidates = grid[cellIdx] ?? [];
    for (const spanIdx of candidates) {
      if (calculateCharInSpan(char.bbox, spans[spanIdx].bbox, char.char ?? char.text ?? '')) {
        spans[spanIdx].chars = spans[spanIdx].chars ?? [];
        spans[spanIdx].chars.push(char);
        break;
      }
    }
  }
}

/**
 * Determine if a character bbox falls within a span bbox.
 * @param {number[]} charBbox
 * @param {number[]} spanBbox
 * @param {string} char
 * @param {number} [spanHeightRadio=SPAN_HEIGHT_RADIO]
 * @returns {boolean}
 */
export function calculateCharInSpan(charBbox, spanBbox, char, spanHeightRadio = SPAN_HEIGHT_RADIO) {
  if (!charBbox || !spanBbox) return false;

  const charCenterX = (charBbox[0] + charBbox[2]) / 2;
  const charCenterY = (charBbox[1] + charBbox[3]) / 2;
  const spanCenterY = (spanBbox[1] + spanBbox[3]) / 2;
  const spanHeight = spanBbox[3] - spanBbox[1];

  if (isCharInsideSpan(charCenterX, charCenterY, spanBbox, spanCenterY, spanHeight, spanHeightRadio)) {
    return true;
  }

  if (LINE_STOP_FLAG.has(char)) {
    return isStopCharNearSpanEnd(charBbox, charCenterX, charCenterY, spanBbox, spanCenterY, spanHeight, spanHeightRadio);
  }

  if (LINE_START_FLAG.has(char)) {
    return isStartCharNearSpanBegin(charBbox, charCenterX, charCenterY, spanBbox, spanCenterY, spanHeight, spanHeightRadio);
  }

  return false;
}

function isCharInsideSpan(charCenterX, charCenterY, spanBbox, spanCenterY, spanHeight, spanHeightRadio) {
  return spanBbox[0] < charCenterX && charCenterX < spanBbox[2] &&
    spanBbox[1] < charCenterY && charCenterY < spanBbox[3] &&
    Math.abs(charCenterY - spanCenterY) < spanHeight * spanHeightRadio;
}

function isStopCharNearSpanEnd(charBbox, charCenterX, charCenterY, spanBbox, spanCenterY, spanHeight, spanHeightRadio) {
  return (spanBbox[2] - spanHeight) < charBbox[0] && charBbox[0] < spanBbox[2] &&
    charCenterX > spanBbox[0] &&
    spanBbox[1] < charCenterY && charCenterY < spanBbox[3] &&
    Math.abs(charCenterY - spanCenterY) < spanHeight * spanHeightRadio;
}

function isStartCharNearSpanBegin(charBbox, charCenterX, charCenterY, spanBbox, spanCenterY, spanHeight, spanHeightRadio) {
  return spanBbox[0] < charBbox[2] && charBbox[2] < (spanBbox[0] + spanHeight) &&
    charCenterX < spanBbox[2] &&
    spanBbox[1] < charCenterY && charCenterY < spanBbox[3] &&
    Math.abs(charCenterY - spanCenterY) < spanHeight * spanHeightRadio;
}

/**
 * Determine if a text bbox's center falls within a span bbox.
 * @param {number[]} charBbox
 * @param {number[]} spanBbox
 * @param {string} char
 * @returns {boolean}
 */
export function calculateTextInSpan(charBbox, spanBbox, char) {
  if (!charBbox || !spanBbox) return false;

  const charCenterX = (charBbox[0] + charBbox[2]) / 2;
  const charCenterY = (charBbox[1] + charBbox[3]) / 2;
  const spanHeight = spanBbox[3] - spanBbox[1];

  if (spanBbox[0] < charCenterX && charCenterX < spanBbox[2] &&
      spanBbox[1] < charCenterY && charCenterY < spanBbox[3]) {
    return true;
  }

  if (LINE_STOP_FLAG.has(char)) {
    if ((spanBbox[2] - spanHeight) < charBbox[0] && charBbox[0] < spanBbox[2] &&
        charCenterX > spanBbox[0] &&
        spanBbox[1] < charCenterY && charCenterY < spanBbox[3]) {
      return true;
    }
  } else if (LINE_START_FLAG.has(char)) {
    if (spanBbox[0] < charBbox[2] && charBbox[2] < (spanBbox[0] + spanHeight) &&
        charCenterX < spanBbox[2] &&
        spanBbox[1] < charCenterY && charCenterY < spanBbox[3]) {
      return true;
    }
  }

  return false;
}


// ────────────────────────────────────────────────
// Content building
// ────────────────────────────────────────────────

/**
 * Convert char array in span to text content string.
 * @param {object} span
 * @param {boolean} returnWordBox
 * @param {number[]|null} usefulList
 * @param {number|null} scale
 */
export function charsToContent(span, returnWordBox = false, usefulList = null, scale = null) {
  const chars = span?.chars ?? [];
  if (!chars.length) {
    delete span?.chars;
    return;
  }

  chars.sort((a, b) => (a.char_idx ?? 0) - (b.char_idx ?? 0));

  const charWidths = chars.map(c => c.bbox[2] - c.bbox[0]);
  const medianWidth = median(charWidths);

  let content = '';
  const wordResult = [];

  for (let i = 0; i < chars.length; i++) {
    const c1 = chars[i];
    const c2 = i + 1 < chars.length ? chars[i + 1] : null;
    const newChar = buildCharWithSpacing(c1, c2, medianWidth, returnWordBox);
    content += newChar;

    if (returnWordBox && usefulList && scale !== null) {
      const rawBbox = resolveSpanBbox(c1);
      if (rawBbox) {
        wordResult.push([newChar, 1, pdfTxtBboxToTableOcrBbox(rawBbox, usefulList, scale)]);
      }
    }
  }

  content = replaceLigatures(replaceLigatures(replaceUnicode(content)));
  span.content = content.trim();
  if (returnWordBox) span.word_result = wordResult;
  delete span.chars;
}

function buildCharWithSpacing(c1, c2, medianWidth, returnWordBox) {
  if (!returnWordBox && c2 && c2.bbox[0] - c1.bbox[2] > medianWidth * 0.25 &&
      (c1.char ?? '') !== ' ' && (c2.char ?? '') !== ' ') {
    return (c1.char ?? '') + ' ';
  }
  return c1.char ?? '';
}

/**
 * Transform a PDF char bbox to table-relative OCR bbox coordinates.
 * @param {number[]} bbox
 * @param {number[]} usefulList
 * @param {number} scale
 * @returns {number[][]}
 */
export function pdfTxtBboxToTableOcrBbox(bbox, usefulList, scale) {
  if (!bbox || !usefulList) return [];
  return scaleBboxToOcrCoords(bbox, scale, usefulList[0], usefulList[1], usefulList[2], usefulList[3]);
}

// ────────────────────────────────────────────────
// Contrast calculation
// ────────────────────────────────────────────────

/**
 * Compute image contrast from cv.Mat.
 * @param {any} mat  cv.Mat (RGBA from getCropNpImg)
 * @returns {number}
 */
export function calculateContrastMat(mat) {
  if (!mat) return 0;
  // eslint-disable-next-line no-undef
  const gray = new cv.Mat();
  // eslint-disable-next-line no-undef
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  // eslint-disable-next-line no-undef
  const meanMat = new cv.Mat();
  // eslint-disable-next-line no-undef
  const stdMat = new cv.Mat();
  // eslint-disable-next-line no-undef
  cv.meanStdDev(gray, meanMat, stdMat);
  const mean = meanMat.data64F[0];
  const std = stdMat.data64F[0];
  gray.delete();
  meanMat.delete();
  stdMat.delete();
  return Math.round((std / (mean + 1e-6)) * 100) / 100;
}

/**
 * Compute image contrast from OffscreenCanvas.
 * @param {OffscreenCanvas} canvas
 * @param {string} [imgMode='rgb']
 * @returns {number}
 */
export function calculateContrast(canvas, imgMode = 'rgb') {
  if (!canvas) return 0;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  const { width, height } = canvas;
  if (width === 0 || height === 0) return 0;

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const n = data.length / 4;
  if (n === 0) return 0;

  let sum = 0;
  const grayValues = new Float64Array(n);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const gray = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    grayValues[j] = gray;
    sum += gray;
  }

  const mean = sum / n;
  let varianceSum = 0;
  for (let i = 0; i < n; i++) {
    varianceSum += (grayValues[i] - mean) ** 2;
  }
  const std = Math.sqrt(varianceSum / n);
  return Math.round((std / (mean + 1e-6)) * 100) / 100;
}
