// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table_structure/unet/utils/utils.py → utils.js
// Connected component labeling and table line utilities.
// skimage.measure.label → simple flood-fill connected components for browser

/**
 * Optimized connected component labeling.
 * Uses TypedArray for queue and index-based BFS to avoid object allocation.
 * @param {Uint8Array|boolean[]} mask - Binary mask (1 for foreground, 0 for background)
 * @param {number} width
 * @param {number} height
 * @param {number} connectivity - 4 or 8
 * @returns {{ labels: Int32Array, numComponents: number }}
 */
export function labelConnectedComponents(mask, width, height, connectivity = 4) {
  const size = width * height;
  const labels = new Int32Array(size);
  let nextLabel = 1;

  // Use a TypedArray as a queue for BFS to avoid millions of [r,c] allocations
  const queue = new Int32Array(size);
  
  const dr = connectivity === 8 ? [-1, -1, -1, 0, 0, 1, 1, 1] : [-1, 1, 0, 0];
  const dc = connectivity === 8 ? [-1, 0, 1, -1, 1, -1, 0, 1] : [0, 0, -1, 1];

  for (let i = 0; i < size; i++) {
    if (!mask[i] || labels[i] !== 0) continue;

    const label = nextLabel++;
    let head = 0;
    let tail = 0;

    labels[i] = label;
    queue[tail++] = i;

    while (head < tail) {
      const idx = queue[head++];
      const r = (idx / width) | 0;
      const c = idx % width;

      for (let k = 0; k < dr.length; k++) {
        const nr = r + dr[k];
        const nc = c + dc[k];

        if (nr >= 0 && nr < height && nc >= 0 && nc < width) {
          const nidx = nr * width + nc;
          if (mask[nidx] && labels[nidx] === 0) {
            labels[nidx] = label;
            queue[tail++] = nidx;
          }
        }
      }
    }
  }
  return { labels, numComponents: nextLabel - 1 };
}

/**
 * Get bounding boxes for all labeled regions in a single pass.
 * @param {Int32Array} labels
 * @param {number} numComponents
 * @param {number} width
 * @param {number} height
 * @returns {Array<[number,number,number,number]|null>} Array of [x0,y0,x1,y1]
 */
export function getAllRegionBboxes(labels, numComponents, width, height) {
  const bboxes = Array.from({ length: numComponents + 1 }, () => [Infinity, Infinity, -Infinity, -Infinity]);
  const size = width * height;

  for (let i = 0; i < size; i++) {
    const l = labels[i];
    if (l === 0) continue;

    const r = (i / width) | 0;
    const c = i % width;
    const bbox = bboxes[l];

    if (c < bbox[0]) bbox[0] = c;
    if (r < bbox[1]) bbox[1] = r;
    if (c > bbox[2]) bbox[2] = c;
    if (r > bbox[3]) bbox[3] = r;
  }

  return bboxes.slice(1).map(b => b[0] === Infinity ? null : b);
}
