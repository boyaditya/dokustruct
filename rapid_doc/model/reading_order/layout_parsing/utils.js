// Copyright (c) 2024 PaddlePaddle Authors. All Rights Reserved.
// Apache License, Version 2.0

import { intTrunc } from '../../../utils/math_utils.js';
import { REGION_SETTINGS } from "./setting.js";

// ─────────────────────────────────────────────────────────────
// Basic geometry helpers
// ─────────────────────────────────────────────────────────────

/**
 * Convert a list of polygons to [left, top, right, bottom] boxes.
 * @param {Array<Array<[number,number]>>} dtPolys
 * @returns {Array<[number,number,number,number]>}
 */
export function convertPointsToBoxes(dtPolys) {
  if (!dtPolys || dtPolys.length === 0) return [];
  return dtPolys.map((poly) => {
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
}

/**
 * Get indices of srcBoxes that overlap with any refBox (inter > 3 in both axes).
 * @param {Array} srcBoxes
 * @param {Array} refBoxes
 * @returns {number[]}
 */
export function getOverlapBoxesIdx(srcBoxes, refBoxes) {
  const matchIdxList = [];
  if (!srcBoxes || !refBoxes || srcBoxes.length === 0 || refBoxes.length === 0) return matchIdxList;
  for (const refBox of refBoxes) {
    for (let i = 0; i < srcBoxes.length; i++) {
      const src = srcBoxes[i];
      const x1 = Math.max(refBox[0], src[0]);
      const y1 = Math.max(refBox[1], src[1]);
      const x2 = Math.min(refBox[2], src[2]);
      const y2 = Math.min(refBox[3], src[3]);
      if (x2 - x1 > 3 && y2 - y1 > 3) matchIdxList.push(i);
    }
  }
  return matchIdxList;
}

/**
 * Filter OCR results to include/exclude boxes within objectBoxes.
 * @param {Object} overallOcrRes - {rec_polys, rec_texts, rec_scores, rec_boxes, dt_polys, rec_labels}
 * @param {Array} objectBoxes
 * @param {boolean} flagWithin
 * @param {boolean} returnMatchIdx
 * @returns {Object|[Object,number[]]}
 */
export function getSubRegionsOcrRes(
  overallOcrRes,
  objectBoxes,
  flagWithin = true,
  returnMatchIdx = false
) {
  const result = {
    rec_polys: [],
    rec_texts: [],
    rec_scores: [],
    rec_boxes: [],
  };
  if (!overallOcrRes || !objectBoxes) {
    return returnMatchIdx ? [result, []] : result;
  }

  const overallTextBoxes = overallOcrRes.rec_boxes || [];
  if (overallTextBoxes.length === 0) {
    return returnMatchIdx ? [result, []] : result;
  }

  let matchIdxList = getOverlapBoxesIdx(overallTextBoxes, objectBoxes);
  matchIdxList = [...new Set(matchIdxList)];

  for (let boxNo = 0; boxNo < overallTextBoxes.length; boxNo++) {
    const flagMatch = flagWithin
      ? matchIdxList.includes(boxNo)
      : !matchIdxList.includes(boxNo);
    if (flagMatch) {
      result.rec_polys.push(overallOcrRes.rec_polys[boxNo]);
      result.rec_texts.push(overallOcrRes.rec_texts[boxNo]);
      result.rec_scores.push(overallOcrRes.rec_scores[boxNo]);
      result.rec_boxes.push(overallOcrRes.rec_boxes[boxNo]);
    }
  }
  return returnMatchIdx ? [result, matchIdxList] : result;
}

/**
 * Calculate 1-D projection overlap ratio between two bboxes.
 * @param {number[]} bbox1 [x1,y1,x2,y2]
 * @param {number[]} bbox2 [x1,y1,x2,y2]
 * @param {"horizontal"|"vertical"} direction
 * @param {"union"|"small"|"large"} mode
 * @returns {number}
 */
export function calculateProjectionOverlapRatio(
  bbox1,
  bbox2,
  direction = "horizontal",
  mode = "union"
) {
  if (!bbox1 || !bbox2 || bbox1.length < 4 || bbox2.length < 4) return 0;

  let startIdx, endIdx;
  if (direction === "horizontal") {
    startIdx = 0;
    endIdx = 2;
  } else {
    startIdx = 1;
    endIdx = 3;
  }
  const a1 = bbox1[startIdx], a2 = bbox1[endIdx];
  const b1 = bbox2[startIdx], b2 = bbox2[endIdx];
  const overlapStart = Math.max(a1, b1);
  const overlapEnd = Math.min(a2, b2);
  const overlap = overlapEnd - overlapStart;
  if (overlap <= 0) return 0;

  let refWidth;
  if (mode === "union") {
    refWidth = Math.max(a2, b2) - Math.min(a1, b1);
  } else if (mode === "small") {
    refWidth = Math.min(a2 - a1, b2 - b1);
  } else if (mode === "large") {
    refWidth = Math.max(a2 - a1, b2 - b1);
  } else {
    throw new Error(`[LayoutParsingUtils] Invalid projection overlap mode: "${mode}".`);
  }
  return refWidth > 0 ? overlap / refWidth : 0;
}

/**
 * Calculate 2D overlap ratio between two bboxes.
 * @param {number[]} bbox1
 * @param {number[]} bbox2
 * @param {"union"|"small"|"large"} mode
 * @returns {number}
 */
export function calculateOverlapRatio(bbox1, bbox2, mode = "union") {
  if (!bbox1 || !bbox2 || bbox1.length < 4 || bbox2.length < 4) return 0;

  const xMinInter = Math.max(bbox1[0], bbox2[0]);
  const yMinInter = Math.max(bbox1[1], bbox2[1]);
  const xMaxInter = Math.min(bbox1[2], bbox2[2]);
  const yMaxInter = Math.min(bbox1[3], bbox2[3]);
  const interW = Math.max(0, xMaxInter - xMinInter);
  const interH = Math.max(0, yMaxInter - yMinInter);
  const interArea = interW * interH;

  const area1 = caculateBboxArea(bbox1);
  const area2 = caculateBboxArea(bbox2);

  let refArea;
  if (mode === "union") {
    refArea = area1 + area2 - interArea;
  } else if (mode === "small") {
    refArea = Math.min(area1, area2);
  } else if (mode === "large") {
    refArea = Math.max(area1, area2);
  } else {
    throw new Error(`[LayoutParsingUtils] Invalid overlap mode: "${mode}". Expected "union", "small", or "large".`);
  }
  if (refArea === 0) return 0;
  return interArea / refArea;
}

/**
 * Calculate the minimum enclosing bbox for an array of bboxes.
 * @param {Array<number[]>} bboxes
 * @returns {number[]} [x1,y1,x2,y2]
 */
export function calculateMinimumEnclosingBbox(bboxes) {
  if (!bboxes || bboxes.length === 0) {
    throw new Error("[LayoutParsingUtils] calculateMinimumEnclosingBbox called with empty bboxes array.");
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bboxes) {
    if (b[0] < minX) minX = b[0];
    if (b[1] < minY) minY = b[1];
    if (b[2] > maxX) maxX = b[2];
    if (b[3] > maxY) maxY = b[3];
  }
  return [minX, minY, maxX, maxY];
}

export function isEnglishLetter(char) {
  return /^[A-Za-z]$/.test(char);
}

export function isNumeric(char) {
  return /^[\d]+$/.test(char);
}

export function isNonBreakingPunctuation(char) {
  return new Set([
    ",", "，", "、", ";", "；", ":", "：", "-", "'", '"', "\u201c",
  ]).has(char);
}

/**
 * @param {number[]} bbox1
 * @param {number[]} bbox2
 * @param {number} ratio
 * @param {boolean} smaller
 * @returns {1|2|null}
 */
export function _getMinboxIfOverlapByRatio(bbox1, bbox2, ratio, smaller = true) {
  if (!bbox1 || !bbox2) return null;

  const area1 = caculateBboxArea(bbox1);
  const area2 = caculateBboxArea(bbox2);
  const overlapRatio = calculateOverlapRatio(bbox1, bbox2, "small");
  if (overlapRatio > ratio) {
    if ((area1 <= area2 && smaller) || (area1 >= area2 && !smaller)) return 1;
    return 2;
  }
  return null;
}

/**
 * Remove overlapping blocks. Works on {boxes:[{coordinate, label, ...}]} form.
 * Returns updated blocks object (mutated in place copy).
 * @param {{boxes: Array}} blocks
 * @param {number} threshold
 * @param {boolean} smaller
 * @returns {{boxes: Array}}
 */
export function removeOverlapBlocks(blocks, threshold = 0.65, smaller = true) {
  if (!blocks || !blocks.boxes || blocks.boxes.length === 0) {
    return { ...blocks, boxes: [] };
  }

  const result = { ...blocks, boxes: blocks.boxes.map((b) => ({ ...b })) };
  const droppedIndexes = new Set();

  for (let i = 0; i < result.boxes.length; i++) {
    for (let j = i + 1; j < result.boxes.length; j++) {
      if (droppedIndexes.has(i) || droppedIndexes.has(j)) continue;
      const block1 = result.boxes[i];
      const block2 = result.boxes[j];
      const overlapBoxIndex = _getMinboxIfOverlapByRatio(
        block1.coordinate,
        block2.coordinate,
        threshold,
        smaller
      );
      if (overlapBoxIndex !== null) {
        const isBlock1Image = block1.label === "image";
        const isBlock2Image = block2.label === "image";
        let dropIndex;
        if (isBlock1Image !== isBlock2Image) {
          dropIndex = isBlock1Image ? i : j;
        } else {
          dropIndex = overlapBoxIndex === 1 ? i : j;
        }
        droppedIndexes.add(dropIndex);
      }
    }
  }

  const sortedDropped = [...droppedIndexes].sort((a, b) => b - a);
  for (const idx of sortedDropped) {
    result.boxes.splice(idx, 1);
  }
  return result;
}

/**
 * Compute the intersection of two bboxes.
 * @param {number[]} bbox1 [x1,y1,x2,y2]
 * @param {number[]} bbox2 [x1,y1,x2,y2]
 * @param {"bbox"|"poly"} returnFormat
 * @returns {number[]|number[][]|null}
 */
export function getBboxIntersection(bbox1, bbox2, returnFormat = "bbox") {
  // Convert poly (8-coord) to bbox if needed
  const toRect = (bb) => {
    if (bb.length === 4) return bb;
    const pts = convertPointsToBoxes([bb]);
    return pts[0];
  };
  const r1 = toRect(bbox1);
  const r2 = toRect(bbox2);

  const xMin = Math.max(r1[0], r2[0]);
  const yMin = Math.max(r1[1], r2[1]);
  const xMax = Math.min(r1[2], r2[2]);
  const yMax = Math.min(r1[3], r2[3]);

  if (xMin >= xMax || yMin >= yMax) return null;

  if (returnFormat === "bbox") {
    return [xMin, yMin, xMax, yMax];
  } else if (returnFormat === "poly") {
    return [
      [xMin, yMin],
      [xMax, yMin],
      [xMax, yMax],
      [xMin, yMax],
    ];
  } else {
    throw new Error(`[LayoutParsingUtils] getBboxIntersection: returnFormat must be "bbox" or "poly", got "${returnFormat}".`);
  }
}

/**
 * Shrink supplement region bbox to best fit remaining blocks.
 * @param {number[]} supplementRegionBbox
 * @param {number[]} refRegionBbox
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {Set<number>} blockIdxesSet
 * @param {number[][]} blockBboxes
 * @returns {[number[], number[]]}
 */
export function shrinkSupplementRegionBbox(
  supplementRegionBbox,
  refRegionBbox,
  imageWidth,
  imageHeight,
  blockIdxesSet,
  blockBboxes
) {
  if (!blockIdxesSet || blockIdxesSet.size === 0) return [supplementRegionBbox, []];

  let [x1, y1, x2, y2] = supplementRegionBbox;
  const [x1p, y1p, x2p, y2p] = refRegionBbox;
  const indexConversionMap = { 0: 2, 1: 3, 2: 0, 3: 1 };

  const edgeDistanceList = [
    (x1p - x1) / imageWidth,
    (y1p - y1) / imageHeight,
    (x2 - x2p) / imageWidth,
    (y2 - y2p) / imageHeight,
  ];
  const edgeDistanceTmp = [...edgeDistanceList];
  let minDistance = Math.min(...edgeDistanceList);
  let srcIndex = indexConversionMap[edgeDistanceList.indexOf(minDistance)];

  let inerBlockIdxes = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const dstIndex = indexConversionMap[srcIndex];
    const tmpRegionBbox = [...supplementRegionBbox];
    tmpRegionBbox[dstIndex] = refRegionBbox[srcIndex];

    inerBlockIdxes = [];
    const splitBlockIdxes = [];

    const matchThresh = REGION_SETTINGS.match_block_overlap_ratio_threshold ?? 0.8;
    const splitThresh = REGION_SETTINGS.split_block_overlap_ratio_threshold ?? 0.4;

    for (const blockIdx of blockIdxesSet) {
      const overlapRatio = calculateOverlapRatio(
        tmpRegionBbox,
        blockBboxes[blockIdx],
        "small"
      );
      if (overlapRatio > matchThresh) {
        inerBlockIdxes.push(blockIdx);
      } else if (overlapRatio > splitThresh) {
        splitBlockIdxes.push(blockIdx);
      }
    }

    if (inerBlockIdxes.length > 0) {
      if (splitBlockIdxes.length > 0) {
        for (const splitBlockIdx of splitBlockIdxes) {
          const splitBlockBbox = blockBboxes[splitBlockIdx];
          const [sx1, sy1, sx2, sy2] = tmpRegionBbox;
          const [bx1, by1, bx2, by2] = splitBlockBbox;
          const ed = [
            (bx1 - sx1) / imageWidth,
            (by1 - sy1) / imageHeight,
            (sx2 - bx2) / imageWidth,
            (sy2 - by2) / imageHeight,
          ];
          const maxDist = Math.max(...ed);
          const srcIdx2 = ed.indexOf(maxDist);
          const dstIdx2 = indexConversionMap[srcIdx2];
          tmpRegionBbox[dstIdx2] = splitBlockBbox[srcIdx2];
          // Porting fix: capture return value from recursive call
          let inerIdxes;
          [tmpRegionBbox, inerIdxes] = shrinkSupplementRegionBbox(
            tmpRegionBbox,
            refRegionBbox,
            imageWidth,
            imageHeight,
            new Set(inerBlockIdxes),
            blockBboxes
          );
          if (inerIdxes.length === 0) continue; // FIX R2: was missing
        }
      }
      const matchedBboxes = inerBlockIdxes.map((idx) => blockBboxes[idx]);
      supplementRegionBbox = calculateMinimumEnclosingBbox(matchedBboxes);
      break;
    } else {
      const idx = edgeDistanceTmp.indexOf(minDistance);
      edgeDistanceTmp.splice(idx, 1);
      if (edgeDistanceTmp.length === 0) break;
      minDistance = Math.min(...edgeDistanceTmp);
      srcIndex = indexConversionMap[edgeDistanceList.indexOf(minDistance)];
    }
  }
  return [supplementRegionBbox, inerBlockIdxes];
}

/**
 * Expand region_box to encompass bbox.
 * @param {number[]} bbox
 * @param {number[]|null} regionBox
 * @returns {number[]}
 */
export function updateRegionBox(bbox, regionBox) {
  if (regionBox === null) return bbox.slice();
  const [x1, y1, x2, y2] = bbox;
  // Porting fix: intTrunc matches Python int truncation
  return [
    Math.min(x1, regionBox[0]),
    Math.min(y1, regionBox[1]),
    Math.max(x2, regionBox[2]),
    Math.max(y2, regionBox[3]),
  ].map(intTrunc);
}

/**
 * Area of a bounding box.
 * @param {number[]} bbox [x1,y1,x2,y2]
 * @returns {number}
 */
export function caculateBboxArea(bbox) {
  if (!bbox || bbox.length < 4) return 0;
  const [x1, y1, x2, y2] = bbox.map(Number);
  return Math.abs((x2 - x1) * (y2 - y1));
}

/**
 * Euclidean distance between two [x,y] points.
 */
export function caculateEuclideanDist(p1, p2) {
  return Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);
}

/**
 * Determine segment start/end flags for a block vs. previous block.
 * @param {Object} block - LayoutBlock-like
 * @param {Object|null} prevBlock
 * @returns {[boolean,boolean]}
 */
export function getSegFlag(block, prevBlock) {
  let segStartFlag = true;
  let segEndFlag = true;

  let contextLeft = block.start_coordinate;
  let contextRight = block.end_coordinate;
  const segStart = block.seg_start_coordinate;
  const segEnd = block.seg_end_coordinate;

  if (prevBlock !== null) {
    const numOfPrevLines = prevBlock.num_of_lines;
    const preBlockSegEnd = prevBlock.seg_end_coordinate;
    let prevEndSpaceSmall = Math.abs(prevBlock.end_coordinate - preBlockSegEnd) < 10;
    const prevLinesMoreThanOne = numOfPrevLines > 1;

    const overlapBlocks =
      contextLeft < prevBlock.end_coordinate &&
      contextRight > prevBlock.start_coordinate;

    let edgeDistance;
    if (overlapBlocks) {
      contextLeft = Math.min(prevBlock.start_coordinate, contextLeft);
      contextRight = Math.max(prevBlock.end_coordinate, contextRight);
      prevEndSpaceSmall =
        Math.abs(contextRight - preBlockSegEnd) < 10;
      edgeDistance = 0;
    } else {
      edgeDistance = Math.abs(block.start_coordinate - prevBlock.end_coordinate);
    }

    const currentStartSpaceSmall = segStart - contextLeft < 10;

    if (
      prevEndSpaceSmall &&
      currentStartSpaceSmall &&
      prevLinesMoreThanOne &&
      edgeDistance < Math.max(prevBlock.width, block.width)
    ) {
      segStartFlag = false;
    }
  } else {
    if (segStart - contextLeft < 10) {
      segStartFlag = false;
    }
  }

  if (contextRight - segEnd < 10) {
    segEndFlag = false;
  }

  return [segStartFlag, segEndFlag];
}
