// Copyright (c) RapidAI. All rights reserved.
/**
 * Bounding box utility functions
 * PORTING NOTE: bbox_utils.py → bbox_utils.js
 */

/**
 * Normalize bbox from various formats to [x0, y0, x1, y1] integer format.
 * Handles 4-point [x0,y0,x1,y1], 8-point polygon, or 2D array of points.
 * 
 * PORTING NOTE: normalize_to_int_bbox(box, image_size) → normalizeToIntBbox(box, imageSize)
 * 
 * @param {number[]|number[][]|null} box - Bbox in various formats
 * @param {[number, number]|null} [imageSize=null] - [height, width] to clamp bbox
 * @returns {[number, number, number, number]|null} [x0, y0, x1, y1] or null if invalid
 */
export function normalizeToIntBbox(box, imageSize = null) {
  if (box === null || box === undefined) {
    return null;
  }

  // Convert to flat array
  let flat;
  if (Array.isArray(box)) {
    if (box.length === 0) {
      return null;
    }
    
    // Check if 2D array (array of points)
    if (Array.isArray(box[0])) {
      // 2D array: [[x0,y0], [x1,y1], ...]
      const xs = box.map(p => Number(p[0]));
      const ys = box.map(p => Number(p[1]));
      
      if (xs.some(v => !Number.isFinite(v)) || ys.some(v => !Number.isFinite(v))) {
        return null;
      }
      
      const xmin = Math.min(...xs);
      const ymin = Math.min(...ys);
      const xmax = Math.max(...xs);
      const ymax = Math.max(...ys);
      
      flat = [xmin, ymin, xmax, ymax];
    } else {
      // 1D array
      flat = box.map(v => Number(v));
      
      if (flat.some(v => !Number.isFinite(v))) {
        return null;
      }
    }
  } else {
    return null;
  }

  let xmin, ymin, xmax, ymax;

  if (flat.length === 4) {
    // [x0, y0, x1, y1]
    [xmin, ymin, xmax, ymax] = flat;
  } else if (flat.length >= 8) {
    // 8-point polygon: [x0, y0, x1, y1, x2, y2, x3, y3]
    const xs = [];
    const ys = [];
    for (let i = 0; i < flat.length; i += 2) {
      xs.push(flat[i]);
      ys.push(flat[i + 1]);
    }
    xmin = Math.min(...xs);
    ymin = Math.min(...ys);
    xmax = Math.max(...xs);
    ymax = Math.max(...ys);
  } else {
    return null;
  }

  // Floor min, ceil max
  xmin = Math.floor(xmin);
  ymin = Math.floor(ymin);
  xmax = Math.ceil(xmax);
  ymax = Math.ceil(ymax);

  // Clamp to image bounds if provided
  if (imageSize !== null && Array.isArray(imageSize) && imageSize.length === 2) {
    const [height, width] = imageSize;
    xmin = Math.max(0, Math.min(width, xmin));
    ymin = Math.max(0, Math.min(height, ymin));
    xmax = Math.max(0, Math.min(width, xmax));
    ymax = Math.max(0, Math.min(height, ymax));
  }

  // Validate bbox
  if (xmax <= xmin || ymax <= ymin) {
    return null;
  }

  return [xmin, ymin, xmax, ymax];
}
