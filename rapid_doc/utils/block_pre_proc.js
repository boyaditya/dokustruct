// Copyright (c) Opendatalab. All rights reserved.

import {
  calculateIou,
  calculateOverlapAreaInBbox1AreaRatio,
  calculateVerticalProjectionOverlapRatio,
  getMinboxIfOverlapByRatio,
} from './boxbase.js';
import { BlockType } from './enum_class.js';

/**
 * Separate groups into body, caption, footnote, and maybe-text-image lists.
 *
 * @param {Array<object>} groups
 * @param {string} bodyKey
 * @param {string} captionKey
 * @param {string} footnoteKey
 * @returns {[Array, Array, Array, Array]} [bodyBlocks, captionBlocks, footnoteBlocks, maybeTextImageBlocks]
 */
export function processGroups(groups, bodyKey, captionKey, footnoteKey) {
  if (!groups || groups.length === 0) return [[], [], [], []];

  const bodyBlocks = [];
  const captionBlocks = [];
  const footnoteBlocks = [];
  const maybeTextImageBlocks = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (bodyKey === 'image_body' && group[captionKey].length === 0 && group[footnoteKey].length === 0) {
      group[bodyKey].group_id = i;
      maybeTextImageBlocks.push(group[bodyKey]);
    } else {
      group[bodyKey].group_id = i;
      bodyBlocks.push(group[bodyKey]);
      for (const captionBlock of group[captionKey]) {
        captionBlock.group_id = i;
        captionBlocks.push(captionBlock);
      }
      for (const footnoteBlock of group[footnoteKey]) {
        footnoteBlock.group_id = i;
        footnoteBlocks.push(footnoteBlock);
      }
    }
  }

  return [bodyBlocks, captionBlocks, footnoteBlocks, maybeTextImageBlocks];
}

/**
 * Build the canonical all_bboxes list from all block types.
 *
 * @returns {[Array[], Array[], Array[]]} [allBboxes, allDiscardedBlocks, footnoteBlocks]
 */
export function prepareBlockBboxes(
  imgBodyBlocks,
  imgCaptionBlocks,
  imgFootnoteBlocks,
  tableBodyBlocks,
  tableCaptionBlocks,
  tableFootnoteBlocks,
  discardedBlocks,
  textBlocks,
  titleBlocks,
  interlineEquationBlocks,
  pageW,
  pageH,
) {
  let allBboxes = [];

  addBboxes(imgBodyBlocks, BlockType.IMAGE_BODY, allBboxes);
  addBboxes(imgCaptionBlocks, BlockType.IMAGE_CAPTION, allBboxes);
  addBboxes(imgFootnoteBlocks, BlockType.IMAGE_CAPTION, allBboxes);
  addBboxes(tableBodyBlocks, BlockType.TABLE_BODY, allBboxes);
  addBboxes(tableCaptionBlocks, BlockType.TABLE_CAPTION, allBboxes);
  addBboxes(tableFootnoteBlocks, BlockType.TABLE_FOOTNOTE, allBboxes);
  addBboxes(textBlocks, BlockType.TEXT, allBboxes);
  addBboxes(titleBlocks, BlockType.TITLE, allBboxes);
  addBboxes(interlineEquationBlocks, BlockType.INTERLINE_EQUATION, allBboxes);

  allBboxes = fixTextOverlapTitleBlocks(allBboxes);
  allBboxes = removeNeedDropBlocks(allBboxes, discardedBlocks);
  allBboxes = fixInterlineEquationOverlapTextBlocksWithHiIou(allBboxes);

  const allDiscardedBlocks = [];
  addBboxes(discardedBlocks, BlockType.DISCARDED, allDiscardedBlocks);

  // Detect footnote blocks: width > 1/3 page, height > 10, y0 > 70% page height
  const footnoteBlocks = [];
  for (const discarded of (discardedBlocks ?? [])) {
    const [x0, y0, x1, y1] = discarded.bbox;
    if ((x1 - x0) > (pageW / 3) && (y1 - y0) > 10 && y0 > (pageH * 0.7)) {
      footnoteBlocks.push([x0, y0, x1, y1]);
    }
  }

  // Detect whether PP-DocLayoutV2 original_order is available
  let usePpDoclayoutv2 = false;
  if (allBboxes.length > 0) {
    const originalOrder = allBboxes[0][11];
    if (originalOrder != null && originalOrder >= 0) {
      usePpDoclayoutv2 = true;
    }
  }

  if (!usePpDoclayoutv2) {
    const needRemoveBlocks = findBlocksUnderFootnote(allBboxes, footnoteBlocks);
    if (needRemoveBlocks.length > 0) {
      for (const block of needRemoveBlocks) {
        const idx = allBboxes.indexOf(block);
        if (idx !== -1) allBboxes.splice(idx, 1);
        allDiscardedBlocks.push(block);
      }
    }
    allBboxes = removeOverlapsMinBlocks(allBboxes);
    removeOverlapsMinBlocks(allDiscardedBlocks);
  }

  // Rough sort by x0+y0
  allBboxes.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));

  return [allBboxes, allDiscardedBlocks, footnoteBlocks];
}

/**
 * Push bbox tuples from blocks into the bboxes array.
 * Bbox tuple layout: [x0, y0, x1, y1, null, null, null, blockType, null, null, originalLabel, originalOrder, score, groupId, polygonPoints]
 *
 * @param {Array<object>} blocks
 * @param {*} blockType
 * @param {Array} bboxes
 */
export function addBboxes(blocks, blockType, bboxes) {
  if (!blocks) return;

  const groupedTypes = new Set([
    BlockType.IMAGE_BODY, BlockType.IMAGE_CAPTION, BlockType.IMAGE_FOOTNOTE,
    BlockType.TABLE_BODY, BlockType.TABLE_CAPTION, BlockType.TABLE_FOOTNOTE,
  ]);
  for (const block of blocks) {
    const [x0, y0, x1, y1] = block.bbox;
    const polygonPoints = block.polygon_points ?? null;
    if (groupedTypes.has(blockType)) {
      bboxes.push([x0, y0, x1, y1, null, null, null, blockType, null, null, block.original_label ?? null, block.original_order ?? null, block.score, block.group_id ?? null, polygonPoints]);
    } else {
      bboxes.push([x0, y0, x1, y1, null, null, null, blockType, null, null, block.original_label ?? null, block.original_order ?? null, block.score, null, polygonPoints]);
    }
  }
}

const HIGH_IOU_THRESHOLD = 0.8;
const OVERLAP_DROP_THRESHOLD = 0.6;
const OVERLAP_MERGE_THRESHOLD = 0.8;

/**
 * Remove title blocks that heavily overlap text blocks.
 *
 * @param {Array[]} allBboxes
 * @returns {Array[]}
 */
export function fixTextOverlapTitleBlocks(allBboxes) {
  const textBlocks = allBboxes.filter(b => b[7] === BlockType.TEXT);
  const titleBlocks = allBboxes.filter(b => b[7] === BlockType.TITLE);
  const needRemove = [];

  for (const textBlock of textBlocks) {
    for (const titleBlock of titleBlocks) {
      if (calculateIou(textBlock.slice(0, 4), titleBlock.slice(0, 4)) > HIGH_IOU_THRESHOLD) {
        if (!needRemove.includes(titleBlock)) needRemove.push(titleBlock);
      }
    }
  }

  for (const block of needRemove) {
    const idx = allBboxes.indexOf(block);
    if (idx !== -1) allBboxes.splice(idx, 1);
  }
  return allBboxes;
}

/**
 * Remove blocks that heavily overlap discarded blocks.
 *
 * @param {Array[]} allBboxes
 * @param {Array<object>} discardedBlocks
 * @returns {Array[]}
 */
export function removeNeedDropBlocks(allBboxes, discardedBlocks) {
  if (!discardedBlocks || discardedBlocks.length === 0) return allBboxes;

  const needRemove = [];
  for (const block of allBboxes) {
    for (const discardedBlock of discardedBlocks) {
      if (calculateOverlapAreaInBbox1AreaRatio(block.slice(0, 4), discardedBlock.bbox) > OVERLAP_DROP_THRESHOLD) {
        if (!needRemove.includes(block)) {
          needRemove.push(block);
          break;
        }
      }
    }
  }
  for (const block of needRemove) {
    const idx = allBboxes.indexOf(block);
    if (idx !== -1) allBboxes.splice(idx, 1);
  }
  return allBboxes;
}

/**
 * Remove text blocks that heavily overlap interline equation blocks.
 *
 * @param {Array[]} allBboxes
 * @returns {Array[]}
 */
export function fixInterlineEquationOverlapTextBlocksWithHiIou(allBboxes) {
  const textBlocks = allBboxes.filter(b => b[7] === BlockType.TEXT);
  const interlineBlocks = allBboxes.filter(b => b[7] === BlockType.INTERLINE_EQUATION);
  const needRemove = [];

  for (const ieBlock of interlineBlocks) {
    for (const textBlock of textBlocks) {
      if (calculateIou(ieBlock.slice(0, 4), textBlock.slice(0, 4)) > HIGH_IOU_THRESHOLD) {
        if (!needRemove.includes(textBlock)) needRemove.push(textBlock);
      }
    }
  }

  for (const block of needRemove) {
    const idx = allBboxes.indexOf(block);
    if (idx !== -1) allBboxes.splice(idx, 1);
  }
  return allBboxes;
}

/**
 * Find blocks below footnote regions with >= 80% vertical projection overlap.
 *
 * @param {Array[]} allBboxes
 * @param {number[][]} footnoteBlocks
 * @returns {Array[]}
 */
export function findBlocksUnderFootnote(allBboxes, footnoteBlocks) {
  if (!footnoteBlocks || footnoteBlocks.length === 0) return [];

  const needRemoveBlocks = [];
  for (const block of allBboxes) {
    const [blockX0, blockY0, blockX1, blockY1] = block;
    for (const footnoteBbox of footnoteBlocks) {
      const [, , , footnoteY1] = footnoteBbox;
      if (
        blockY0 >= footnoteY1 &&
        calculateVerticalProjectionOverlapRatio([blockX0, blockY0, blockX1, blockY1], footnoteBbox) >= 0.8
      ) {
        if (!needRemoveBlocks.includes(block)) {
          needRemoveBlocks.push(block);
          break;
        }
      }
    }
  }
  return needRemoveBlocks;
}

/**
 * Remove smaller overlapping blocks (merging their bbox into the larger block).
 *
 * @param {Array[]} allBboxes
 * @returns {Array[]}
 */
export function removeOverlapsMinBlocks(allBboxes) {
  if (!allBboxes || allBboxes.length === 0) return allBboxes ?? [];

  const needRemove = [];
  for (let i = 0; i < allBboxes.length; i++) {
    for (let j = i + 1; j < allBboxes.length; j++) {
      const block1 = allBboxes[i];
      const block2 = allBboxes[j];
      const overlapBox = getMinboxIfOverlapByRatio(block1.slice(0, 4), block2.slice(0, 4), OVERLAP_MERGE_THRESHOLD);
      if (overlapBox !== null) {
        const area1 = (block1[2] - block1[0]) * (block1[3] - block1[1]);
        const area2 = (block2[2] - block2[0]) * (block2[3] - block2[1]);
        const [blockToRemove, largeBlock] = area1 <= area2 ? [block1, block2] : [block2, block1];

        if (!needRemove.includes(blockToRemove)) {
          const [x1, y1, x2, y2] = largeBlock;
          const [sx1, sy1, sx2, sy2] = blockToRemove;
          largeBlock[0] = Math.min(x1, sx1);
          largeBlock[1] = Math.min(y1, sy1);
          largeBlock[2] = Math.max(x2, sx2);
          largeBlock[3] = Math.max(y2, sy2);
          needRemove.push(blockToRemove);
        }
      }
    }
  }
  for (const block of needRemove) {
    const idx = allBboxes.indexOf(block);
    if (idx !== -1) allBboxes.splice(idx, 1);
  }
  return allBboxes;
}
