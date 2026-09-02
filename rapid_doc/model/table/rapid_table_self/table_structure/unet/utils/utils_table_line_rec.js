// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table_structure/unet/utils/utils_table_line_rec.py → utils_table_line_rec.js

import { labelConnectedComponents, getAllRegionBboxes } from "./utils.js";

/**
 * Distance between two points.
 */
function _dist(p1, p2) {
  return Math.sqrt((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2);
}

/**
 * Fit a line equation Ax + By + C = 0 from two points.
 */
function fitLine(p) {
  const x1 = p[0][0], y1 = p[0][1];
  const x2 = p[1][0], y2 = p[1][1];
  const A = y2 - y1;
  const B = x1 - x2;
  const C = x2 * y1 - x1 * y2;
  return [A, B, C];
}

/**
 * Determine point-line relationship.
 */
function pointLineCor(p, A, B, C) {
  return A * p[0] + B * p[1] + C;
}

/**
 * Extract horizontal or vertical table lines using connected components.
 */
export function getTableLine(binImg, width, _height, axis = 0, lineMinSize = 10) {
  const { labels, numComponents } = labelConnectedComponents(binImg, width, _height, 8);
  if (numComponents === 0) return [];
  const bboxes = getAllRegionBboxes(labels, numComponents, width, _height);
  const lines = [];

  for (let l = 1; l <= numComponents; l++) {
    const bbox = bboxes[l-1];
    if (!bbox) continue;
    // axis 1: vertical (height > lineMinSize), axis 0: horizontal (width > lineMinSize)
    if (axis === 1) {
      if (bbox[3] - bbox[1] > lineMinSize) lines.push(minAreaRectLine(labels, l, width, _height));
    } else {
      if (bbox[2] - bbox[0] > lineMinSize) lines.push(minAreaRectLine(labels, l, width, _height));
    }
  }
  return lines.filter(x => x !== null);
}

function minAreaRectLine(labels, targetLabel, width, _height) {
  const coords = [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === targetLabel) coords.push(i % width, (i / width) | 0);
  }
  const _cv = typeof cv !== "undefined" ? cv : (globalThis.cv || null);
  if (!_cv) return null;
  const mat = _cv.matFromArray(coords.length / 2, 1, _cv.CV_32SC2, coords);
  const rect = _cv.minAreaRect(mat);
  mat.delete();
  const pts = _cv.boxPoints(rect);
  let box = [];
  if (pts.data32F) {
    box = Array.from(pts.data32F);
  } else if (pts.rows !== undefined) {
    for (let i = 0; i < pts.rows; i++) {
      for (let j = 0; j < pts.cols; j++) {
        box.push(pts.floatAt(i, j));
      }
    }
  } else if (Array.isArray(pts)) {
    // boxPoints returned an array of points [{x,y}, ...]
    for (const p of pts) box.push(p.x, p.y);
  }

  if (pts && typeof pts.delete === 'function') {
    pts.delete();
  }
  
  const sorted = imageLocationSortBox(box);
  const [x1, y1, x2, y2, x3, y3, x4, y4] = sorted;
  const w = Math.sqrt((x2-x1)**2 + (y2-y1)**2);
  const h = Math.sqrt((x4-x1)**2 + (y4-y1)**2);
  if (w < h) return [(x1 + x2) / 2, (y1 + y2) / 2, (x3 + x4) / 2, (y3 + y4) / 2];
  else return [(x1 + x4) / 2, (y1 + y4) / 2, (x2 + x3) / 2, (y2 + y3) / 2];
}

export function imageLocationSortBox(box) {
  const pts = [[box[0], box[1]], [box[2], box[3]], [box[4], box[5]], [box[6], box[7]]];
  const sorted = orderPoints(pts);
  return sorted.flat();
}

function orderPoints(pts) {
  const xSorted = [...pts].sort((a, b) => a[0] - b[0]);
  let leftMost = xSorted.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const [tl, bl] = leftMost;
  const rightMost = xSorted.slice(2);
  const dists = rightMost.map(p => Math.sqrt((tl[0]-p[0])**2 + (tl[1]-p[1])**2));
  const [br, tr] = dists[0] > dists[1] ? [rightMost[0], rightMost[1]] : [rightMost[1], rightMost[0]];
  return [tl, tr, br, bl];
}

export function adjustLines(lines, alph = 50, angle = 50) {
  const newLines = [];
  for (let i = 0; i < lines.length; i++) {
    const [x1, y1, x2, y2] = lines[i];
    const cx1 = (x1 + x2) / 2, cy1 = (y1 + y2) / 2;
    for (let j = 0; j < lines.length; j++) {
      if (i === j) continue;
      const [x3, y3, x4, y4] = lines[j];
      const cx2 = (x3 + x4) / 2, cy2 = (y3 + y4) / 2;
      if ((x3 < cx1 && cx1 < x4) || (y3 < cy1 && cy1 < y4) || (x1 < cx2 && cx2 < x2) || (y1 < cy2 && cy2 < y2)) continue;
      const check = (ax, ay, bx, by) => {
        const r = Math.sqrt((ax-bx)**2 + (ay-by)**2);
        const k = Math.abs((by-ay) / (bx-ax + 1e-10)), a = Math.atan(k) * 180 / Math.PI;
        if (r < alph && a < angle) newLines.push([ax, ay, bx, by]);
      };
      check(x1, y1, x3, y3); check(x1, y1, x4, y4); check(x2, y2, x3, y3); check(x2, y2, x4, y4);
    }
  }
  return newLines;
}

export function finalAdjustLines(rowBoxes, colBoxes) {
  for (let i = 0; i < rowBoxes.length; i++) {
    for (let j = 0; j < colBoxes.length; j++) {
      rowBoxes[i] = lineToLine(rowBoxes[i], colBoxes[j], 20, 30);
      colBoxes[j] = lineToLine(colBoxes[j], rowBoxes[i], 20, 30);
    }
  }
}

function lineToLine(p1, p2, alpha, angle) {
  const [x1, y1, x2, y2] = p1, [ox1, oy1, ox2, oy2] = p2;
  const A1B1C1 = fitLine([[x1, y1], [x2, y2]]), A2B2C2 = fitLine([[ox1, oy1], [ox2, oy2]]);
  const f1 = pointLineCor([x1, y1], ...A2B2C2), f2 = pointLineCor([x2, y2], ...A2B2C2);
  if ((f1 > 0 && f2 > 0) || (f1 < 0 && f2 < 0)) {
    const det = A1B1C1[0] * A2B2C2[1] - A2B2C2[0] * A1B1C1[1];
    if (Math.abs(det) > 1e-6) {
      const x = (A1B1C1[1] * A2B2C2[2] - A2B2C2[1] * A1B1C1[2]) / det, y = (A2B2C2[0] * A1B1C1[2] - A1B1C1[0] * A2B2C2[2]) / det;
      const r0 = Math.sqrt((x-x1)**2 + (y-y1)**2), r1 = Math.sqrt((x-x2)**2 + (y-y2)**2);
      if (Math.min(r0, r1) < alpha) {
        if (r0 < r1) {
          const k = Math.abs((y2-y)/(x2-x+1e-10)), a = Math.atan(k)*180/Math.PI;
          if (a < angle || Math.abs(90-a) < angle) return [x, y, x2, y2];
        } else {
          const k = Math.abs((y1-y)/(x1-x+1e-10)), a = Math.atan(k)*180/Math.PI;
          if (a < angle || Math.abs(90-a) < angle) return [x1, y1, x, y];
        }
      }
    }
  }
  return p1;
}

export function drawLines(mat, lines) {
  const _cv = typeof cv !== "undefined" ? cv : (globalThis.cv || null);
  if (!_cv) return;
  for (const line of lines) {
    const [x1, y1, x2, y2] = line;
    _cv.line(mat, new _cv.Point(Math.round(x1), Math.round(y1)), new _cv.Point(Math.round(x2), Math.round(y2)), new _cv.Scalar(255), 2, _cv.LINE_AA);
  }
}
