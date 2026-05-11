// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: span_pre_proc.py → span_pre_proc.js
 *
 * WORKAROUND: cv2.cvtColor + np.mean/std for contrast calculation
 * REASON: numpy/cv2 not directly available — cv (OpenCV.js) is used
 * SOLUTION: calculateContrast uses cv.cvtColor + cv.meanStdDev
 *
 * WORKAROUND: statistics.median → sort-based median
 * REASON: Python stdlib, no equivalent in JS
 * SOLUTION: Inline median function
 *
 * WORKAROUND: pdftext span.bbox.bbox (Bbox object .bbox property)
 * REASON: pdftext uses typed Bbox objects; JS getPage returns plain arrays
 * SOLUTION: JS getPage returns { bbox: [x0,y0,x1,y1] } directly as array
 *
 * WORKAROUND: collections.defaultdict → plain object with get-or-default
 * REASON: No defaultdict in JS
 * SOLUTION: Plain object + (grid[key] = grid[key] ?? [])
 *
 * WORKAROUND: ProcessPoolExecutor / multiprocessing (in txt_spans_extract OCR path)
 * REASON: Not available in browser
 * SOLUTION: Single-threaded; OCR handled by existing RapidOCR JS port
 */

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
// Utilities
// ────────────────────────────────────────────────

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const LINE_STOP_FLAG = new Set(['.','!','?','。','！','？',')','）','"','"',':','：',';','；',']','】','}','}','>','》','、',',','，','-','—','–']);
const LINE_START_FLAG = new Set(['(','（','"','"','【','{','《','<','「','『','【','[']);

const SPAN_HEIGHT_RADIO = 0.33;

// ────────────────────────────────────────────────
// Ligature / Unicode normalization
// ────────────────────────────────────────────────

const LIGATURES = { 'ﬁ':'fi','ﬂ':'fl','ﬀ':'ff','ﬃ':'ffi','ﬄ':'ffl','ﬅ':'ft','ﬆ':'st' };
const LIGATURE_RE = new RegExp(Object.keys(LIGATURES).map(k => k.replace(/./g, c => `\\u${c.codePointAt(0).toString(16).padStart(4,'0')}`)).join('|'), 'g');

function replaceLigatures(text) {
  return text.replace(LIGATURE_RE, m => LIGATURES[m] ?? m);
}

const UNICODE_MAP = { '\r\n': '', '\u0002': '-' };
const UNICODE_RE = new RegExp(Object.keys(UNICODE_MAP).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');

function replaceUnicode(text) {
  return text.replace(UNICODE_RE, m => UNICODE_MAP[m] ?? m);
}

// ────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────

/**
 * Remove spans that are not covered by any layout block.
 * PORTING NOTE: remove_outside_spans → removeOutsideSpans
 *
 * @param {Array<object>} spans
 * @param {Array[]} allBboxes
 * @param {Array[]} allDiscardedBlocks
 * @returns {Array<object>}
 */
export function removeOutsideSpans(spans, allBboxes, allDiscardedBlocks) {
  const getBlockBboxes = (blocks, typeList) => blocks.filter(b => typeList.includes(b[7])).map(b => b.slice(0,4));

  const imageBboxes = getBlockBboxes(allBboxes, [BlockType.IMAGE_BODY]);
  const tableBboxes = getBlockBboxes(allBboxes, [BlockType.TABLE_BODY]);
  const otherTypes = Object.values(BlockType).filter(t => typeof t === 'string' && t !== BlockType.IMAGE_BODY && t !== BlockType.TABLE_BODY);
  const otherBboxes = getBlockBboxes(allBboxes, otherTypes);
  const discardedBboxes = getBlockBboxes(allDiscardedBlocks, [BlockType.DISCARDED]);

  const newSpans = [];
  for (const span of spans) {
    const spanBbox = span.bbox;
    const spanType = span.type;

    if (discardedBboxes.some(bb => calculateOverlapAreaInBbox1AreaRatio(spanBbox, bb) > 0.4)) {
      newSpans.push(span); continue;
    }
    if (spanType === ContentType.IMAGE) {
      if (imageBboxes.some(bb => calculateOverlapAreaInBbox1AreaRatio(spanBbox, bb) > 0.5)) newSpans.push(span);
    } else if (spanType === ContentType.TABLE) {
      if (tableBboxes.some(bb => calculateOverlapAreaInBbox1AreaRatio(spanBbox, bb) > 0.5)) newSpans.push(span);
    } else {
      if (otherBboxes.some(bb => calculateOverlapAreaInBbox1AreaRatio(spanBbox, bb) > 0.5)) newSpans.push(span);
    }
  }
  return newSpans;
}

/**
 * Remove low-confidence spans that heavily overlap higher-confidence spans.
 * PORTING NOTE: remove_overlaps_low_confidence_spans → removeOverlapsLowConfidenceSpans
 *
 * @param {Array<object>} spans
 * @returns {[Array<object>, Array<object>]} [spans, droppedSpans]
 */
export function removeOverlapsLowConfidenceSpans(spans) {
  const droppedSpans = [];
  for (let i = 0; i < spans.length; i++) {
    for (let j = 0; j < spans.length; j++) {
      if (i === j) continue;
      if (droppedSpans.includes(spans[i]) || droppedSpans.includes(spans[j])) continue;
      if (calculateIou(spans[i].bbox, spans[j].bbox) > 0.9) {
        const toRemove = spans[i].score < spans[j].score ? spans[i] : spans[j];
        if (!droppedSpans.includes(toRemove)) droppedSpans.push(toRemove);
      }
    }
  }
  for (const s of droppedSpans) {
    const idx = spans.indexOf(s);
    if (idx !== -1) spans.splice(idx, 1);
  }
  return [spans, droppedSpans];
}

/**
 * Remove smaller overlapping spans.
 * PORTING NOTE: remove_overlaps_min_spans → removeOverlapsMinSpans
 *
 * @param {Array<object>} spans
 * @returns {[Array<object>, Array<object>]}
 */
export function removeOverlapsMinSpans(spans) {
  const droppedSpans = [];
  for (let i = 0; i < spans.length; i++) {
    for (let j = 0; j < spans.length; j++) {
      if (i === j) continue;
      if (droppedSpans.includes(spans[i]) || droppedSpans.includes(spans[j])) continue;
      
      const overlapBox = getMinboxIfOverlapByRatio(spans[i].bbox, spans[j].bbox, 0.65);
      if (overlapBox !== null) {
        // NEW: Protect seal labels from removal
        if (spans[i].original_label === "seal" || spans[j].original_label === "seal") {
          continue;
        }
        
        const toRemove = spans.find(s => JSON.stringify(s.bbox) === JSON.stringify(overlapBox));
        
        // NEW: Don't remove if the span to remove is a seal
        if (toRemove && !droppedSpans.includes(toRemove) && toRemove.original_label !== "seal") {
          droppedSpans.push(toRemove);
        }
      }
    }
  }
  for (const s of droppedSpans) {
    const idx = spans.indexOf(s);
    if (idx !== -1) spans.splice(idx, 1);
  }
  return [spans, droppedSpans];
}

/**
 * Extract text bbox from pdf_text spans, matching OCR det format.
 * PORTING NOTE: txt_spans_bbox_extract → txtSpansBboxExtract
 *
 * @param {object} pageDict
 * @param {object} inputRes
 * @param {object|null} mfdRes
 * @param {number} scale
 * @param {number[]} usefulList
 * @returns {number[][][]}
 */
export function txtSpansBboxExtract(pageDict, inputRes, mfdRes, scale, usefulList) {
  const [pasteX, pasteY, xmin, ymin] = usefulList;
  const poly = inputRes.poly;
  const inputResBbox = [poly[0]/scale, poly[1]/scale, poly[4]/scale, poly[5]/scale];

  let pageTextSpan = [];
  for (const block of pageDict.blocks ?? []) {
    for (const line of block.lines ?? []) {
      const rot = line.rotation ?? 0;
      if (rot > 0 && rot < 90) continue; // skip rotated lines
      for (const span of line.spans ?? []) {
        const bbox = Array.isArray(span.bbox?.bbox) ? span.bbox.bbox : span.bbox;
        const text = span.text ?? span.content ?? '';
        if (calculateTextInSpan(bbox, inputResBbox, text)) {
          pageTextSpan.push({ bbox, text });
        }
      }
    }
  }

  pageTextSpan = mergeAdjacentBboxes(pageTextSpan);
  const pageTextBbox = pageTextSpan.map(item => item.bbox).filter(Boolean);

  const dtBoxes = pageTextBbox.map(bbox => {
    const scaled = bbox.map((v, i) => v * scale);
    return [
      [scaled[0]+pasteX-xmin, scaled[1]+pasteY-ymin],
      [scaled[2]+pasteX-xmin, scaled[1]+pasteY-ymin],
      [scaled[2]+pasteX-xmin, scaled[3]+pasteY-ymin],
      [scaled[0]+pasteX-xmin, scaled[3]+pasteY-ymin],
    ];
  });

  let result = mfdRes ? updateDetBoxes(dtBoxes, mfdRes) : dtBoxes;
  if (!result || !result.length) {
    inputRes.need_ocr_det = true;
  }
  return result ?? [];
}

/**
 * Extract the dominant rotation angle of text inside a table region.
 * PORTING NOTE: txt_most_angle_extract_table → txtMostAngleExtractTable
 *
 * @param {object} pageDict
 * @param {object} tableResDict
 * @param {number} scale
 * @returns {number}
 */
export function txtMostAngleExtractTable(pageDict, tableResDict, scale) {
  const inputRes = tableResDict.table_res;
  const poly = inputRes.poly;
  const inputResBbox = [poly[0]/scale, poly[1]/scale, poly[4]/scale, poly[5]/scale];
  const angles = [];

  for (const block of pageDict.blocks ?? []) {
    for (const line of block.lines ?? []) {
      const rot = line.rotation ?? 0;
      const angleDeg = Math.round(rot * 180 / Math.PI) % 360;
      for (const span of line.spans ?? []) {
        const bbox = Array.isArray(span.bbox?.bbox) ? span.bbox.bbox : span.bbox;
        const text = span.text ?? span.content ?? '';
        if (calculateTextInSpan(bbox, inputResBbox, text)) {
          angles.push(angleDeg);
        }
      }
    }
  }

  if (!angles.length) return 0;
  const counter = {};
  for (const a of angles) counter[a] = (counter[a] ?? 0) + 1;
  return Number(Object.entries(counter).reduce((a, b) => b[1] > a[1] ? b : a)[0]);
}

/**
 * Check if any text in a page exists within a given image bounding box.
 * PORTING NOTE: txt_in_ori_image → txtInOriImage
 *
 * @param {object} pageDict
 * @param {number[]} oriImageBbox
 * @returns {boolean}
 */
export function txtInOriImage(pageDict, oriImageBbox) {
  for (const block of pageDict.blocks ?? []) {
    for (const line of block.lines ?? []) {
      for (const span of line.spans ?? []) {
        const bbox = Array.isArray(span.bbox?.bbox) ? span.bbox.bbox : span.bbox;
        const text = span.text ?? span.content ?? '';
        if (calculateTextInSpan(bbox, oriImageBbox, text)) return true;
      }
    }
  }
  return false;
}

/**
 * Extract images embedded within a table region.
 * PORTING NOTE: extract_table_fill_image → extractTableFillImage
 *
 * @param {object} pageDict
 * @param {object} tableResDict
 * @param {number} scale
 * @param {boolean} tableExtractOriginalImage
 * @returns {Array<object>}
 */
export function extractTableFillImage(pageDict, tableResDict, scale, tableExtractOriginalImage) {
  const inputRes = tableResDict.table_res;
  const oriImageList = pageDict.ori_image_list ?? [];
  const usefulList = tableResDict.useful_list;
  const layoutImageList = inputRes.layout_image_list ?? [];

  const [pasteX, pasteY, xmin, ymin] = usefulList;
  const poly = inputRes.poly;
  const inputResBbox = [poly[0]/scale, poly[1]/scale, poly[4]/scale, poly[5]/scale];
  let imageRes = [];

  if (tableExtractOriginalImage && oriImageList.length > 0) {
    for (const image of oriImageList) {
      const bbox = image.bbox;
      if (isIn(bbox, inputResBbox) && calculateIou(bbox, inputResBbox) < 0.9) {
        const scaledBbox = bbox.map(v => v * scale);
        image.ori_bbox = scaledBbox;
        image.ocr_bbox = [
          [scaledBbox[0]+pasteX-xmin, scaledBbox[1]+pasteY-ymin],
          [scaledBbox[2]+pasteX-xmin, scaledBbox[1]+pasteY-ymin],
          [scaledBbox[2]+pasteX-xmin, scaledBbox[3]+pasteY-ymin],
          [scaledBbox[0]+pasteX-xmin, scaledBbox[3]+pasteY-ymin],
        ];
        imageRes.push(image);
      }
    }
  }

  if (!imageRes.length && layoutImageList.length > 0) {
    for (const image of layoutImageList) {
      const poly2 = image.poly;
      const bbox = [poly2[0], poly2[1], poly2[4], poly2[5]];
      image.ori_bbox = bbox;
      image.bbox = bbox;
      image.ocr_bbox = [
        [bbox[0]+pasteX-xmin, bbox[1]+pasteY-ymin],
        [bbox[2]+pasteX-xmin, bbox[1]+pasteY-ymin],
        [bbox[2]+pasteX-xmin, bbox[3]+pasteY-ymin],
        [bbox[0]+pasteX-xmin, bbox[3]+pasteY-ymin],
      ];
      imageRes.push(image);
    }
  }

  if (!pageDict.table_fill_image_list) {
    pageDict.table_fill_image_list = imageRes;
  } else {
    pageDict.table_fill_image_list.push(...imageRes);
  }

  return imageRes;
}

/**
 * Extract PDF text characters into spans, filling with char-level content.
 * PORTING NOTE: txt_spans_extract → txtSpansExtract
 *
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
  console.log(`[txtSpansExtract] Called with ${spans.length} spans, ${spans.filter(s => s.type === ContentType.TEXT).length} TEXT spans`);
  
  let pageDict;
  if (pdfPageOrDict && typeof pdfPageOrDict === 'object' && !('getTextContent' in pdfPageOrDict)) {
    pageDict = pdfPageOrDict;
  } else {
    pageDict = await getPage(pdfPageOrDict);
  }

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

  // Compute span heights
  const spanHeightList = [];
  for (const span of spans) {
    if (span.type === ContentType.TEXT) {
      const h = span.bbox[3] - span.bbox[1];
      span.height = h;
      span.width = span.bbox[2] - span.bbox[0];
      spanHeightList.push(h);
    }
  }
  if (!spanHeightList.length) return spans;

  const medianSpanHeight = median(spanHeightList);

  // Classify spans
  const usefulSpans = [], unusefulSpans = [], verticalSpans = [];
  for (const span of spans) {
    if (span.type !== ContentType.TEXT) continue;
    for (const block of [...allBboxes, ...allDiscardedBlocks]) {
      if ([BlockType.IMAGE_BODY, BlockType.TABLE_BODY, BlockType.INTERLINE_EQUATION].includes(block[7])) continue;
      if (calculateOverlapAreaInBbox1AreaRatio(span.bbox, block.slice(0,4)) > 0.5) {
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
  }

  // Fill vertical spans from pdf line content
  if (verticalSpans.length > 0) {
    for (const pdfiumLine of pageAllLines) {
      for (const span of verticalSpans) {
        const lineBbox = Array.isArray(pdfiumLine.bbox?.bbox) ? pdfiumLine.bbox.bbox : pdfiumLine.bbox;
        if (calculateOverlapAreaInBbox1AreaRatio(lineBbox, span.bbox) > 0.5) {
          for (const pdfiumSpan of pdfiumLine.spans ?? []) {
            span.content = (span.content ?? '') + (pdfiumSpan.text ?? pdfiumSpan.content ?? '');
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

  // Fill horizontal spans char by char
  const newSpans = (usefulSpans.concat(unusefulSpans)).filter(s => s.type === ContentType.TEXT);
  for (const span of newSpans) span.chars = [];

  const needOcrSpans = fillCharInSpans(newSpans, pageAllChars, medianSpanHeight, returnWordBox, usefulList, scale);

  // Spans that still need OCR
  if (needOcrSpans.length > 0) {
    for (const span of needOcrSpans) {
      const spanCanvas = getCropNpImg(span.bbox, inputImg, scale);
      if (!spanCanvas || spanCanvas.cols === 0 || spanCanvas.rows === 0) {
        const idx = spans.indexOf(span);
        if (idx !== -1) spans.splice(idx, 1);
        continue;
      }

      // Compute contrast using cv (OpenCV.js)
      // eslint-disable-next-line no-undef
      const contrast = calculateContrastMat(spanCanvas);
      spanCanvas.delete?.();

      if (contrast <= 0.17) {
        const idx = spans.indexOf(span);
        if (idx !== -1) spans.splice(idx, 1);
        continue;
      }

      span.content = '';
      span.score = 1.0;
      span.np_img = null; // populated by OCR caller
    }
  }

  return spans;
}

/**
 * Assign characters to their enclosing spans and build span content.
 * PORTING NOTE: fill_char_in_spans → fillCharInSpans
 *
 * @param {Array<object>} spans
 * @param {Array<object>} allChars
 * @param {number} medianSpanHeight
 * @param {boolean} returnWordBox
 * @param {number[]|null} usefulList
 * @param {number|null} scale
 * @returns {Array<object>} needOcrSpans
 */
export function fillCharInSpans(spans, allChars, medianSpanHeight, returnWordBox = false, usefulList = null, scale = null) {
  spans.sort((a, b) => a.bbox[1] - b.bbox[1]);

  const gridSize = medianSpanHeight;
  const grid = {}; // cell_idx → span indices

  for (let i = 0; i < spans.length; i++) {
    const startCell = Math.floor(spans[i].bbox[1] / gridSize);
    const endCell = Math.floor(spans[i].bbox[3] / gridSize);
    for (let c = startCell; c <= endCell; c++) {
      grid[c] = grid[c] ?? [];
      grid[c].push(i);
    }
  }

  for (const char of allChars) {
    const charCenterY = (char.bbox[1] + char.bbox[3]) / 2;
    const cellIdx = Math.floor(charCenterY / gridSize);
    for (const spanIdx of (grid[cellIdx] ?? [])) {
      if (calculateCharInSpan(char.bbox, spans[spanIdx].bbox, char.char ?? char.text ?? '')) {
        spans[spanIdx].chars = spans[spanIdx].chars ?? [];
        spans[spanIdx].chars.push(char);
        break;
      }
    }
  }

  const needOcrSpans = [];
  for (const span of spans) {
    charsToContent(span, returnWordBox, usefulList, scale);
    if ((span.content?.length ?? 0) * (span.height ?? 1) < (span.width ?? 0) * 0.5) {
      needOcrSpans.push(span);
    }
    delete span.height;
    delete span.width;
  }
  return needOcrSpans;
}

/**
 * Determine if a character bbox falls within a span bbox.
 * PORTING NOTE: calculate_char_in_span → calculateCharInSpan
 *
 * @param {number[]} charBbox
 * @param {number[]} spanBbox
 * @param {string} char
 * @param {number} [spanHeightRadio=SPAN_HEIGHT_RADIO]
 * @returns {boolean}
 */
export function calculateCharInSpan(charBbox, spanBbox, char, spanHeightRadio = SPAN_HEIGHT_RADIO) {
  const charCenterX = (charBbox[0] + charBbox[2]) / 2;
  const charCenterY = (charBbox[1] + charBbox[3]) / 2;
  const spanCenterY = (spanBbox[1] + spanBbox[3]) / 2;
  const spanHeight = spanBbox[3] - spanBbox[1];

  if (spanBbox[0] < charCenterX && charCenterX < spanBbox[2] &&
      spanBbox[1] < charCenterY && charCenterY < spanBbox[3] &&
      Math.abs(charCenterY - spanCenterY) < spanHeight * spanHeightRadio) {
    return true;
  }

  if (LINE_STOP_FLAG.has(char)) {
    if ((spanBbox[2] - spanHeight) < charBbox[0] && charBbox[0] < spanBbox[2] &&
        charCenterX > spanBbox[0] &&
        spanBbox[1] < charCenterY && charCenterY < spanBbox[3] &&
        Math.abs(charCenterY - spanCenterY) < spanHeight * spanHeightRadio) {
      return true;
    }
  } else if (LINE_START_FLAG.has(char)) {
    if (spanBbox[0] < charBbox[2] && charBbox[2] < (spanBbox[0] + spanHeight) &&
        charCenterX < spanBbox[2] &&
        spanBbox[1] < charCenterY && charCenterY < spanBbox[3] &&
        Math.abs(charCenterY - spanCenterY) < spanHeight * spanHeightRadio) {
      return true;
    }
  }

  return false;
}

/**
 * Determine if a text bbox's center falls within a span bbox.
 * PORTING NOTE: calculate_text_in_span → calculateTextInSpan
 *
 * @param {number[]} charBbox
 * @param {number[]} spanBbox
 * @param {string} char
 * @returns {boolean}
 */
export function calculateTextInSpan(charBbox, spanBbox, char) {
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

/**
 * Convert char array in span to text content string.
 * PORTING NOTE: chars_to_content → charsToContent
 *
 * @param {object} span
 * @param {boolean} returnWordBox
 * @param {number[]|null} usefulList
 * @param {number|null} scale
 */
export function charsToContent(span, returnWordBox = false, usefulList = null, scale = null) {
  const chars = span.chars ?? [];
  if (chars.length > 0) {
    chars.sort((a, b) => (a.char_idx ?? 0) - (b.char_idx ?? 0));

    const charWidths = chars.map(c => c.bbox[2] - c.bbox[0]);
    const medianWidth = median(charWidths);

    let content = '';
    const wordResult = [];

    for (let i = 0; i < chars.length; i++) {
      const c1 = chars[i];
      const c2 = i + 1 < chars.length ? chars[i + 1] : null;
      let newChar;
      if (!returnWordBox && c2 && c2.bbox[0] - c1.bbox[2] > medianWidth * 0.25 &&
          (c1.char ?? '') !== ' ' && (c2.char ?? '') !== ' ') {
        newChar = (c1.char ?? '') + ' ';
      } else {
        newChar = c1.char ?? '';
      }
      content += newChar;

      if (returnWordBox && usefulList && scale !== null) {
        const rawBbox = Array.isArray(c1.bbox?.bbox) ? c1.bbox.bbox : c1.bbox;
        wordResult.push([newChar, 1, pdfTxtBboxToTableOcrBbox(rawBbox, usefulList, scale)]);
      }
    }

    content = replaceLigatures(replaceLigatures(replaceUnicode(content)));
    span.content = content.trim();
    if (returnWordBox) span.word_result = wordResult;
  }
  delete span.chars;
}

/**
 * Transform a PDF char bbox to table-relative OCR bbox coordinates.
 * PORTING NOTE: pdf_txt_bbox_to_table_ocr_bbox → pdfTxtBboxToTableOcrBbox
 *
 * @param {number[]} bbox
 * @param {number[]} usefulList
 * @param {number} scale
 * @returns {number[][]}
 */
export function pdfTxtBboxToTableOcrBbox(bbox, usefulList, scale) {
  const [pasteX, pasteY, xmin, ymin] = usefulList;
  const s = bbox.map((v, i) => v * scale);
  return [
    [s[0]+pasteX-xmin, s[1]+pasteY-ymin],
    [s[2]+pasteX-xmin, s[1]+pasteY-ymin],
    [s[2]+pasteX-xmin, s[3]+pasteY-ymin],
    [s[0]+pasteX-xmin, s[3]+pasteY-ymin],
  ];
}

/**
 * Compute image contrast from cv.Mat.
 * PORTING NOTE: calculate_contrast(img, img_mode) → calculateContrastMat(mat)
 *
 * @param {any} mat  cv.Mat (RGBA from getCropNpImg)
 * @returns {number}
 */
export function calculateContrastMat(mat) {
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
  gray.delete(); meanMat.delete(); stdMat.delete();
  return Math.round((std / (mean + 1e-6)) * 100) / 100;
}

/**
 * Compute image contrast from OffscreenCanvas.
 * PORTING NOTE: calculate_contrast(img, img_mode) → calculateContrast(canvas, imgMode)
 *
 * @param {OffscreenCanvas} canvas
 * @param {string} [imgMode='rgb']
 * @returns {number}
 */
export function calculateContrast(canvas, imgMode = 'rgb') {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  // Convert to grayscale
  const grayValues = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    // Standard luminance formula
    grayValues.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  const n = grayValues.length;
  const mean = grayValues.reduce((s, v) => s + v, 0) / n;
  const variance = grayValues.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  return Math.round((std / (mean + 1e-6)) * 100) / 100;
}
