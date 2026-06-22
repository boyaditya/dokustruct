// Copyright (c) Opendatalab. All rights reserved.

import { BlockType, ContentType } from './enum_class.js';
import { bboxToPoints } from './ocr_utils.js';
import { intTrunc } from './math_utils.js';

/**
 * Default reading order providers — set by the pipeline layer via `configureReadingOrder`.
 * This avoids utils/ importing directly from model/.
 * @type {{ getLayoutParsingRes: Function|null, xycutPlusSort: Function|null, blocktype_to_sort_label: object|null }}
 */
const _readingOrderProviders = {
  getLayoutParsingRes: null,
  xycutPlusSort: null,
  blocktype_to_sort_label: null,
};

/**
 * Configure reading order providers. Must be called before sortBlocksByBbox.
 * Typically called once during pipeline initialization.
 *
 * @param {{ getLayoutParsingRes?: Function, xycutPlusSort?: Function, blocktype_to_sort_label?: object }} providers
 */
export function configureReadingOrder(providers) {
  if (providers.getLayoutParsingRes) _readingOrderProviders.getLayoutParsingRes = providers.getLayoutParsingRes;
  if (providers.xycutPlusSort) _readingOrderProviders.xycutPlusSort = providers.xycutPlusSort;
  if (providers.blocktype_to_sort_label) _readingOrderProviders.blocktype_to_sort_label = providers.blocktype_to_sort_label;
}

/**
 * Compute the median of an array of numbers.
 * @param {number[]} arr
 * @returns {number}
 */
function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function deepCopy(obj) {
  return structuredClone(obj);
}

/**
 * Compare two arrays element-by-element for value equality.
 * Used for bbox arrays (e.g. [x0, y0, x1, y1]) where reference equality fails
 * when arrays are re-created from the same numeric values.
 * FIX 8.10: replaces `===` reference check in xycut-plus fallback.
 *
 * @param {Array} a
 * @param {Array} b
 * @returns {boolean}
 */
function deepEqualArray(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Find the first index in `arr` where `deepEqualArray(arr[i], target)` is true.
 * Returns -1 if not found.
 * FIX 8.10: value-equality replacement for `arr.findIndex(b => b === target)`.
 *
 * @param {Array[]} arr   Array of bbox arrays
 * @param {Array}   target  Bbox array to find
 * @returns {number}
 */
function findIndexByValue(arr, target) {
  for (let i = 0; i < arr.length; i++) {
    if (deepEqualArray(arr[i], target)) return i;
  }
  return -1;
}

/**
 * Sort blocks within a page using line-height analysis and xycut-plus layout ordering.
 *
 * @param {Array<object>} blocks
 * @param {number} pageW
 * @param {number} pageH
 * @param {Array} footnoteBlocks
 * @param {ImageBitmap|null} pagePilImg
 * @returns {Promise<Array<object>>}
 */
export async function sortBlocksByBbox(blocks, pageW, pageH, footnoteBlocks, pagePilImg) {
  if (!blocks || blocks.length === 0) return [];

  const lineHeight = getLineHeight(blocks);
  addLinesToBlocks(blocks, pageW, pageH, lineHeight, footnoteBlocks);
  const sorted = await sortBlocksByXycutPlus(blocks, pagePilImg);
  const reverted = revertGroupBlocks(sorted);
  const sortedBlocks = [...reverted].sort((a, b) => a.index - b.index);
  for (const block of sortedBlocks) {
    if (block.type === BlockType.IMAGE || block.type === BlockType.TABLE) {
      block.blocks = [...block.blocks].sort((a, b) => a.index - b.index);
    }
  }

  // Correction pass: fix adjacent (TABLE, TITLE) pairs where the TITLE is
  // spatially above the TABLE but was sorted after it. This can happen when
  // xycut-plus-v3 places a wide table block before a narrow heading that sits
  // just above it. A single bubble-sort pass is sufficient for the common case.
  for (let i = 0; i < sortedBlocks.length - 1; i++) {
    const cur = sortedBlocks[i];
    const nxt = sortedBlocks[i + 1];
    if (
      cur.type === BlockType.TABLE &&
      nxt.type === BlockType.TITLE &&
      Array.isArray(nxt.bbox) && Array.isArray(cur.bbox) &&
      nxt.bbox[1] < cur.bbox[1]  // TITLE y0 < TABLE y0 → TITLE is above TABLE
    ) {
      sortedBlocks[i] = nxt;
      sortedBlocks[i + 1] = cur;
    }
  }

  return sortedBlocks;
}

/**
 * Compute median line height from text-type blocks.
 *
 * @param {Array<object>} blocks
 * @returns {number}
 */
export function getLineHeight(blocks) {
  if (!blocks || blocks.length === 0) return 10;

  const heights = [];
  const textTypes = new Set([
    BlockType.TEXT, BlockType.TITLE,
    BlockType.IMAGE_CAPTION, BlockType.IMAGE_FOOTNOTE,
    BlockType.TABLE_CAPTION, BlockType.TABLE_FOOTNOTE,
  ]);
  for (const block of blocks) {
    if (textTypes.has(block.type)) {
      for (const line of block.lines ?? []) {
        const [, y0, , y1] = line.bbox;
        heights.push(intTrunc(y1 - y0));
      }
    }
  }
  return heights.length > 0 ? median(heights) : 10;
}

/**
 * Add virtual lines to blocks based on computed line_height.
 *
 * @param {Array<object>} fixBlocks
 * @param {number} pageW
 * @param {number} pageH
 * @param {number} lineHeight
 * @param {Array} footnoteBlocks
 */
export function addLinesToBlocks(fixBlocks, pageW, pageH, lineHeight, footnoteBlocks) {
  if (!fixBlocks) return;

  const textTypes = new Set([
    BlockType.TEXT, BlockType.TITLE,
    BlockType.IMAGE_CAPTION, BlockType.IMAGE_FOOTNOTE,
    BlockType.TABLE_CAPTION, BlockType.TABLE_FOOTNOTE,
  ]);

  function addLinesToBlock(b) {
    const lineBboxes = insertLinesIntoBlock(b.bbox, lineHeight, pageW, pageH);
    b.lines = lineBboxes.map(lineBbox => ({ bbox: lineBbox, spans: [] }));
  }

  for (const block of fixBlocks) {
    if (textTypes.has(block.type)) {
      if (block.lines.length === 0) {
        addLinesToBlock(block);
      } else if (block.type === BlockType.TITLE && block.lines.length === 1 &&
          (block.bbox[3] - block.bbox[1]) > lineHeight * 2) {
        block.real_lines = deepCopy(block.lines);
        addLinesToBlock(block);
      }
    } else if (block.type === BlockType.IMAGE_BODY || block.type === BlockType.TABLE_BODY ||
        block.type === BlockType.INTERLINE_EQUATION) {
      block.real_lines = deepCopy(block.lines);
      addLinesToBlock(block);
    }
  }

  if (Array.isArray(footnoteBlocks)) {
    for (const block of footnoteBlocks) {
      const footnoteBlock = { bbox: block.slice(0, 4), lines: [] };
      addLinesToBlock(footnoteBlock);
    }
  }
}

/**
 * Divide a block bbox into multiple horizontal line bboxes.
 *
 * @param {number[]} blockBbox [x0, y0, x1, y1]
 * @param {number} lineHeight
 * @param {number} pageW
 * @param {number} pageH
 * @returns {number[][]}
 */
export function insertLinesIntoBlock(blockBbox, lineHeight, pageW, pageH) {
  if (!blockBbox || blockBbox.length < 4) return [];

  const [x0, y0, x1, y1] = blockBbox;
  const blockHeight = y1 - y0;
  const blockWidth = x1 - x0;

  if (lineHeight * 2 < blockHeight) {
    let lines;
    if (blockHeight > pageH * 0.25 && blockWidth < pageW * 0.5 && blockWidth > pageW * 0.25) {
      lines = Math.floor(blockHeight / lineHeight);
    } else if (blockWidth > pageW * 0.4) {
      lines = 3;
    } else if (blockWidth > pageW * 0.25) {
      lines = Math.floor(blockHeight / lineHeight);
    } else {
      if (blockHeight / blockWidth > 1.2) return [[x0, y0, x1, y1]];
      lines = 2;
    }

    const sliceH = (y1 - y0) / lines;
    const result = [];
    let currentY = y0;
    for (let i = 0; i < lines; i++) {
      result.push([x0, currentY, x1, currentY + sliceH]);
      currentY += sliceH;
    }
    return result;
  }

  return [[x0, y0, x1, y1]];
}

/**
 * Compute the original_order for a block (from block.original_order or min span order).
 *
 * @param {object} block
 * @returns {number}
 */
export function extractBlockOriginalOrder(block) {
  if (!block) return -1;

  const order = block.original_order;
  if (order != null && order >= 0) return order;

  const orders = [];
  for (const line of block.lines ?? []) {
    for (const span of line.spans ?? []) {
      const o = span.original_order;
      if (o != null && o >= 0) orders.push(o);
    }
  }
  return orders.length > 0 ? Math.min(...orders) : -1;
}

/**
 * Sort blocks using xycut-plus-v3 layout parsing, falling back to xycut-plus.
 *
 * @param {Array<object>} fixBlocks
 * @param {ImageBitmap|null} pagePilImg
 * @returns {Promise<Array<object>>}
 */
export async function sortBlocksByXycutPlus(fixBlocks, pagePilImg) {
  if (!fixBlocks || fixBlocks.length === 0) return [];

  // Restore real_lines for image/table/title/equation blocks
  for (const block of fixBlocks) {
    block.bbox = block.bbox.map(v => Math.max(0, v));
    if ([BlockType.IMAGE_BODY, BlockType.TABLE_BODY, BlockType.TITLE, BlockType.INTERLINE_EQUATION]
        .includes(block.type)) {
      if ('real_lines' in block) {
        block.virtual_lines = deepCopy(block.lines);
        block.lines = deepCopy(block.real_lines);
        delete block.real_lines;
      }
    }
  }

  // Check for pre-computed original_order
  try {
    const blockOrders = fixBlocks.map(extractBlockOriginalOrder);
    const hasOriginalOrder = blockOrders.some(o => o >= 0);
    if (hasOriginalOrder) {
      for (let i = 0; i < fixBlocks.length; i++) {
        fixBlocks[i].index = blockOrders[i] >= 0 ? blockOrders[i] : fixBlocks.length;
      }
      const sortedBlocks = [...fixBlocks].sort((a, b) => a.index - b.index);
      let lineIndex = 1;
      for (const block of sortedBlocks) {
        for (const line of block.lines ?? []) {
          line.index = lineIndex++;
        }
      }
      return fixBlocks;
    }
  } catch (e) {
    console.warn('[sortBlocksByXycutPlus] original_order check failed:', e?.message ?? e);
  }

  // Build OCR result arrays
  const blockBboxes = [];
  const layoutDetRes = [];
  const recLabels = [], recTexts = [], recBoxes = [], recPolys = [], recScores = [], dtPolys = [];

  for (const block of fixBlocks) {
    blockBboxes.push(block.bbox);
    const labelCounter = {};
    for (const line of block.lines ?? []) {
      for (const span of line.spans ?? []) {
        if (span.type === ContentType.TEXT) {
          recScores.push(span.score);
          recBoxes.push(new Float32Array(span.bbox));
          recLabels.push(span.type);
          recTexts.push(span.content);
          const points = bboxToPoints(span.bbox);
          dtPolys.push(points);
          recPolys.push(points);
        }
        if (span.original_label) {
          labelCounter[span.original_label] = (labelCounter[span.original_label] ?? 0) + 1;
        }
      }
    }
    let mostCommonLabel;
    if (Object.keys(labelCounter).length > 0) {
      mostCommonLabel = Object.entries(labelCounter).reduce((a, b) => b[1] > a[1] ? b : a)[0];
    } else {
      mostCommonLabel = _readingOrderProviders.blocktype_to_sort_label?.[block.type] ?? 'unknown';
    }
    layoutDetRes.push({ coordinate: block.bbox, label: mostCommonLabel, score: 1.0 });
  }

  try {
    if (!_readingOrderProviders.getLayoutParsingRes) {
      throw new Error('Reading order providers not configured');
    }
    const layoutDetResObj = { boxes: layoutDetRes };
    const regionDetRes = { boxes: [] };
    const overallOcrRes = {
      rec_labels: recLabels,
      rec_texts: recTexts,
      rec_boxes: recBoxes,
      rec_polys: recPolys,
      rec_scores: recScores,
      dt_polys: dtPolys,
    };

    const parsingResList = await _readingOrderProviders.getLayoutParsingRes(
      pagePilImg,
      regionDetRes,
      layoutDetResObj,
      overallOcrRes,
    );

    const indexToOrder = {};
    for (let order = 0; order < parsingResList.length; order++) {
      indexToOrder[parsingResList[order].index] = order;
    }
    for (let i = 0; i < fixBlocks.length; i++) {
      fixBlocks[i].index = indexToOrder[i] ?? fixBlocks.length;
    }
  } catch (e) {
    console.warn('[sortBlocksByXycutPlus] layout parsing failed, falling back to xycut-plus:', e?.message ?? e);
    try {
      if (!_readingOrderProviders.xycutPlusSort) {
        throw new Error('xycutPlusSort provider not configured');
      }
      const sortedIndices = _readingOrderProviders.xycutPlusSort(blockBboxes);
      const sortedBoxes = sortedIndices.map(i => blockBboxes[i]);
      for (let i = 0; i < fixBlocks.length; i++) {
        fixBlocks[i].index = findIndexByValue(sortedBoxes, blockBboxes[i]);
      }
    } catch (e2) {
      console.warn('[sortBlocksByXycutPlus] xycut-plus fallback failed:', e2?.message ?? e2);
      for (let i = 0; i < fixBlocks.length; i++) {
        fixBlocks[i].index = i;
      }
    }
  }

  // Assign line indices
  const sortedForLines = [...fixBlocks].sort((a, b) => a.index - b.index);
  let lineIdx = 1;
  for (const block of sortedForLines) {
    for (const line of block.lines ?? []) {
      line.index = lineIdx++;
    }
  }

  return fixBlocks;
}

/**
 * Group IMAGE_BODY/TABLE_BODY blocks back into IMAGE/TABLE group objects.
 *
 * @param {Array<object>} blocks
 * @returns {Array<object>}
 */
export function revertGroupBlocks(blocks) {
  if (!blocks || blocks.length === 0) return [];

  const imageGroups = {};
  const tableGroups = {};
  const newBlocks = [];

  for (const block of blocks) {
    if ([BlockType.IMAGE_BODY, BlockType.IMAGE_CAPTION, BlockType.IMAGE_FOOTNOTE].includes(block.type)) {
      const gid = block.group_id;
      imageGroups[gid] = imageGroups[gid] ?? [];
      imageGroups[gid].push(block);
    } else if ([BlockType.TABLE_BODY, BlockType.TABLE_CAPTION, BlockType.TABLE_FOOTNOTE].includes(block.type)) {
      const gid = block.group_id;
      tableGroups[gid] = tableGroups[gid] ?? [];
      tableGroups[gid].push(block);
    } else {
      newBlocks.push(block);
    }
  }

  for (const groupBlocks of Object.values(imageGroups)) {
    newBlocks.push(processBlockList(groupBlocks, BlockType.IMAGE_BODY, BlockType.IMAGE));
  }
  for (const groupBlocks of Object.values(tableGroups)) {
    newBlocks.push(processBlockList(groupBlocks, BlockType.TABLE_BODY, BlockType.TABLE));
  }

  return newBlocks;
}

/**
 * Combine a group of sub-blocks into a single parent block.
 *
 * @param {Array<object>} blocks
 * @param {*} bodyType
 * @param {*} blockType
 * @returns {object}
 */
export function processBlockList(blocks, bodyType, blockType) {
  const indices = blocks.map(b => b.index);
  const medianIndex = median(indices);

  const bodyBlock = blocks.find(b => b.type === bodyType) ?? null;
  const bodyBbox = bodyBlock ? bodyBlock.bbox : [];
  const polygonPoints = bodyBlock?.polygon_points ?? null;

  const result = { type: blockType, bbox: bodyBbox, blocks, index: medianIndex };
  if (polygonPoints) result.polygon_points = polygonPoints;
  return result;
}
