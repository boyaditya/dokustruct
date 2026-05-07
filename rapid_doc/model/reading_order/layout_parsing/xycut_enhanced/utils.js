// Copyright (c) 2024 PaddlePaddle Authors. All Rights Reserved.
// Apache License, Version 2.0

import { BLOCK_LABEL_MAP, XYCUT_SETTINGS } from "../setting.js";
import {
  calculateOverlapRatio,
  calculateProjectionOverlapRatio,
  getSegFlag,
} from "../utils.js";

// ─────────────────────────────────────────────────────────────
// Exports (barrel)
// ─────────────────────────────────────────────────────────────
export {
  calculateDiscontinuousProjection,
  euclideanInsert,
  findLocalMinimaFlatRegions,
  getBlocksByDirectionInterval,
  getCutBlocks,
  insertChildBlocks,
  manhattanInsert,
  projectionByBboxes,
  recursiveXyCut,
  recursiveYxCut,
  referenceInsert,
  shrinkOverlappingBoxes,
  sortNormalBlocks,
  updateDocTitleChildBlocks,
  updateParagraphTitleChildBlocks,
  updateRegionChildBlocks,
  updateVisionChildBlocks,
  weightedDistanceInsert,
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Nearest weighted edge distance between two bboxes.
 * @param {number[]} bbox1
 * @param {number[]} bbox2
 * @param {number[]} weight [left, right, up, down]
 * @returns {number}
 */
function getNearestEdgeDistance(bbox1, bbox2, weight = [1, 1, 1, 1]) {
  const [x1, y1, x2, y2] = bbox1;
  const [x1p, y1p, x2p, y2p] = bbox2;
  const hIou = calculateProjectionOverlapRatio(bbox1, bbox2, "horizontal");
  const vIou = calculateProjectionOverlapRatio(bbox1, bbox2, "vertical");
  if (hIou > 0 && vIou > 0) return 0;
  let minXDist = 0, minYDist = 0;
  if (hIou === 0) {
    minXDist =
      Math.min(Math.abs(x1 - x2p), Math.abs(x2 - x1p)) *
      (x2 < x1p ? weight[0] : weight[1]);
  }
  if (vIou === 0) {
    minYDist =
      Math.min(Math.abs(y1 - y2p), Math.abs(y2 - y1p)) *
      (y2 < y1p ? weight[2] : weight[3]);
  }
  return minXDist + minYDist;
}

/**
 * Build 1-D projection histogram from bboxes.
 * @param {number[][]} boxes  N×4 array
 * @param {0|1} axis  0=x, 1=y
 * @returns {Int32Array}
 */
function projectionByBboxes(boxes, axis) {
  if (!boxes || boxes.length === 0) return new Int32Array(0);
  // determine histogram length
  let maxLength = 0;
  for (const box of boxes) {
    const val = Math.abs(box[axis + 2]);
    if (val > maxLength) maxLength = val;
  }
  // check for negative start
  let hasNeg = false;
  for (const box of boxes) {
    if (box[axis] < 0) { hasNeg = true; break; }
  }
  if (hasNeg) {
    maxLength = 0;
    for (const box of boxes) {
      const v = Math.abs(box[axis]);
      if (v > maxLength) maxLength = v;
    }
  }
  const projection = new Int32Array(maxLength);
  for (const box of boxes) {
    const start = Math.abs(box[axis]);
    const end = Math.abs(box[axis + 2]);
    const s = Math.min(start, end);
    const e = Math.max(start, end);
    for (let i = s; i < e && i < maxLength; i++) projection[i]++;
  }
  return projection;
}

/**
 * Split projection profile into (starts, ends) arrays.
 * @param {Int32Array|number[]} arrValues
 * @param {number} minValue
 * @param {number} minGap
 * @returns {[number[], number[]]|null}
 */
function splitProjectionProfile(arrValues, minValue, minGap) {
  const sigIdxs = [];
  for (let i = 0; i < arrValues.length; i++) {
    if (arrValues[i] > minValue) sigIdxs.push(i);
  }
  if (sigIdxs.length === 0) return null;

  const gapIdxs = [];
  for (let i = 0; i < sigIdxs.length - 1; i++) {
    if (sigIdxs[i + 1] - sigIdxs[i] > minGap) gapIdxs.push(i);
  }

  const starts = [sigIdxs[0]];
  const ends = [];
  for (const gi of gapIdxs) {
    ends.push(sigIdxs[gi] + 1);
    starts.push(sigIdxs[gi + 1]);
  }
  ends.push(sigIdxs[sigIdxs.length - 1] + 1);
  return [starts, ends];
}

/**
 * Recursive Y-then-X cut.
 * @param {number[][]} boxes  N×4
 * @param {number[]} indices
 * @param {number[]} res  output (modified in place)
 * @param {number} minGap
 */
function recursiveYxCut(boxes, indices, res, minGap = 1) {
  if (boxes.length !== indices.length)
    throw new Error("boxes and indices length mismatch");
  if (boxes.length === 0) return;

  // Sort by y_min
  const ySorted = boxes
    .map((b, i) => ({ b, idx: indices[i] }))
    .sort((a, b) => a.b[1] - b.b[1]);
  const ySortedBoxes = ySorted.map((x) => x.b);
  const ySortedIndices = ySorted.map((x) => x.idx);

  const yProj = projectionByBboxes(ySortedBoxes, 1);
  const yIntervals = splitProjectionProfile(yProj, 0, 1);
  if (!yIntervals) return;

  const [yStarts, yEnds] = yIntervals;
  for (let k = 0; k < yStarts.length; k++) {
    const yStart = yStarts[k], yEnd = yEnds[k];
    const yMask = ySortedBoxes.map((b) => b[1] >= yStart && b[1] < yEnd);
    const yBoxChunk = ySortedBoxes.filter((_, i) => yMask[i]);
    const yIdxChunk = ySortedIndices.filter((_, i) => yMask[i]);

    // Sort by x_min
    const xSorted = yBoxChunk
      .map((b, i) => ({ b, idx: yIdxChunk[i] }))
      .sort((a, b) => a.b[0] - b.b[0]);
    const xBoxChunk = xSorted.map((x) => x.b);
    const xIdxChunk = xSorted.map((x) => x.idx);

    const xProj = projectionByBboxes(xBoxChunk, 0);
    const xIntervals = splitProjectionProfile(xProj, 0, minGap);
    if (!xIntervals) continue;

    const [xStarts, xEnds] = xIntervals;
    if (xStarts.length === 1) {
      res.push(...xIdxChunk);
      continue;
    }

    const hasNegX = xBoxChunk.some((b) => b[0] < 0);
    const effectiveStarts = hasNegX ? [...xStarts].reverse() : xStarts;
    const effectiveEnds = hasNegX ? [...xEnds].reverse() : xEnds;

    for (let m = 0; m < effectiveStarts.length; m++) {
      const xStart = effectiveStarts[m], xEnd = effectiveEnds[m];
      const xMask = xBoxChunk.map((b) => Math.abs(b[0]) >= xStart && Math.abs(b[0]) < xEnd);
      recursiveYxCut(
        xBoxChunk.filter((_, i) => xMask[i]),
        xIdxChunk.filter((_, i) => xMask[i]),
        res
      );
    }
  }
}

/**
 * Recursive X-then-Y cut.
 */
function recursiveXyCut(boxes, indices, res, minGap = 1) {
  if (boxes.length !== indices.length)
    throw new Error("boxes and indices length mismatch");
  if (boxes.length === 0) return;

  const xSorted = boxes
    .map((b, i) => ({ b, idx: indices[i] }))
    .sort((a, b) => a.b[0] - b.b[0]);
  const xSortedBoxes = xSorted.map((x) => x.b);
  const xSortedIndices = xSorted.map((x) => x.idx);

  const xProj = projectionByBboxes(xSortedBoxes, 0);
  const xIntervals = splitProjectionProfile(xProj, 0, 1);
  if (!xIntervals) return;

  const [xStarts, xEnds] = xIntervals;
  const hasNegX = xSortedBoxes.some((b) => b[0] < 0);
  const effStarts = hasNegX ? [...xStarts].reverse() : xStarts;
  const effEnds = hasNegX ? [...xEnds].reverse() : xEnds;

  for (let k = 0; k < effStarts.length; k++) {
    const xStart = effStarts[k], xEnd = effEnds[k];
    const xMask = xSortedBoxes.map((b) => Math.abs(b[0]) >= xStart && Math.abs(b[0]) < xEnd);
    const xBoxChunk = xSortedBoxes.filter((_, i) => xMask[i]);
    const xIdxChunk = xSortedIndices.filter((_, i) => xMask[i]);

    const ySorted = xBoxChunk
      .map((b, i) => ({ b, idx: xIdxChunk[i] }))
      .sort((a, b) => a.b[1] - b.b[1]);
    const yBoxChunk = ySorted.map((x) => x.b);
    const yIdxChunk = ySorted.map((x) => x.idx);

    const yProj = projectionByBboxes(yBoxChunk, 1);
    const yIntervals = splitProjectionProfile(yProj, 0, minGap);
    if (!yIntervals) continue;

    const [yStarts, yEnds] = yIntervals;
    if (yStarts.length === 1) {
      res.push(...yIdxChunk);
      continue;
    }
    for (let m = 0; m < yStarts.length; m++) {
      const yStart = yStarts[m], yEnd = yEnds[m];
      const yMask = yBoxChunk.map((b) => b[1] >= yStart && b[1] < yEnd);
      recursiveXyCut(
        yBoxChunk.filter((_, i) => yMask[i]),
        yIdxChunk.filter((_, i) => yMask[i]),
        res
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Insert helpers
// ─────────────────────────────────────────────────────────────

function referenceInsert(block, sortedBlocks) {
  let minDistance = Infinity;
  let nearestIdx = 0;
  let distance = 0;
  for (let i = 0; i < sortedBlocks.length; i++) {
    const sb = sortedBlocks[i];
    if (sb.bbox[3] <= block.bbox[1]) {
      distance = -(sb.bbox[2] * 10 + sb.bbox[3]);
    }
    if (distance < minDistance) {
      minDistance = distance;
      nearestIdx = i;
    }
  }
  sortedBlocks.splice(nearestIdx + 1, 0, block);
  return sortedBlocks;
}

function manhattanInsert(block, sortedBlocks) {
  let minDistance = Infinity;
  let nearestIdx = 0;
  for (let i = 0; i < sortedBlocks.length; i++) {
    const dist = _manhattanDistance(block.bbox, sortedBlocks[i].bbox);
    if (dist < minDistance) {
      minDistance = dist;
      nearestIdx = i;
    }
  }
  sortedBlocks.splice(nearestIdx + 1, 0, block);
  return sortedBlocks;
}

function euclideanInsert(block, sortedBlocks) {
  const blockDist = block.euclidean_distance;
  let insertIdx = sortedBlocks.length;
  for (let i = 0; i < sortedBlocks.length; i++) {
    if (sortedBlocks[i].euclidean_distance > blockDist) {
      insertIdx = i;
      break;
    }
  }
  sortedBlocks.splice(insertIdx, 0, block);
  return sortedBlocks;
}

function weightedDistanceInsert(block, sortedBlocks, region) {
  const toleranceLen = XYCUT_SETTINGS.edge_distance_compare_tolerance_len;
  const [x1, y1, x2, y2] = block.bbox;
  let minWeighted = Infinity, minEdge = Infinity, minUpEdge = Infinity;
  let nearestIdx = 0;
  let sortedDistance, blockDistance;

  // toleranceLenCopy is mutable per loop
  let tol = toleranceLen;

  for (let si = 0; si < sortedBlocks.length; si++) {
    const sb = sortedBlocks[si];
    const [x1p, y1p, x2p, y2p] = sb.bbox;

    const weight = _getWeights(block.order_label, block.direction);
    let edgeDist = getNearestEdgeDistance(block.bbox, sb.bbox, weight);
    let tolEffective = tol;

    if (BLOCK_LABEL_MAP.doc_title_labels.includes(block.label)) {
      const disperse = Math.max(1, region.text_line_width);
      tolEffective = Math.max(tolEffective, disperse);
    }
    if (block.label === "abstract") {
      tolEffective *= 2;
      edgeDist = Math.max(0.1, edgeDist) * 10;
    }

    const isBelow =
      region.direction === "horizontal" ? y2p < y1 : x1p > x2;
    let upEdgeDist =
      region.direction === "horizontal" ? y1p : -x2p;
    let leftEdgeDist =
      region.direction === "horizontal" ? x1p : y1p;

    const unordered = BLOCK_LABEL_MAP.unordered_labels.includes(block.label);
    const docTitle = BLOCK_LABEL_MAP.doc_title_labels.includes(block.label);
    const paraTitle = BLOCK_LABEL_MAP.paragraph_title_labels.includes(block.label);
    const vision = BLOCK_LABEL_MAP.vision_labels.includes(block.label);

    if ((!unordered || docTitle || paraTitle || vision) && isBelow) {
      upEdgeDist = -upEdgeDist;
      leftEdgeDist = -leftEdgeDist;
    }

    if (Math.abs(minUpEdge - upEdgeDist) <= tolEffective) {
      upEdgeDist = minUpEdge;
    }

    const weighted =
      edgeDist * XYCUT_SETTINGS.distance_weight_map.edge_weight +
      upEdgeDist * XYCUT_SETTINGS.distance_weight_map.up_edge_weight +
      leftEdgeDist * (XYCUT_SETTINGS.distance_weight_map.down_edge_weight ?? 0.0001);

    minEdge = Math.min(edgeDist, minEdge);
    minUpEdge = Math.min(upEdgeDist, minUpEdge);

    if (weighted < minWeighted) {
      nearestIdx = si;
      minWeighted = weighted;

      const isVisionOrTitle =
        BLOCK_LABEL_MAP.vision_labels.concat(BLOCK_LABEL_MAP.vision_title_labels).includes(block.label);

      if (Math.abs(Math.floor(y1 / 2) - Math.floor(y1p / 2)) > 0) {
        sortedDistance = y1p;
        blockDistance = y1;
      } else {
        if (region.direction === "horizontal") {
          if (Math.abs(Math.floor(x1 / 2) - Math.floor(x2 / 2)) > 0) {
            sortedDistance = x1p;
            blockDistance = x1;
          } else {
            const [scx, scy] = sb.getCentroid();
            const [bcx, bcy] = block.getCentroid();
            sortedDistance = scx ** 2 + scy ** 2;
            blockDistance = bcx ** 2 + bcy ** 2;
          }
        } else {
          if (Math.abs(x1 - x2) > 0) {
            sortedDistance = -x2p;
            blockDistance = -x2;
          } else {
            const [scx, scy] = sb.getCentroid();
            const [bcx, bcy] = block.getCentroid();
            sortedDistance = scx ** 2 + scy ** 2;
            blockDistance = bcx ** 2 + bcy ** 2;
          }
        }
      }

      if (blockDistance > sortedDistance) {
        nearestIdx = si + 1;
        if (si < sortedBlocks.length - 1 && isVisionOrTitle) {
          const [segStart] = getSegFlag(
            sortedBlocks[si + 1],
            sortedBlocks[si]
          );
          if (!segStart) nearestIdx++;
        }
      } else {
        if (si > 0 && isVisionOrTitle) {
          const [segStart] = getSegFlag(
            sortedBlocks[si],
            sortedBlocks[si - 1]
          );
          if (!segStart) nearestIdx = si - 1;
        }
      }
    }
  }
  sortedBlocks.splice(nearestIdx, 0, block);
  return sortedBlocks;
}

function insertChildBlocks(block, blockIdx, sortedBlocks) {
  if (block.child_blocks && block.child_blocks.length > 0) {
    const subBlocks = block.getChildBlocks();
    subBlocks.push(block);
    const sorted = sortChildBlocks(subBlocks, subBlocks[0].direction);
    sortedBlocks[blockIdx] = sorted[0];
    let idx = blockIdx;
    for (let i = 1; i < sorted.length; i++) {
      idx++;
      sortedBlocks.splice(idx, 0, sorted[i]);
    }
  }
  return sortedBlocks;
}

function sortChildBlocks(blocks, direction = "horizontal") {
  if (blocks[0].label !== "region") {
    if (direction === "horizontal") {
      blocks.sort((a, b) => {
        const dy = a.bbox[1] - b.bbox[1];
        if (dy !== 0) return dy;
        const dx = a.bbox[0] - b.bbox[0];
        if (dx !== 0) return dx;
        const [acx, acy] = a.getCentroid();
        const [bcx, bcy] = b.getCentroid();
        return acx ** 2 + acy ** 2 - (bcx ** 2 + bcy ** 2);
      });
    } else {
      blocks.sort((a, b) => {
        const d = -a.bbox[2] - -b.bbox[2];
        if (d !== 0) return d;
        const dy = a.bbox[1] - b.bbox[1];
        if (dy !== 0) return dy;
        const [acx, acy] = a.getCentroid();
        const [bcx, bcy] = b.getCentroid();
        return -(acx ** 2) + acy ** 2 - (-(bcx ** 2) + bcy ** 2);
      });
    }
  } else {
    blocks.sort((a, b) => a.euclidean_distance - b.euclidean_distance);
  }
  return blocks;
}

function _getWeights(label, direction = "horizontal") {
  if (label === "doc_title") {
    return direction === "horizontal" ? [1, 0.1, 0.1, 1] : [0.2, 0.1, 1, 1];
  } else if (
    ["paragraph_title", "table_title", "abstract", "image", "seal", "chart", "figure"].includes(label)
  ) {
    return [1, 1, 0.1, 1];
  } else {
    return [1, 1, 1, 0.1];
  }
}

function _manhattanDistance(p1, p2, weightX = 1, weightY = 1) {
  return weightX * Math.abs(p1[0] - p2[0]) + weightY * Math.abs(p1[1] - p2[1]);
}

function sortNormalBlocks(blocks, textLineHeight, textLineWidth, regionDirection) {
  if (regionDirection === "horizontal") {
    blocks.sort((a, b) => {
      const ra = Math.floor(a.bbox[1] / textLineHeight);
      const rb = Math.floor(b.bbox[1] / textLineHeight);
      if (ra !== rb) return ra - rb;
      const rax = Math.floor(a.bbox[0] / textLineWidth);
      const rbx = Math.floor(b.bbox[0] / textLineWidth);
      if (rax !== rbx) return rax - rbx;
      const [acx, acy] = a.getCentroid();
      const [bcx, bcy] = b.getCentroid();
      return acx ** 2 + acy ** 2 - (bcx ** 2 + bcy ** 2);
    });
  } else {
    blocks.sort((a, b) => {
      const ra = Math.floor(-a.bbox[2] / textLineWidth);
      const rb = Math.floor(-b.bbox[2] / textLineWidth);
      if (ra !== rb) return ra - rb;
      const ray = Math.floor(a.bbox[1] / textLineHeight);
      const rby = Math.floor(b.bbox[1] / textLineHeight);
      if (ray !== rby) return ray - rby;
      const [acx, acy] = a.getCentroid();
      const [bcx, bcy] = b.getCentroid();
      return -(acx ** 2) + acy ** 2 - (-(bcx ** 2) + bcy ** 2);
    });
  }
  return blocks;
}

function getCutBlocks(blocks, cutDirection, cutCoordinates, maskLabels = []) {
  const cutAxis = cutDirection === "horizontal" ? 0 : 1;
  const bSorted = [...blocks].sort((a, b) => a.bbox[cutAxis + 2] - b.bbox[cutAxis + 2]);

  const coords = [...new Set([...cutCoordinates, Infinity])].sort(
    (a, b) => a - b
  );
  const cutedList = [];
  let cutIdx = 0;

  for (const coord of coords) {
    const groupBlocks = [];
    let bi = cutIdx;
    while (bi < bSorted.length) {
      const block = bSorted[bi];
      if (block.bbox[cutAxis + 2] > coord) break;
      if (!maskLabels.includes(block.order_label)) groupBlocks.push(block);
      bi++;
    }
    cutIdx = bi;
    if (groupBlocks.length > 0) cutedList.push(groupBlocks);
  }
  return cutedList;
}

function getBlocksByDirectionInterval(blocks, startIndex, endIndex, direction = "horizontal") {
  const axis = direction === "horizontal" ? 0 : 1;
  const bSorted = [...blocks].sort((a, b) => a.bbox[axis + 2] - b.bbox[axis + 2]);
  return bSorted.filter(
    (b) => b.bbox[axis] >= startIndex && b.bbox[axis + 2] <= endIndex
  );
}

function getNearestBlocks(block, refBlocks, overlapThreshold, direction = "horizontal") {
  const prevBlocks = [], postBlocks = [];
  const sortIndex = direction === "horizontal" ? 1 : 0;
  for (const ref of refBlocks) {
    if (ref.index === block.index) continue;
    const overlap = calculateProjectionOverlapRatio(
      block.bbox, ref.bbox, direction, "small"
    );
    if (overlap > overlapThreshold) {
      if (ref.bbox[sortIndex] <= block.bbox[sortIndex]) {
        prevBlocks.push(ref);
      } else {
        postBlocks.push(ref);
      }
    }
  }
  prevBlocks.sort((a, b) => b.bbox[sortIndex] - a.bbox[sortIndex]);
  postBlocks.sort((a, b) => a.bbox[sortIndex] - b.bbox[sortIndex]);
  return [prevBlocks, postBlocks];
}

// ─────────────────────────────────────────────────────────────
// Child block updaters
// ─────────────────────────────────────────────────────────────

function updateDocTitleChildBlocks(block, region) {
  const refBlocks = region.normal_text_block_idxes.map(
    (idx) => region.block_map[idx]
  );
  const threshold = XYCUT_SETTINGS.child_block_overlap_ratio_threshold;
  const [prevBlocks, postBlocks] = getNearestBlocks(
    block, refBlocks, threshold, block.direction
  );

  for (const ref of [prevBlocks[0], postBlocks[0]]) {
    if (!ref) continue;
    const sameDir = ref.direction === block.direction;
    const shortOk = ref.short_side_length < block.short_side_length * 0.8;
    const longOk =
      ref.long_side_length < block.long_side_length ||
      ref.long_side_length > 1.5 * block.long_side_length;
    const edgeDist = getNearestEdgeDistance(block.bbox, ref.bbox);
    if (
      sameDir &&
      BLOCK_LABEL_MAP.text_labels.includes(ref.label) &&
      shortOk &&
      longOk &&
      ref.num_of_lines < 3 &&
      edgeDist < ref.text_line_height * 2
    ) {
      ref.order_label = "doc_title_text";
      block.appendChildBlock(ref);
      const pos = region.normal_text_block_idxes.indexOf(ref.index);
      if (pos !== -1) region.normal_text_block_idxes.splice(pos, 1);
    }
  }

  for (const ref of refBlocks) {
    if (ref.order_label === "doc_title_text") continue;
    const sameDir = ref.direction === block.direction;
    const overlap = calculateOverlapRatio(block.bbox, ref.bbox, "small");
    if (overlap > 0.9 && sameDir) {
      ref.order_label = "doc_title_text";
      block.appendChildBlock(ref);
      const pos = region.normal_text_block_idxes.indexOf(ref.index);
      if (pos !== -1) region.normal_text_block_idxes.splice(pos, 1);
    }
  }
}

function updateParagraphTitleChildBlocks(block, region) {
  if (block.order_label === "sub_paragraph_title") return;
  const refIdxes = [
    ...region.paragraph_title_block_idxes,
    ...region.normal_text_block_idxes,
  ];
  const refBlocks = refIdxes.map((idx) => region.block_map[idx]);
  const threshold = XYCUT_SETTINGS.child_block_overlap_ratio_threshold;
  const [prevBlocks, postBlocks] = getNearestBlocks(
    block, refBlocks, threshold, block.direction
  );

  for (const group of [prevBlocks, postBlocks]) {
    for (const ref of group) {
      if (!BLOCK_LABEL_MAP.paragraph_title_labels.includes(ref.label)) break;
      const minTLH = Math.min(block.text_line_height, ref.text_line_height);
      const edgeDist = getNearestEdgeDistance(block.bbox, ref.bbox);
      const sameDir = ref.direction === block.direction;
      const sameStart =
        Math.abs(ref.start_coordinate - block.start_coordinate) < minTLH * 2;
      if (sameDir && sameStart && edgeDist <= minTLH * 1.5) {
        ref.order_label = "sub_paragraph_title";
        block.appendChildBlock(ref);
        const pos = region.paragraph_title_block_idxes.indexOf(ref.index);
        if (pos !== -1) region.paragraph_title_block_idxes.splice(pos, 1);
      }
    }
  }
}

function updateVisionChildBlocks(block, region) {
  const refIdxes = [
    ...region.normal_text_block_idxes,
    ...region.vision_title_block_idxes,
  ];
  const refBlocks = refIdxes.map((idx) => region.block_map[idx]);
  const threshold = XYCUT_SETTINGS.child_block_overlap_ratio_threshold;

  let hasVisionFootnote = false;
  let hasVisionTitle = false;

  for (const direction of [block.direction, block.secondary_direction]) {
    const [prevBlocks, postBlocks] = getNearestBlocks(
      block, refBlocks, threshold, direction
    );

    const processGroup = (group, isPrev) => {
      for (const ref of group) {
        if (
          hasVisionFootnote &&
          BLOCK_LABEL_MAP.text_labels.includes(ref.label)
        ) break;

        const edgeDist = getNearestEdgeDistance(block.bbox, ref.bbox);
        const [bcx, bcy] = block.getCentroid();
        const [rcx, rcy] = ref.getCentroid();

        if (
          BLOCK_LABEL_MAP.vision_title_labels.includes(ref.label) &&
          edgeDist <= ref.text_line_height * 2
        ) {
          hasVisionTitle = true;
          ref.order_label = "vision_title";
          block.appendChildBlock(ref);
          const pos = region.vision_title_block_idxes.indexOf(ref.index);
          if (pos !== -1) region.vision_title_block_idxes.splice(pos, 1);
        }

        if (BLOCK_LABEL_MAP.text_labels.includes(ref.label)) {
          if (
            !hasVisionFootnote &&
            ref.direction === block.direction &&
            ref.long_side_length < block.long_side_length &&
            edgeDist <= ref.text_line_height * 2
          ) {
            const centerClose = Math.abs(bcx - rcx) < 10;
            const leftAligned = block.bbox[0] - ref.bbox[0] < 10 && ref.num_of_lines === 1;
            const rightAligned = block.bbox[2] - ref.bbox[2] < 10 && ref.num_of_lines === 1;
            if (
              (ref.short_side_length < block.short_side_length &&
               ref.long_side_length < 0.5 * block.long_side_length &&
               centerClose) ||
              leftAligned ||
              rightAligned
            ) {
              hasVisionFootnote = true;
              ref.order_label = "vision_footnote";
              if (!isPrev) {
                ref.label = "vision_footnote";
              }
              block.appendChildBlock(ref);
              const pos = region.normal_text_block_idxes.indexOf(ref.index);
              if (pos !== -1) region.normal_text_block_idxes.splice(pos, 1);
            }
          }
          break;
        }
      }
    };

    processGroup(prevBlocks, true);
    processGroup(postBlocks, false);
    if (hasVisionTitle) break;
  }

  // overlap fallback
  for (const ref of refBlocks) {
    if (!region.normal_text_block_idxes.includes(ref.index)) continue;
    const overlap = calculateOverlapRatio(block.bbox, ref.bbox, "small");
    if (overlap > 0.9) {
      ref.label = "vision_footnote";
      ref.order_label = "vision_footnote";
      block.appendChildBlock(ref);
      const pos = region.normal_text_block_idxes.indexOf(ref.index);
      if (pos !== -1) region.normal_text_block_idxes.splice(pos, 1);
    }
  }
}

function updateRegionChildBlocks(block, region) {
  for (const ref of Object.values(region.block_map)) {
    if (ref.index === block.index) continue;
    const iou = calculateOverlapRatio(block.bbox, ref.bbox);
    if (iou > 0 && block.area > ref.area && ref.order_label !== "sub_region") {
      ref.order_label = "sub_region";
      block.appendChildBlock(ref);
      const pos = region.normal_text_block_idxes.indexOf(ref.index);
      if (pos !== -1) region.normal_text_block_idxes.splice(pos, 1);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Projection analysis
// ─────────────────────────────────────────────────────────────

/**
 * Calculate merged intervals (discontinuous projection).
 * @param {number[][]} boxes
 * @param {"horizontal"|"vertical"} direction
 * @param {boolean} returnNum
 * @returns {Array<[number,number]>|[Array<[number,number]>, number[]]}
 */
function calculateDiscontinuousProjection(boxes, direction = "horizontal", returnNum = false) {
  if (!boxes || boxes.length === 0) {
    return returnNum ? [[], []] : [];
  }
  const axisStart = direction === "horizontal" ? 0 : 1;
  const axisEnd = direction === "horizontal" ? 2 : 3;

  const intervals = boxes
    .map((b) => [b[axisStart], b[axisEnd]])
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  const numList = [];
  let [curStart, curEnd] = intervals[0];
  let count = 1;

  for (let i = 1; i < intervals.length; i++) {
    const [start, end] = intervals[i];
    if (start <= curEnd) {
      count++;
      curEnd = Math.max(curEnd, end);
    } else {
      numList.push(count);
      merged.push([curStart, curEnd]);
      count = 1;
      [curStart, curEnd] = [start, end];
    }
  }
  numList.push(count);
  merged.push([curStart, curEnd]);

  return returnNum ? [merged, numList] : merged;
}

/**
 * Shrink overlapping boxes to eliminate overlap along specified direction.
 */
function shrinkOverlappingBoxes(boxes, direction = "horizontal", minThreshold = 0, maxThreshold = 0.1) {
  if (boxes.length <= 1) return boxes;
  let curBlock = boxes[0];
  for (let i = 1; i < boxes.length; i++) {
    const block = boxes[i];
    const [x1, y1, x2, y2] = curBlock.bbox;
    const [x1p, y1p, x2p, y2p] = block.bbox;
    const cutIou = calculateProjectionOverlapRatio(
      curBlock.bbox, block.bbox, direction
    );
    const matchDir = direction === "vertical" ? "horizontal" : "vertical";
    const matchIou = calculateProjectionOverlapRatio(
      curBlock.bbox, block.bbox, matchDir
    );

    if (direction === "vertical") {
      if (
        (matchIou > 0 && cutIou > minThreshold && cutIou < maxThreshold) ||
        y2 === y1p ||
        Math.abs(y2 - y1p) <= 3
      ) {
        const overlapYMin = Math.max(y1, y1p);
        const overlapYMax = Math.min(y2, y2p);
        const splitY = Math.floor((overlapYMin + overlapYMax) / 2);
        if (y1 < y1p) {
          curBlock.bbox = [x1, y1, x2, splitY - 1];
          block.bbox = [x1p, splitY + 1, x2p, y2p];
        } else {
          curBlock.bbox = [x1, splitY - 1, x2, y2];
          block.bbox = [x1p, y1p, x2p, splitY + 1];
        }
      }
    } else {
      if (
        (matchIou > 0 && cutIou > minThreshold && cutIou < maxThreshold) ||
        x2 === x1p ||
        Math.abs(x2 - x1p) <= 3
      ) {
        const overlapXMin = Math.max(x1, x1p);
        const overlapXMax = Math.min(x2, x2p);
        const splitX = Math.floor((overlapXMin + overlapXMax) / 2);
        if (x1 < x1p) {
          curBlock.bbox = [x1, y1, splitX - 1, y2];
          block.bbox = [splitX + 1, y1p, x2p, y2p];
        } else {
          curBlock.bbox = [splitX - 1, y1, x2, y2];
          block.bbox = [x1p, y1p, splitX + 1, y2p];
        }
      }
    }
    curBlock = block;
  }
  return boxes;
}

/**
 * Find local minima flat regions in array.
 * @param {number[]|Int32Array} arr
 * @returns {Array<[number,number]>|null}
 */
function findLocalMinimaFlatRegions(arr) {
  const n = arr.length;
  if (n === 0) return [];
  const flatRegions = [];
  let start = 0;

  for (let i = 1; i < n; i++) {
    if (arr[i] !== arr[i - 1]) {
      if (
        (start === 0 || arr[start - 1] > arr[start]) &&
        (i >= n || arr[i] > arr[start])
      ) {
        flatRegions.push([start, i - 1]);
      }
      start = i;
    }
  }
  return flatRegions.length > 1 ? flatRegions.slice(1) : null;
}
