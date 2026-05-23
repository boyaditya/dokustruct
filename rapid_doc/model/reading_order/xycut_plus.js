// Copyright (c) Opendatalab. All rights reserved.

import { intTrunc } from '../../utils/math_utils.js';

// ─────────────────────────────────────────────────────────────
// Low-level projection helpers (plain [x1,y1,x2,y2] arrays)
// ─────────────────────────────────────────────────────────────

/**
 * Generate a 1-D projection histogram from bounding boxes along one axis.
 * @param {number[][]} boxes  [[x1,y1,x2,y2], ...]
 * @param {0|1} axis  0 = x-axis (columns), 1 = y-axis (rows)
 * @returns {Int32Array}
 */
export function projectionByBboxes(boxes, axis) {
  if (!boxes || !boxes.length) return new Int32Array(0);

  let minVal = Infinity;
  let maxVal = -Infinity;
  for (const box of boxes) {
    const a = box[axis];
    const b = box[axis + 2];
    if (a < minVal) minVal = a;
    if (b < minVal) minVal = b;
    if (a > maxVal) maxVal = a;
    if (b > maxVal) maxVal = b;
  }

  const maxLength = minVal < 0 ? Math.abs(minVal) : maxVal;
  if (maxLength <= 0) return new Int32Array(0);

  const projection = new Int32Array(maxLength);
  for (const box of boxes) {
    // FIX R6/R11: removed swap [start, end] — matches Python (no swap in Python baseline)
    let start = Math.abs(Math.round(box[axis]));
    let end = Math.abs(Math.round(box[axis + 2]));
    start = Math.max(0, start);
    end = Math.min(maxLength, end);
    for (let k = start; k < end; k++) projection[k]++;
  }
  return projection;
}

/**
 * Split a projection histogram into segments.
 * @param {Int32Array|number[]} arr
 * @param {number} minValue  Only indices with arr[i] > minValue are significant
 * @param {number} minGap    Minimum gap width between segments
 * @returns {[number[], number[]]|null} [starts, ends] or null
 */
export function splitProjectionProfile(arr, minValue, minGap) {
  const significant = [];
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > minValue) significant.push(i);
  }
  if (!significant.length) return null;

  const starts = [significant[0]];
  const ends = [];
  for (let k = 1; k < significant.length; k++) {
    if (significant[k] - significant[k - 1] > minGap) {
      ends.push(significant[k - 1]);
      starts.push(significant[k]);
    }
  }
  ends.push(significant[significant.length - 1] + 1);

  return [starts, ends];
}

// ─────────────────────────────────────────────────────────────
// Recursive XY-cut / YX-cut
// ─────────────────────────────────────────────────────────────

/**
 * Y-first recursive cut.  Modifies `res` in-place.
 * @param {number[][]} boxes
 * @param {number[]} indices
 * @param {number[]} res
 * @param {number} minGap
 */
export function recursiveYxCut(boxes, indices, res, minGap = 1) {
  if (!boxes.length) return;

  // Sort by y_min
  const order = Array.from({ length: boxes.length }, (_, i) => i).sort(
    (a, b) => boxes[a][1] - boxes[b][1]
  );
  const ySortedBoxes = order.map((i) => boxes[i]);
  const ySortedIndices = order.map((i) => indices[i]);

  const yProj = projectionByBboxes(ySortedBoxes, 1);
  const yIntervals = splitProjectionProfile(yProj, 0, 1);
  if (!yIntervals) return;

  const [yStarts, yEnds] = yIntervals;
  for (let si = 0; si < yStarts.length; si++) {
    const yStart = yStarts[si];
    const yEnd = yEnds[si];

    // Select boxes in y-interval
    const yMask = ySortedBoxes.map((b) => b[1] >= yStart && b[1] < yEnd);
    const yBoxesChunk = ySortedBoxes.filter((_, k) => yMask[k]);
    const yIdxChunk = ySortedIndices.filter((_, k) => yMask[k]);

    // Sort by x_min
    const xOrder = Array.from({ length: yBoxesChunk.length }, (_, i) => i).sort(
      (a, b) => yBoxesChunk[a][0] - yBoxesChunk[b][0]
    );
    const xSortedBoxes = xOrder.map((i) => yBoxesChunk[i]);
    const xSortedIndices = xOrder.map((i) => yIdxChunk[i]);

    const xProj = projectionByBboxes(xSortedBoxes, 0);
    const xIntervals = splitProjectionProfile(xProj, 0, minGap);
    if (!xIntervals) continue;

    const [xStarts, xEnds] = xIntervals;

    if (xStarts.length === 1) {
      res.push(...xSortedIndices);
      continue;
    }

    // Handle negative x
    const hasNegX = xSortedBoxes.some((b) => b[0] < 0);
    const finalXStarts = hasNegX ? [...xStarts].reverse() : xStarts;
    const finalXEnds = hasNegX ? [...xEnds].reverse() : xEnds;

    for (let xi = 0; xi < finalXStarts.length; xi++) {
      const xStart = finalXStarts[xi];
      const xEnd = finalXEnds[xi];
      const xMask = xSortedBoxes.map((b) => Math.abs(b[0]) >= xStart && Math.abs(b[0]) < xEnd);
      recursiveYxCut(
        xSortedBoxes.filter((_, k) => xMask[k]),
        xSortedIndices.filter((_, k) => xMask[k]),
        res
      );
    }
  }
}

/**
 * X-first recursive cut.  Modifies `res` in-place.
 * @param {number[][]} boxes
 * @param {number[]} indices
 * @param {number[]} res
 * @param {number} minGap
 */
export function recursiveXyCut(boxes, indices, res, minGap = 1) {
  if (!boxes.length) return;

  // Sort by x_min
  const order = Array.from({ length: boxes.length }, (_, i) => i).sort(
    (a, b) => boxes[a][0] - boxes[b][0]
  );
  const xSortedBoxes = order.map((i) => boxes[i]);
  const xSortedIndices = order.map((i) => indices[i]);

  const xProj = projectionByBboxes(xSortedBoxes, 0);
  const xIntervals = splitProjectionProfile(xProj, 0, 1);
  if (!xIntervals) return;

  const [xStarts, xEnds] = xIntervals;

  const hasNegX = xSortedBoxes.some((b) => b[0] < 0);
  const finalXStarts = hasNegX ? [...xStarts].reverse() : xStarts;
  const finalXEnds = hasNegX ? [...xEnds].reverse() : xEnds;

  for (let xi = 0; xi < finalXStarts.length; xi++) {
    const xStart = finalXStarts[xi];
    const xEnd = finalXEnds[xi];

    const xMask = xSortedBoxes.map((b) => Math.abs(b[0]) >= xStart && Math.abs(b[0]) < xEnd);
    const xBoxesChunk = xSortedBoxes.filter((_, k) => xMask[k]);
    const xIdxChunk = xSortedIndices.filter((_, k) => xMask[k]);

    // Sort by y_min
    const yOrder = Array.from({ length: xBoxesChunk.length }, (_, i) => i).sort(
      (a, b) => xBoxesChunk[a][1] - xBoxesChunk[b][1]
    );
    const ySortedBoxes = yOrder.map((i) => xBoxesChunk[i]);
    const ySortedIndices = yOrder.map((i) => xIdxChunk[i]);

    const yProj = projectionByBboxes(ySortedBoxes, 1);
    const yIntervals = splitProjectionProfile(yProj, 0, minGap);
    if (!yIntervals) continue;

    const [yStarts, yEnds] = yIntervals;

    if (yStarts.length === 1) {
      res.push(...ySortedIndices);
      continue;
    }

    for (let yi = 0; yi < yStarts.length; yi++) {
      const yStart = yStarts[yi];
      const yEnd = yEnds[yi];
      const yMask = ySortedBoxes.map((b) => b[1] >= yStart && b[1] < yEnd);
      recursiveXyCut(
        ySortedBoxes.filter((_, k) => yMask[k]),
        ySortedIndices.filter((_, k) => yMask[k]),
        res
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Direction helpers
// ─────────────────────────────────────────────────────────────

/**
 * Determine bbox direction based on aspect ratio.
 * @param {number} width
 * @param {number} height
 * @param {number} directionRatio  Default 1.0
 * @returns {"horizontal"|"vertical"}
 */
export function getBboxDirection(width, height, directionRatio = 1.0) {
  return width * directionRatio >= height ? "horizontal" : "vertical";
}

/**
 * Determine dominant text-line direction from a list of bboxes.
 * @param {number[][]} bboxes  [[x1,y1,x2,y2], ...]
 * @param {number} directionRatio  Default 1.5
 * @returns {"horizontal"|"vertical"}
 */
export function calculateTextLineDirection(bboxes, directionRatio = 1.5) {
  if (!bboxes.length) return "horizontal";
  let horizontalCount = 0;
  for (const bbox of bboxes) {
    const [x1, y1, x2, y2] = bbox;
    const w = x2 - x1;
    const h = y2 - y1;
    if (w * directionRatio >= h) horizontalCount++;
  }
  return horizontalCount >= bboxes.length * 0.5 ? "horizontal" : "vertical";
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Sort bounding boxes using recursive XY-cut.
 * @param {number[][]} blockBboxes  [[x1,y1,x2,y2], ...]
 * @param {"horizontal"|"vertical"} direction
 * @param {number} minGap
 * @returns {number[]}  Sorted indices into blockBboxes
 */
export function sortByXycut(blockBboxes, direction = "vertical", minGap = 1) {
  if (!blockBboxes.length) return [];
  // FIX R5/R7/R8/R9: intTrunc matches Python int() truncation
  const intBoxes = blockBboxes.map((b) => b.map(intTrunc));
  const indices = Array.from({ length: intBoxes.length }, (_, i) => i);
  const res = [];
  if (direction === "vertical") {
    recursiveYxCut(intBoxes, indices, res, minGap);
  } else {
    recursiveXyCut(intBoxes, indices, res, minGap);
  }
  return res;
}

/**
 * Sort layout detection bboxes by reading order.
 *
 * Main public API — mirrors Python `xycut_plus_sort`.
 *
 * @param {number[][]} bboxes  [[x1,y1,x2,y2], ...]
 * @param {"horizontal"|"vertical"|null} direction
 *   If null, direction is inferred from the bboxes themselves.
 * @returns {number[]}  Sorted indices (integers) into the input array
 */
export function xycutPlusSort(bboxes, direction = null) {
  if (!bboxes || !bboxes.length) return [];

  const dir = direction ?? calculateTextLineDirection(bboxes);
  const sorted = sortByXycut(bboxes, dir);
  return sorted.map(Number);
}
