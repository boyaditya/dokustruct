// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: boxbase.py → boxbase.js
 *
 * Direct translation of pure geometric utility functions.
 * Python numpy removed (plain arithmetic).
 * cv2.rotate kept as cv calls in rotate_image.
 * merge_adjacent_bboxes: np.mean() → average utility.
 */

/**
 * Returns true if box1 is completely inside box2.
 * @param {number[]} box1 [x0,y0,x1,y1]
 * @param {number[]} box2 [x0,y0,x1,y1]
 * @returns {boolean}
 */
export function isIn(box1, box2) {
  const [x0_1, y0_1, x1_1, y1_1] = box1;
  const [x0_2, y0_2, x1_2, y1_2] = box2;
  return x0_1 >= x0_2 && y0_1 >= y0_2 && x1_1 <= x1_2 && y1_1 <= y1_2;
}

/**
 * Determine relative position of bbox1 with respect to bbox2.
 * @param {number[]} bbox1
 * @param {number[]} bbox2
 * @returns {[boolean, boolean, boolean, boolean]} [left, right, bottom, top]
 */
export function bboxRelativePos(bbox1, bbox2) {
  const [x1, y1, x1b, y1b] = bbox1;
  const [x2, y2, x2b, y2b] = bbox2;
  return [x2b < x1, x1b < x2, y2b < y1, y1b < y2];
}

/**
 * Euclidean distance between two bounding boxes.
 * @param {number[]} bbox1
 * @param {number[]} bbox2
 * @returns {number}
 */
export function bboxDistance(bbox1, bbox2) {
  const dist = (p1, p2) => Math.sqrt((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2);
  const [x1, y1, x1b, y1b] = bbox1;
  const [x2, y2, x2b, y2b] = bbox2;
  const [left, right, bottom, top] = bboxRelativePos(bbox1, bbox2);

  if (top && left)    return dist([x1, y1b], [x2b, y2]);
  if (left && bottom) return dist([x1, y1], [x2b, y2b]);
  if (bottom && right) return dist([x1b, y1], [x2, y2b]);
  if (right && top)  return dist([x1b, y1b], [x2, y2]);
  if (left)   return x1 - x2b;
  if (right)  return x2 - x1b;
  if (bottom) return y1 - y2b;
  if (top)    return y2 - y1b;
  return 0.0;
}

/**
 * If overlap area / min-box area > ratio, return the smaller box; else null.
 * @param {number[]} bbox1
 * @param {number[]} bbox2
 * @param {number} ratio
 * @returns {number[]|null}
 */
export function getMinboxIfOverlapByRatio(bbox1, bbox2, ratio) {
  const [x1_min, y1_min, x1_max, y1_max] = bbox1;
  const [x2_min, y2_min, x2_max, y2_max] = bbox2;
  const area1 = (x1_max - x1_min) * (y1_max - y1_min);
  const area2 = (x2_max - x2_min) * (y2_max - y2_min);
  const overlapRatio = calculateOverlapArea2MinboxAreaRatio(bbox1, bbox2);
  if (overlapRatio > ratio) {
    return area1 <= area2 ? bbox1 : bbox2;
  }
  return null;
}

/**
 * Overlap area divided by the smaller of the two box areas.
 * @param {number[]} bbox1
 * @param {number[]} bbox2
 * @returns {number}
 */
export function calculateOverlapArea2MinboxAreaRatio(bbox1, bbox2) {
  const xLeft = Math.max(bbox1[0], bbox2[0]);
  const yTop  = Math.max(bbox1[1], bbox2[1]);
  const xRight  = Math.min(bbox1[2], bbox2[2]);
  const yBottom = Math.min(bbox1[3], bbox2[3]);
  if (xRight < xLeft || yBottom < yTop) return 0.0;
  const intersection = (xRight - xLeft) * (yBottom - yTop);
  const area1 = (bbox1[2] - bbox1[0]) * (bbox1[3] - bbox1[1]);
  const area2 = (bbox2[2] - bbox2[0]) * (bbox2[3] - bbox2[1]);
  const minArea = Math.min(area1, area2);
  return minArea === 0 ? 0 : intersection / minArea;
}

/**
 * Intersection over Union.
 * @param {number[]} bbox1
 * @param {number[]} bbox2
 * @returns {number}
 */
export function calculateIou(bbox1, bbox2) {
  const xLeft = Math.max(bbox1[0], bbox2[0]);
  const yTop  = Math.max(bbox1[1], bbox2[1]);
  const xRight  = Math.min(bbox1[2], bbox2[2]);
  const yBottom = Math.min(bbox1[3], bbox2[3]);
  if (xRight < xLeft || yBottom < yTop) return 0.0;
  const intersection = (xRight - xLeft) * (yBottom - yTop);
  const area1 = (bbox1[2] - bbox1[0]) * (bbox1[3] - bbox1[1]);
  const area2 = (bbox2[2] - bbox2[0]) * (bbox2[3] - bbox2[1]);
  if (area1 === 0 || area2 === 0) return 0;
  return intersection / (area1 + area2 - intersection);
}

/**
 * Overlap area of bbox1∩bbox2 divided by the area of bbox1.
 * @param {number[]} bbox1
 * @param {number[]} bbox2
 * @returns {number}
 */
export function calculateOverlapAreaInBbox1AreaRatio(bbox1, bbox2) {
  const xLeft = Math.max(bbox1[0], bbox2[0]);
  const yTop  = Math.max(bbox1[1], bbox2[1]);
  const xRight  = Math.min(bbox1[2], bbox2[2]);
  const yBottom = Math.min(bbox1[3], bbox2[3]);
  if (xRight < xLeft || yBottom < yTop) return 0.0;
  const intersection = (xRight - xLeft) * (yBottom - yTop);
  const area1 = (bbox1[2] - bbox1[0]) * (bbox1[3] - bbox1[1]);
  return area1 === 0 ? 0 : intersection / area1;
}

/**
 * Proportion of block1's x-axis projection covered by the intersection with block2.
 * @param {number[]} block1 [x0,y0,x1,y1]
 * @param {number[]} block2 [x0,y0,x1,y1]
 * @returns {number}
 */
export function calculateVerticalProjectionOverlapRatio(block1, block2) {
  const [x0_1,,x1_1] = block1;
  const [x0_2,,x1_2] = block2;
  const xLeft  = Math.max(x0_1, x0_2);
  const xRight = Math.min(x1_1, x1_2);
  if (xRight < xLeft) return 0.0;
  const intersectionLength = xRight - xLeft;
  const block1Length = x1_1 - x0_1;
  return block1Length === 0 ? 0.0 : intersectionLength / block1Length;
}

/**
 * Merge adjacent or overlapping text spans by clustering into lines.
 * PORTING NOTE: numpy mean → plain average; logic identical.
 * @param {object[]} spans
 * @param {number} [xGapRatio=0.6]
 * @param {number} [yToleranceRatio=0.8]
 * @param {boolean} [returnText=false]
 * @returns {object[]}
 */
export function mergeAdjacentBboxes(spans, xGapRatio = 0.6, yToleranceRatio = 0.8, returnText = false) {
  if (!spans.length) return [];

  // Sort by (y0, x0)
  spans = [...spans].sort((a, b) => (a.bbox[1] - b.bbox[1]) || (a.bbox[0] - b.bbox[0]));

  function avg(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }

  // Annotate center/height
  for (const s of spans) {
    s._cy = (s.bbox[1] + s.bbox[3]) / 2;
    s._h  = s.bbox[3] - s.bbox[1];
  }

  // Phase 1: vertical clustering
  const lines = [];
  for (const span of spans) {
    let assigned = false;
    for (const line of lines) {
      const avgH = avg(line.map(s => s._h));
      const lineCy = avg(line.map(s => s._cy));
      if (Math.abs(span._cy - lineCy) < avgH * yToleranceRatio) {
        line.push(span);
        assigned = true;
        break;
      }
    }
    if (!assigned) lines.push([span]);
  }

  const mergedResult = [];

  // Phase 2: horizontal merging within each line
  for (let line of lines) {
    line = [...line].sort((a, b) => a.bbox[0] - b.bbox[0]);
    let current = { ...line[0] };

    for (const span of line.slice(1)) {
      const [ax0, , ax1] = current.bbox;
      const [bx0] = span.bbox;
      const sizeA = current.font?.size ?? 10;
      const sizeB = span.font?.size ?? 10;
      const sizeAvg = (sizeA + sizeB) / 2;
      if (bx0 - ax1 <= sizeAvg * xGapRatio) {
        const x0 = Math.min(current.bbox[0], span.bbox[0]);
        const y0 = Math.min(current.bbox[1], span.bbox[1]);
        const x1 = Math.max(current.bbox[2], span.bbox[2]);
        const y1 = Math.max(current.bbox[3], span.bbox[3]);
        if (returnText) current.text = current.text.trimEnd() + span.text.trimStart();
        current.bbox = [x0, y0, x1, y1];
      } else {
        mergedResult.push(current);
        current = { ...span };
      }
    }
    mergedResult.push(current);
  }

  // Cleanup temp fields
  for (const s of mergedResult) { delete s._cy; delete s._h; }

  return mergedResult;
}

/**
 * Rotate a table image according to angle.
 * PORTING NOTE: cv2.rotate → cv.rotate (OpenCV.js)
 * @param {object} imgInfo - object with table_img (cv.Mat)
 * @param {number} angle - 0, 90, 180, or 270
 */
export function rotateImage(imgInfo, angle) {
  if (typeof cv === 'undefined') return;
  if (angle === 270) {
    const dst = new cv.Mat();
    cv.rotate(imgInfo.table_img, dst, cv.ROTATE_90_CLOCKWISE);
    imgInfo.table_img.delete();
    imgInfo.table_img = dst;
  } else if (angle === 90) {
    const dst = new cv.Mat();
    cv.rotate(imgInfo.table_img, dst, cv.ROTATE_90_COUNTERCLOCKWISE);
    imgInfo.table_img.delete();
    imgInfo.table_img = dst;
  }
  // 180 and 0 → no-op
}
