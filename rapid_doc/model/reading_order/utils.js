// Copyright (c) Opendatalab. All rights reserved.

// ─────────────────────────────────────────────────────────────
// Standalone geometry helpers (operate on plain [x1,y1,x2,y2] arrays)
// ─────────────────────────────────────────────────────────────

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
 * Calculate overlap ratio between two bounding boxes.
 * @param {number[]} bbox1 [x1,y1,x2,y2]
 * @param {number[]} bbox2 [x1,y1,x2,y2]
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
  if (mode === "union") refArea = area1 + area2 - interArea;
  else if (mode === "small") refArea = Math.min(area1, area2);
  else if (mode === "large") refArea = Math.max(area1, area2);
  else throw new Error(`[ReadingOrderUtils] Invalid overlap mode: "${mode}". Expected "union", "small", or "large".`);

  return refArea === 0 ? 0.0 : interArea / refArea;
}

/**
 * Returns 1 to drop bbox1, 2 to drop bbox2, or null if no overlap exceeds ratio.
 * @param {number[]} bbox1 [x1,y1,x2,y2]
 * @param {number[]} bbox2 [x1,y1,x2,y2]
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
 * Remove overlapping bounding boxes.
 * @param {number[][]} bboxes List of [x1,y1,x2,y2]
 * @param {number} threshold
 * @param {boolean} smaller Drop the smaller box when true
 * @returns {[number[][], number[][]]} [updatedBboxes, droppedBoxes]
 */
export function removeOverlapBlocks(bboxes, threshold = 0.65, smaller = true) {
  if (!bboxes || bboxes.length === 0) return [[], []];

  const dropped = new Set();
  const copy = bboxes.map((b) => [...b]);
  const droppedBoxes = [];

  for (let i = 0; i < copy.length; i++) {
    for (let j = i + 1; j < copy.length; j++) {
      if (dropped.has(i) || dropped.has(j)) continue;
      const flag = _getMinboxIfOverlapByRatio(copy[i], copy[j], threshold, smaller);
      if (flag !== null) {
        dropped.add(flag === 1 ? i : j);
      }
    }
  }

  const sortedDropped = [...dropped].sort((a, b) => b - a);
  for (const idx of sortedDropped) {
    droppedBoxes.push(copy[idx]);
    copy.splice(idx, 1);
  }

  return [copy, droppedBoxes];
}
