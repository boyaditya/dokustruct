// Copyright (c) RapidAI. All rights reserved.

/**
 * Normalize bbox from various formats to [x0, y0, x1, y1] integer format.
 * Handles 4-point [x0,y0,x1,y1], 8-point polygon, or 2D array of points.
 *
 * @param {number[]|number[][]|null} box - Bbox in various formats
 * @param {[number, number]|null} [imageSize=null] - [height, width] to clamp bbox
 * @returns {[number, number, number, number]|null} [x0, y0, x1, y1] or null if invalid
 */
export function normalizeToIntBbox(box, imageSize = null) {
  if (box == null) return null;
  if (!Array.isArray(box) || box.length === 0) return null;

  const flat = flattenBoxInput(box);
  if (flat === null) return null;

  let xmin, ymin, xmax, ymax;

  if (flat.length === 4) {
    [xmin, ymin, xmax, ymax] = flat;
  } else if (flat.length >= 8) {
    // 8-point polygon: extract min/max from alternating x,y pairs
    let minX = flat[0], maxX = flat[0];
    let minY = flat[1], maxY = flat[1];
    for (let i = 2; i < flat.length; i += 2) {
      if (flat[i] < minX) minX = flat[i];
      if (flat[i] > maxX) maxX = flat[i];
      if (flat[i + 1] < minY) minY = flat[i + 1];
      if (flat[i + 1] > maxY) maxY = flat[i + 1];
    }
    xmin = minX;
    ymin = minY;
    xmax = maxX;
    ymax = maxY;
  } else {
    return null;
  }

  // Floor min, ceil max
  xmin = Math.floor(xmin);
  ymin = Math.floor(ymin);
  xmax = Math.ceil(xmax);
  ymax = Math.ceil(ymax);

  // Clamp to image bounds if provided
  if (imageSize != null && Array.isArray(imageSize) && imageSize.length === 2) {
    const [height, width] = imageSize;
    xmin = Math.max(0, Math.min(width, xmin));
    ymin = Math.max(0, Math.min(height, ymin));
    xmax = Math.max(0, Math.min(width, xmax));
    ymax = Math.max(0, Math.min(height, ymax));
  }

  // Validate bbox has positive area
  if (xmax <= xmin || ymax <= ymin) return null;

  return [xmin, ymin, xmax, ymax];
}

/**
 * Convert box input (1D array, 2D array of points) to a flat numeric array.
 * Returns null if any value is non-finite (NaN, Infinity).
 * @param {number[]|number[][]} box
 * @returns {number[]|null}
 */
function flattenBoxInput(box) {
  if (Array.isArray(box[0])) {
    // 2D array: [[x0,y0], [x1,y1], ...]
    const xs = [];
    const ys = [];
    for (const p of box) {
      const x = Number(p[0]);
      const y = Number(p[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      xs.push(x);
      ys.push(y);
    }
    const xmin = Math.min(...xs);
    const ymin = Math.min(...ys);
    const xmax = Math.max(...xs);
    const ymax = Math.max(...ys);
    return [xmin, ymin, xmax, ymax];
  }

  // 1D array — convert and validate
  const flat = new Array(box.length);
  for (let i = 0; i < box.length; i++) {
    const v = Number(box[i]);
    if (!Number.isFinite(v)) return null;
    flat[i] = v;
  }
  return flat;
}
