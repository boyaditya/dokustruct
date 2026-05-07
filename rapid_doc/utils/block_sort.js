// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: block_sort.py → block_sort.js
 *
 * WORKAROUND: statistics.median() (Python stdlib)
 * REASON: No equivalent in JS stdlib
 * SOLUTION: Inline sort-based median function.
 *
 * WORKAROUND: numpy.array() for OCR box aggregation
 * REASON: numpy not available in browser
 * SOLUTION: Plain JS arrays; Float32Array where typed buffer needed.
 *
 * WORKAROUND: copy.deepcopy()
 * REASON: No stdlib deepcopy in JS
 * SOLUTION: JSON.parse(JSON.stringify(...)) for plain data objects.
 *
 * WORKAROUND: logger.exception(e) (loguru)
 * REASON: loguru not in browser
 * SOLUTION: console.error(e)
 */

import { BlockType, ContentType } from './enum_class.js';
import { bboxToPoints } from './ocr_utils.js';
import { getLayoutParsingRes } from '../model/reading_order/layout_parsing/xycut_plus_v3.js';
import { xycutPlusSort } from '../model/reading_order/xycut_plus.js';
import { blocktype_to_sort_label } from '../model/reading_order/layout_parsing/setting.js';

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

/**
 * Deep clone a plain data object via JSON round-trip.
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Sort blocks within a page using line-height analysis and xycut-plus layout ordering.
 * PORTING NOTE: sort_blocks_by_bbox(...) → sortBlocksByBbox(...)
 *
 * @param {Array<object>} blocks
 * @param {number} pageW
 * @param {number} pageH
 * @param {Array} footnoteBlocks
 * @param {ImageBitmap|null} pagePilImg
 * @returns {Array<object>}
 */
export async function sortBlocksByBbox(blocks, pageW, pageH, footnoteBlocks, pagePilImg) {
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
  return sortedBlocks;
}

/**
 * Compute median line height from text-type blocks.
 * PORTING NOTE: get_line_height → getLineHeight
 *
 * @param {Array<object>} blocks
 * @returns {number}
 */
export function getLineHeight(blocks) {
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
        heights.push(Math.round(y1 - y0));
      }
    }
  }
  return heights.length > 0 ? median(heights) : 10;
}

/**
 * Add virtual lines to blocks based on computed line_height.
 * PORTING NOTE: add_lines_to_blocks → addLinesToBlocks
 *
 * @param {Array<object>} fixBlocks
 * @param {number} pageW
 * @param {number} pageH
 * @param {number} lineHeight
 * @param {Array} footnoteBlocks
 */
export function addLinesToBlocks(fixBlocks, pageW, pageH, lineHeight, footnoteBlocks) {
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
      } else {
        // Keep existing lines — no-op
      }
    } else if (block.type === BlockType.IMAGE_BODY || block.type === BlockType.TABLE_BODY ||
        block.type === BlockType.INTERLINE_EQUATION) {
      block.real_lines = deepCopy(block.lines);
      addLinesToBlock(block);
    }
  }

  for (const block of footnoteBlocks) {
    const footnoteBlock = { bbox: block.slice(0, 4), lines: [] };
    addLinesToBlock(footnoteBlock);
  }
}

/**
 * Divide a block bbox into multiple horizontal line bboxes.
 * PORTING NOTE: insert_lines_into_block → insertLinesIntoBlock
 *
 * @param {number[]} blockBbox [x0, y0, x1, y1]
 * @param {number} lineHeight
 * @param {number} pageW
 * @param {number} pageH
 * @returns {number[][]}
 */
export function insertLinesIntoBlock(blockBbox, lineHeight, pageW, pageH) {
  const [x0, y0, x1, y1] = blockBbox;
  const blockHeight = y1 - y0;
  const blockWeight = x1 - x0;

  if (lineHeight * 2 < blockHeight) {
    let lines;
    if (blockHeight > pageH * 0.25 && blockWeight < pageW * 0.5 && blockWeight > pageW * 0.25) {
      lines = Math.floor(blockHeight / lineHeight);
    } else if (blockWeight > pageW * 0.4) {
      lines = 3;
    } else if (blockWeight > pageW * 0.25) {
      lines = Math.floor(blockHeight / lineHeight);
    } else {
      if (blockHeight / blockWeight > 1.2) return [[x0, y0, x1, y1]];
      else lines = 2;
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
 * PORTING NOTE: extract_block_original_order → extractBlockOriginalOrder
 *
 * @param {object} block
 * @returns {number}
 */
export function extractBlockOriginalOrder(block) {
  const order = block.original_order;
  if (order !== undefined && order !== null && order >= 0) return order;
  const orders = [];
  for (const line of block.lines ?? []) {
    for (const span of line.spans ?? []) {
      const o = span.original_order;
      if (o !== undefined && o !== null && o >= 0) orders.push(o);
    }
  }
  return orders.length > 0 ? Math.min(...orders) : -1;
}

/**
 * Sort blocks using xycut-plus-v3 layout parsing, falling back to xycut-plus.
 * PORTING NOTE: sort_blocks_by_xycut_plus → sortBlocksByXycutPlus
 *
 * @param {Array<object>} fixBlocks
 * @param {ImageBitmap|null} pagePilImg
 * @returns {Promise<Array<object>>}
 */
export async function sortBlocksByXycutPlus(fixBlocks, pagePilImg) {
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
    console.error(e);
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
      mostCommonLabel = blocktype_to_sort_label?.[block.type] ?? 'unknown';
    }
    layoutDetRes.push({ coordinate: block.bbox, label: mostCommonLabel, score: 1.0 });
  }

  try {
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

    // pagePilImg can be an HTMLImageElement/ImageBitmap or null
    const parsingResList = await getLayoutParsingRes(
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
    console.error(e);
    // Fall back to xycut-plus
    try {
      const sortedIndices = xycutPlusSort(blockBboxes);
      const sortedBoxes = sortedIndices.map(i => blockBboxes[i]);
      for (let i = 0; i < fixBlocks.length; i++) {
        fixBlocks[i].index = sortedBoxes.findIndex(b => b === blockBboxes[i]);
      }
    } catch (e2) {
      console.error(e2);
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
 * PORTING NOTE: revert_group_blocks → revertGroupBlocks
 *
 * @param {Array<object>} blocks
 * @returns {Array<object>}
 */
export function revertGroupBlocks(blocks) {
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
 * PORTING NOTE: process_block_list → processBlockList
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
