/**
 * PPPostProcess: post-processing for PP-DocLayout detection results.
 * Applies confidence filtering, NMS, containment merging, polygon extraction, and unclipping.
 *
 * BROWSER WORKAROUND: NumPy/Shapely not available; uses typed-array equivalents
 * and Sutherland-Hodgman polygon clipping (pure JS) for overlap calculations.
 * cv2 operations → OpenCV.js equivalents.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

export const SKIP_ORDER_LABELS = [
  'figure_title', 'vision_footnote', 'image', 'chart', 'table',
  'header', 'header_image', 'footer', 'footer_image',
  'footnote', 'aside_text',
];

// ─── PPPostProcess ────────────────────────────────────────────────────────────

export class PPPostProcess {
  /**
   * @param {string[]} labels
   * @param {number|Object} [confThres=0.5]
   * @param {number} [iouThres=0.5]
   * @param {Object} [options={}]
   * @param {boolean} [options.layoutNms=true]
   * @param {string|Object|null} [options.layoutMergeBboxesMode=null]
   * @param {number|number[]|Object|null} [options.layoutUnclipRatio=null]
   * @param {number[]|null} [options.scaleSize=null]
   */
  constructor(labels, confThres = 0.5, iouThres = 0.5, options = {}) {
    const {
      layoutNms = true,
      layoutMergeBboxesMode = null,
      layoutUnclipRatio = null,
      scaleSize = null,
    } = options;

    this.labels = labels;
    this.strides = [8, 16, 32, 64];
    this.confThres = confThres;
    this.iouThres = iouThres;
    this.layoutNms = layoutNms;
    this.nmsTopK = 1000;
    this.keepTopK = 100;
    this.scaleSize = scaleSize;
    this.layoutMergeBboxesMode = layoutMergeBboxesMode;
    this.layoutUnclipRatio = layoutUnclipRatio;
  }

  /**
   * Apply post-processing to raw detection boxes.
   *
   * @param {Float32Array|number[][]} boxes  - shape (N, 6|7|8): [cls_id, score, x1, y1, x2, y2, ...]
   * @param {[number, number]} imgSize       - [width, height] of the original image
   * @param {Uint8Array[]|null} [masks=null] - Per-detection binary masks (optional)
   * @param {string} [layoutShapeMode='auto']
   * @returns {Object[]} List of box dicts
   */
  call(boxes, imgSize, masks = null, layoutShapeMode = 'auto') {
    // Convert to a mutable 2-D JS array for easier manipulation
    let boxArr = toBoxArray(boxes);

    if (layoutShapeMode === 'rect') {
      masks = null;
    }

    // Round coordinates
    for (const box of boxArr) {
      for (let i = 2; i < 6; i++) box[i] = Math.round(box[i]);
    }

    // Confidence threshold filtering
    const threshold = this.confThres;
    if (typeof threshold === 'number') {
      const keep = boxArr.map((b, i) => b[1] > threshold && b[0] > -1 ? i : -1).filter(i => i >= 0);
      if (masks) masks = keep.map(i => masks[i]);
      boxArr = keep.map(i => boxArr[i]);
    } else if (threshold !== null && typeof threshold === 'object') {
      // Per-category threshold dict
      const categoryFiltered = [];
      const categoryFilteredMasks = masks ? [] : null;
      const catIds = [...new Set(boxArr.map(b => b[0]))];
      for (const catId of catIds) {
        const catBoxes = boxArr.filter(b => b[0] === catId);
        const catIndices = boxArr.map((b, i) => b[0] === catId ? i : -1).filter(i => i >= 0);
        const catThreshold = threshold[catId] ?? 0.5;
        const selected = catBoxes.map((b, j) => (b[1] > catThreshold && b[0] > -1) ? j : -1).filter(j => j >= 0);
        categoryFiltered.push(...selected.map(j => catBoxes[j]));
        if (masks) categoryFilteredMasks.push(...selected.map(j => masks[catIndices[j]]));
      }
      boxArr = categoryFiltered;
      if (masks) masks = categoryFilteredMasks;
    }

    // NMS
    if (this.layoutNms && boxArr.length > 0) {
      const selected = nms(boxArr, 0.6, 0.98);
      if (masks) masks = selected.map(i => masks[i]);
      boxArr = selected.map(i => boxArr[i]);
    }

    // Filter oversized images
    if (boxArr.length > 1 && [6, 7, 8].includes((boxArr[0] ?? []).length)) {
      const [imgW, imgH] = imgSize;
      const areaThres = imgH > imgW ? 0.82 : 0.93;
      const imageIndex = this.labels.indexOf('image');
      const imgArea = imgW * imgH;
      const filteredBoxes = [];
      const filteredMasks = [];
      for (let idx = 0; idx < boxArr.length; idx++) {
        const box = boxArr[idx];
        const labelIndex = box[0];
        if (labelIndex === imageIndex) {
          let [, , xmin, ymin, xmax, ymax] = box;
          xmin = Math.max(0, xmin); ymin = Math.max(0, ymin);
          xmax = Math.min(imgW, xmax); ymax = Math.min(imgH, ymax);
          const boxArea = (xmax - xmin) * (ymax - ymin);
          if (boxArea <= areaThres * imgArea) {
            filteredBoxes.push(box);
            if (masks) filteredMasks.push(masks[idx]);
          }
        } else {
          filteredBoxes.push(box);
          if (masks) filteredMasks.push(masks[idx]);
        }
      }
      boxArr = filteredBoxes.length ? filteredBoxes : boxArr;
      if (masks) masks = filteredMasks.length ? filteredMasks : masks;
    }

    // Merge bboxes mode
    const lmbm = this.layoutMergeBboxesMode;
    if (lmbm && boxArr.length > 0) {
      const formulaIndex = this.labels.indexOf('formula') >= 0 ? this.labels.indexOf('formula') : null;
      const applyMode = (mode, categoryIndex = null) => {
        if (mode === 'union') return; // keep all
        const [containsOther, containedByOther] = checkContainment(boxArr, formulaIndex, categoryIndex, mode);
        if (mode === 'large') {
          const keep = boxArr.map((_, i) => containedByOther[i] === 0 ? i : -1).filter(i => i >= 0);
          if (masks) masks = keep.map(i => masks[i]);
          boxArr = keep.map(i => boxArr[i]);
        } else if (mode === 'small') {
          const keep = boxArr.map((_, i) => (containsOther[i] === 0 || containedByOther[i] === 1) ? i : -1).filter(i => i >= 0);
          if (masks) masks = keep.map(i => masks[i]);
          boxArr = keep.map(i => boxArr[i]);
        }
      };

      if (typeof lmbm === 'string') {
        applyMode(lmbm);
      } else if (typeof lmbm === 'object') {
        const keepMask = new Uint8Array(boxArr.length).fill(1);
        for (const [categoryIndex, layoutMode] of Object.entries(lmbm)) {
          if (layoutMode === 'union') continue;
          const catIdx = Number(categoryIndex);
          const [containsOther, containedByOther] = checkContainment(boxArr, formulaIndex, catIdx, layoutMode);
          for (let i = 0; i < boxArr.length; i++) {
            if (layoutMode === 'large' && containedByOther[i] !== 0) keepMask[i] = 0;
            if (layoutMode === 'small' && containsOther[i] !== 0 && containedByOther[i] !== 1) keepMask[i] = 0;
          }
        }
        const keep = boxArr.map((_, i) => keepMask[i] ? i : -1).filter(i => i >= 0);
        if (masks) masks = keep.map(i => masks[i]);
        boxArr = keep.map(i => boxArr[i]);
      }
    }

    if (boxArr.length === 0) return [];

    // Sort ordered detection formats
    const colLen = boxArr[0].length;
    if (colLen === 8) {
      boxArr.sort((a, b) => {
        if (a[6] !== b[6]) return a[6] - b[6];
        return b[7] - a[7];
      });
      if (masks) {
        // apply same sort
        const sortIdx = boxArr.map((_, i) => i);
        sortIdx.sort((a, b) => {
          if (boxArr[a][6] !== boxArr[b][6]) return boxArr[a][6] - boxArr[b][6];
          return boxArr[b][7] - boxArr[a][7];
        });
        masks = sortIdx.map(i => masks[i]);
      }
      boxArr = boxArr.map(b => b.slice(0, 6));
    } else if (colLen === 7) {
      const sortIdx = [...Array(boxArr.length).keys()].sort((a, b) => boxArr[a][6] - boxArr[b][6]);
      if (masks) masks = sortIdx.map(i => masks[i]);
      boxArr = sortIdx.map(i => boxArr[i].slice(0, 6));
    }

    // Extract polygon points from masks
    let polygonPoints = null;
    if (masks && this.scaleSize) {
      const scaleRatio = this.scaleSize.map((s, i) => s / imgSize[i]);
      polygonPoints = extractPolygonPointsByMasks(boxArr, masks, scaleRatio, layoutShapeMode);
    }

    // Unclip boxes
    if (this.layoutUnclipRatio) {
      boxArr = unclipBoxes(boxArr, this.layoutUnclipRatio);
    }

    return restructuredBoxes(boxArr, this.labels, imgSize, polygonPoints);
  }
}

// ─── Box array conversion helper ──────────────────────────────────────────────

/**
 * Convert a flat Float32Array (N×cols) or nested number[][] to number[][].
 * @param {Float32Array|number[][]} boxes
 * @returns {number[][]}
 */
function toBoxArray(boxes) {
  if (!boxes || boxes.length === 0) return [];
  if (Array.isArray(boxes[0])) return boxes.map(row => [...row]);
  // Flat typed array — infer cols from context (minimum 6)
  // The caller sets shape directly; we infer from Float32Array
  // Use 8 cols if length divisible by 8 and > 7*n, else 6
  const len = boxes.length;
  for (const cols of [8, 7, 6]) {
    if (len % cols === 0) {
      const n = len / cols;
      const arr = [];
      for (let i = 0; i < n; i++) {
        arr.push(Array.from(boxes.subarray ? boxes.subarray(i * cols, i * cols + cols) : boxes.slice(i * cols, i * cols + cols)));
      }
      return arr;
    }
  }
  return [];
}

// ─── iou ──────────────────────────────────────────────────────────────────────

/**
 * Compute IoU between two [x1,y1,x2,y2] boxes.
 * @param {number[]} box1 - [x1,y1,x2,y2] (2:6 slice of a detection row)
 * @param {number[]} box2
 * @returns {number}
 */
export function iou(box1, box2) {
  const [x1, y1, x2, y2] = box1;
  const [x1p, y1p, x2p, y2p] = box2;

  const x1i = Math.max(x1, x1p);
  const y1i = Math.max(y1, y1p);
  const x2i = Math.min(x2, x2p);
  const y2i = Math.min(y2, y2p);

  const interArea = Math.max(0, x2i - x1i + 1) * Math.max(0, y2i - y1i + 1);
  const box1Area = (x2 - x1 + 1) * (y2 - y1 + 1);
  const box2Area = (x2p - x1p + 1) * (y2p - y1p + 1);
  return interArea / (box1Area + box2Area - interArea);
}

// ─── nms ──────────────────────────────────────────────────────────────────────

/**
 * Non-Maximum Suppression with per-class IoU thresholds.
 * @param {number[][]} boxes - Each row: [cls_id, score, x1, y1, x2, y2, ...]
 * @param {number} [iouSame=0.6]
 * @param {number} [iouDiff=0.95]
 * @returns {number[]} Indices of kept boxes
 */
export function nms(boxes, iouSame = 0.6, iouDiff = 0.95) {
  const scores = boxes.map(b => b[1]);
  let indices = [...Array(boxes.length).keys()].sort((a, b) => scores[b] - scores[a]);
  const selected = [];

  while (indices.length > 0) {
    const current = indices[0];
    selected.push(current);
    const currentClass = boxes[current][0];
    const currentCoords = boxes[current].slice(2, 6);

    indices = indices.slice(1).filter(i => {
      const boxClass = boxes[i][0];
      const boxCoords = boxes[i].slice(2, 6);
      const iouVal = iou(currentCoords, boxCoords);
      const threshold = currentClass === boxClass ? iouSame : iouDiff;
      return iouVal < threshold;
    });
  }
  return selected;
}

// ─── isContained ─────────────────────────────────────────────────────────────

/**
 * @param {number[]} box1 - [cls, score, x1, y1, x2, y2]
 * @param {number[]} box2
 * @returns {boolean}
 */
export function isContained(box1, box2) {
  const [, , x1, y1, x2, y2] = box1;
  const [, , x1p, y1p, x2p, y2p] = box2;
  const box1Area = (x2 - x1) * (y2 - y1);
  const xi1 = Math.max(x1, x1p), yi1 = Math.max(y1, y1p);
  const xi2 = Math.min(x2, x2p), yi2 = Math.min(y2, y2p);
  const interArea = Math.max(0, xi2 - xi1) * Math.max(0, yi2 - yi1);
  const iouVal = box1Area > 0 ? interArea / box1Area : 0;
  return iouVal >= 0.9;
}

// ─── checkContainment ─────────────────────────────────────────────────────────

/**
 * @param {number[][]} boxes
 * @param {number|null} formulaIndex
 * @param {number|null} [categoryIndex]
 * @param {string|null} [mode]
 * @returns {[Int32Array, Int32Array]}
 */
export function checkContainment(boxes, formulaIndex = null, categoryIndex = null, mode = null) {
  const n = boxes.length;
  const containsOther = new Int32Array(n);
  const containedByOther = new Int32Array(n);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (formulaIndex !== null && boxes[i][0] === formulaIndex && boxes[j][0] !== formulaIndex) continue;
      if (categoryIndex !== null && mode !== null) {
        if (mode === 'large' && boxes[j][0] === categoryIndex) {
          if (isContained(boxes[i], boxes[j])) { containedByOther[i] = 1; containsOther[j] = 1; }
        }
        if (mode === 'small' && boxes[i][0] === categoryIndex) {
          if (isContained(boxes[i], boxes[j])) { containedByOther[i] = 1; containsOther[j] = 1; }
        }
      } else {
        if (isContained(boxes[i], boxes[j])) { containedByOther[i] = 1; containsOther[j] = 1; }
      }
    }
  }
  return [containsOther, containedByOther];
}

// ─── calculateBboxArea ────────────────────────────────────────────────────────

/**
 * @param {number[]} bbox - [x1, y1, x2, y2]
 * @returns {number}
 */
export function calculateBboxArea(bbox) {
  const [x1, y1, x2, y2] = bbox.map(Number);
  return Math.abs((x2 - x1) * (y2 - y1));
}

// ─── calculateOverlapRatio ────────────────────────────────────────────────────

/**
 * @param {number[]} bbox1
 * @param {number[]} bbox2
 * @param {'union'|'small'|'large'} [mode='union']
 * @returns {number}
 */
export function calculateOverlapRatio(bbox1, bbox2, mode = 'union') {
  const xMinInter = Math.max(bbox1[0], bbox2[0]);
  const yMinInter = Math.max(bbox1[1], bbox2[1]);
  const xMaxInter = Math.min(bbox1[2], bbox2[2]);
  const yMaxInter = Math.min(bbox1[3], bbox2[3]);

  const interW = Math.max(0, xMaxInter - xMinInter);
  const interH = Math.max(0, yMaxInter - yMinInter);
  const interArea = interW * interH;

  const area1 = calculateBboxArea(bbox1);
  const area2 = calculateBboxArea(bbox2);

  let refArea;
  if (mode === 'union') refArea = area1 + area2 - interArea;
  else if (mode === 'small') refArea = Math.min(area1, area2);
  else if (mode === 'large') refArea = Math.max(area1, area2);
  else throw new Error(`Invalid mode: ${mode}`);

  return refArea === 0 ? 0 : interArea / refArea;
}

// ─── Sutherland-Hodgman polygon clipping (replaces Shapely) ──────────────────

/**
 * Clip `subjectPolygon` against a convex `clipPolygon`.
 * Returns the clipped polygon points, or [] if no intersection.
 *
 * @param {number[][]} subjectPolygon
 * @param {number[][]} clipPolygon
 * @returns {number[][]}
 */
function sutherlandHodgman(subjectPolygon, clipPolygon) {
  function inside(p, a, b) {
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
  }
  function intersect(a, b, c, d) {
    const a1 = b[1] - a[1], b1 = a[0] - b[0], c1 = a1 * a[0] + b1 * a[1];
    const a2 = d[1] - c[1], b2 = c[0] - d[0], c2 = a2 * c[0] + b2 * c[1];
    const det = a1 * b2 - a2 * b1;
    if (det === 0) return a; // parallel
    return [(b2 * c1 - b1 * c2) / det, (a1 * c2 - a2 * c1) / det];
  }

  let output = [...subjectPolygon];
  if (output.length === 0) return [];

  for (let i = 0; i < clipPolygon.length; i++) {
    if (output.length === 0) return [];
    const input = output;
    output = [];
    const a = clipPolygon[i];
    const b = clipPolygon[(i + 1) % clipPolygon.length];
    for (let j = 0; j < input.length; j++) {
      const curr = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      if (inside(curr, a, b)) {
        if (!inside(prev, a, b)) output.push(intersect(prev, curr, a, b));
        output.push(curr);
      } else if (inside(prev, a, b)) {
        output.push(intersect(prev, curr, a, b));
      }
    }
  }
  return output;
}

/**
 * Signed polygon area (shoelace).
 * @param {number[][]} polygon
 * @returns {number}
 */
function polygonArea(polygon) {
  let area = 0;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += polygon[i][0] * polygon[j][1];
    area -= polygon[j][0] * polygon[i][1];
  }
  return Math.abs(area) / 2;
}

/**
 * Calculate polygon overlap ratio using Sutherland-Hodgman clipping.
 * Replaces Python: calculate_polygon_overlap_ratio() / Shapely.
 *
 * @param {number[][]|number[]} polygon1 - [[x,y], ...] or flat [x,y,x,y,...]
 * @param {number[][]|number[]} polygon2
 * @param {'union'|'small'|'large'} [mode='union']
 * @returns {number}
 */
export function calculatePolygonOverlapRatio(polygon1, polygon2, mode = 'union') {
  // Normalise to [[x,y], ...] if flat list given
  const toPairs = (pts) => {
    if (pts.length === 0) return [];
    if (Array.isArray(pts[0])) return pts;
    const out = [];
    for (let i = 0; i + 1 < pts.length; i += 2) out.push([pts[i], pts[i + 1]]);
    return out;
  };

  const p1 = toPairs(polygon1);
  const p2 = toPairs(polygon2);

  if (p1.length < 3 || p2.length < 3) return 0;

  const clipped = sutherlandHodgman(p1, p2);
  const intersectionArea = clipped.length >= 3 ? polygonArea(clipped) : 0;

  const area1 = polygonArea(p1);
  const area2 = polygonArea(p2);

  let refArea;
  if (mode === 'union') refArea = area1 + area2 - intersectionArea;
  else if (mode === 'small') refArea = Math.min(area1, area2);
  else if (mode === 'large') refArea = Math.max(area1, area2);
  else throw new Error(`Unknown mode: ${mode}`);

  return refArea > 0 ? Math.min(intersectionArea / refArea, 1) : 0;
}

// ─── unclipBoxes ──────────────────────────────────────────────────────────────

/**
 * Expand bounding boxes by an unclip ratio.
 * @param {number[][]} boxes
 * @param {number|number[]|Object|null} unclipRatio
 * @returns {number[][]}
 */
export function unclipBoxes(boxes, unclipRatio = null) {
  if (!unclipRatio) return boxes;

  if (typeof unclipRatio === 'object' && !Array.isArray(unclipRatio)) {
    return boxes.map(box => {
      const [classId, score, x1, y1, x2, y2] = box;
      if (classId in unclipRatio) {
        const [wr, hr] = unclipRatio[classId];
        const w = x2 - x1, h = y2 - y1;
        const cx = x1 + w / 2, cy = y1 + h / 2;
        return [classId, score, cx - w * wr / 2, cy - h * hr / 2, cx + w * wr / 2, cy + h * hr / 2];
      }
      return box;
    });
  }

  const [wRatio, hRatio] = Array.isArray(unclipRatio) ? unclipRatio : [unclipRatio, unclipRatio];
  return boxes.map(box => {
    const [classId, score, x1, y1, x2, y2] = box;
    const w = x2 - x1, h = y2 - y1;
    const cx = x1 + w / 2, cy = y1 + h / 2;
    const nw = w * wRatio, nh = h * hRatio;
    return [classId, score, cx - nw / 2, cy - nh / 2, cx + nw / 2, cy + nh / 2];
  });
}

// ─── restructuredBoxes ───────────────────────────────────────────────────────

/**
 * Convert raw box array to labelled dict format.
 * @param {number[][]} boxes - [[cls_id, score, xmin, ymin, xmax, ymax], ...]
 * @param {string[]} labels
 * @param {[number, number]} imgSize - [width, height]
 * @param {number[][][]|null} [polygonPoints]
 * @returns {Object[]}
 */
export function restructuredBoxes(boxes, labels, imgSize, polygonPoints = null) {
  const [w, h] = imgSize;
  const boxList = [];
  for (let idx = 0; idx < boxes.length; idx++) {
    const box = boxes[idx];
    let [, , xmin, ymin, xmax, ymax] = box;

    // NATIVE PARITY: Python uses int(np.round(x)). 
    // Previously used floor/ceil which causes +-1 pixel jitter on WebGPU vs WASM.
    xmin = Math.max(0, Math.round(xmin));
    ymin = Math.max(0, Math.round(ymin));
    xmax = Math.min(w, Math.round(xmax));
    ymax = Math.min(h, Math.round(ymax));

    if (xmax <= xmin || ymax <= ymin) continue;

    const res = {
      cls_id: Math.round(box[0]),
      label: labels[Math.round(box[0])],
      score: box[1],
      coordinate: [xmin, ymin, xmax, ymax],
      order: idx + 1,
    };

    if (polygonPoints) {
      const poly = polygonPoints[idx];
      if (poly == null) continue;
      res.polygon_points = poly;
    }

    boxList.push(res);
  }
  return boxList;
}

// ─── filterBoxes ─────────────────────────────────────────────────────────────

/**
 * Remove overlapping boxes from layout detection results.
 * @param {Object[]} srcBoxes
 * @param {string} layoutShapeMode
 * @returns {Object[]}
 */
export function filterBoxes(srcBoxes, layoutShapeMode) {
  const boxes = srcBoxes.filter(b => b.label !== 'reference');
  const droppedIndexes = new Set();

  for (let i = 0; i < boxes.length; i++) {
    const [x1, y1, x2, y2] = boxes[i].coordinate;
    if ((x2 - x1) < 6 || (y2 - y1) < 6) { droppedIndexes.add(i); continue; }

    for (let j = i + 1; j < boxes.length; j++) {
      if (droppedIndexes.has(i) || droppedIndexes.has(j)) continue;

      const overlapRatio = calculateOverlapRatio(boxes[i].coordinate, boxes[j].coordinate, 'small');

      if (boxes[i].label === 'inline_formula' || boxes[j].label === 'inline_formula') {
        if (overlapRatio > 0.5) {
          if (boxes[i].label === 'inline_formula') droppedIndexes.add(i);
          if (boxes[j].label === 'inline_formula') droppedIndexes.add(j);
        }
        continue;
      }

      if (overlapRatio > 0.7) {
        if (layoutShapeMode !== 'rect' && boxes[i].polygon_points && boxes[j].polygon_points) {
          const polyOverlap = calculatePolygonOverlapRatio(boxes[i].polygon_points, boxes[j].polygon_points, 'small');
          if (polyOverlap < 0.7) continue;
        }
        const areaI = calculateBboxArea(boxes[i].coordinate);
        const areaJ = calculateBboxArea(boxes[j].coordinate);
        if ((boxes[i].label === 'image' || boxes[j].label === 'image') && boxes[i].label !== boxes[j].label) continue;
        if (areaI >= areaJ) droppedIndexes.add(j);
        else droppedIndexes.add(i);
      }
    }
  }

  return boxes.filter((_, idx) => !droppedIndexes.has(idx));
}

// ─── updateOrderIndex ─────────────────────────────────────────────────────────

/**
 * @param {Object[]} boxes
 * @param {string[]} skipOrderLabels
 * @returns {Object[]}
 */
export function updateOrderIndex(boxes, skipOrderLabels = SKIP_ORDER_LABELS) {
  let orderIndex = 1;
  for (const box of boxes) {
    if (!skipOrderLabels.includes(box.label)) {
      box.order = orderIndex++;
    } else {
      box.order = null;
    }
  }
  return boxes;
}

// ─── Polygon geometry helpers ─────────────────────────────────────────────────

/**
 * @param {number[]} pPrev
 * @param {number[]} pCurr
 * @param {number[]} pNext
 * @returns {boolean}
 */
export function isConvex(pPrev, pCurr, pNext) {
  const v1 = [pCurr[0] - pPrev[0], pCurr[1] - pPrev[1]];
  const v2 = [pNext[0] - pCurr[0], pNext[1] - pCurr[1]];
  const cross = v1[0] * v2[1] - v1[1] * v2[0];
  return cross < 0;
}

/**
 * @param {number[]} v1
 * @param {number[]} v2
 * @returns {number} degrees
 */
export function angleBetweenVectors(v1, v2) {
  const norm1 = Math.sqrt(v1[0] ** 2 + v1[1] ** 2);
  const norm2 = Math.sqrt(v2[0] ** 2 + v2[1] ** 2);
  if (norm1 === 0 || norm2 === 0) return 0;
  const dot = (v1[0] * v2[0] + v1[1] * v2[1]) / (norm1 * norm2);
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/**
 * @param {number[]} pCurr
 * @param {number[]} v1
 * @param {number[]} v2
 * @param {number} [distance=20]
 * @returns {number[]}
 */
export function calcNewPoint(pCurr, v1, v2, distance = 20) {
  const norm1 = Math.sqrt(v1[0] ** 2 + v1[1] ** 2);
  const norm2 = Math.sqrt(v2[0] ** 2 + v2[1] ** 2);
  let dirVec = [(v1[0] / norm1) + (v2[0] / norm2), (v1[1] / norm1) + (v2[1] / norm2)];
  const dirNorm = Math.sqrt(dirVec[0] ** 2 + dirVec[1] ** 2);
  if (dirNorm > 0) dirVec = [dirVec[0] / dirNorm, dirVec[1] / dirNorm];
  return [pCurr[0] + dirVec[0] * distance, pCurr[1] + dirVec[1] * distance];
}

// ─── extractCustomVertices ───────────────────────────────────────────────────

/**
 * Port of extract_custom_vertices — simplifies a polygon by preserving convex
 * vertices and dense spacing along long edges.
 *
 * @param {number[][]} polygon
 * @param {number} maxAllowedDist
 * @param {number} [sharpAngleThresh=45]
 * @param {number} [maxDistRatio=0.3]
 * @returns {number[][]}
 */
export function extractCustomVertices(polygon, maxAllowedDist, sharpAngleThresh = 45, maxDistRatio = 0.3) {
  const poly = polygon;
  const n = poly.length;
  maxAllowedDist *= maxDistRatio;

  const pointInfo = poly.map((pCurr, i) => {
    const pPrev = poly[(i - 1 + n) % n];
    const pNext = poly[(i + 1) % n];
    const v1 = [pPrev[0] - pCurr[0], pPrev[1] - pCurr[1]];
    const v2 = [pNext[0] - pCurr[0], pNext[1] - pCurr[1]];
    return {
      index: i,
      isConvex: isConvex(pPrev, pCurr, pNext),
      angle: angleBetweenVectors(v1, v2),
      v1, v2,
    };
  });

  const concaveIndices = pointInfo.filter(p => !p.isConvex).map(p => p.index);
  const preserveConcave = new Set();

  if (concaveIndices.length >= 2) {
    const groups = [];
    let currentGroup = [concaveIndices[0]];
    for (let i = 1; i < concaveIndices.length; i++) {
      if (concaveIndices[i] - concaveIndices[i - 1] === 1 ||
          (concaveIndices[i - 1] === n - 1 && concaveIndices[i] === 0)) {
        currentGroup.push(concaveIndices[i]);
      } else {
        if (currentGroup.length >= 2) groups.push(...currentGroup);
        currentGroup = [concaveIndices[i]];
      }
    }
    if (currentGroup.length >= 2) groups.push(...currentGroup);

    if (concaveIndices[0] === 0 && concaveIndices[concaveIndices.length - 1] === n - 1) {
      if (groups.includes(0) && groups.includes(n - 1)) groups.forEach(g => preserveConcave.add(g));
    } else {
      groups.forEach(g => preserveConcave.add(g));
    }
  }

  const keptPoints = pointInfo
    .filter(info => info.isConvex || (preserveConcave.has(info.index) && info.angle >= 120))
    .map(info => info.index);

  const finalPoints = [];
  for (let idx = 0; idx < keptPoints.length; idx++) {
    const currentIdx = keptPoints[idx];
    const nextIdx = keptPoints[(idx + 1) % keptPoints.length];
    finalPoints.push(currentIdx);

    const dx = poly[currentIdx][0] - poly[nextIdx][0];
    const dy = poly[currentIdx][1] - poly[nextIdx][1];
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > maxAllowedDist) {
      const intermediate = currentIdx < nextIdx
        ? Array.from({ length: nextIdx - currentIdx - 1 }, (_, k) => currentIdx + 1 + k)
        : [
            ...Array.from({ length: n - currentIdx - 1 }, (_, k) => currentIdx + 1 + k),
            ...Array.from({ length: nextIdx }, (_, k) => k),
          ];

      if (intermediate.length > 0) {
        const numNeeded = Math.ceil(dist / maxAllowedDist) - 1;
        if (intermediate.length <= numNeeded) {
          finalPoints.push(...intermediate);
        } else {
          const step = intermediate.length / numNeeded;
          for (let k = 0; k < numNeeded; k++) finalPoints.push(intermediate[Math.floor(k * step)]);
        }
      }
    }
  }

  const uniqueSorted = [...new Set(finalPoints)].sort((a, b) => a - b);
  const res = [];

  for (const i of uniqueSorted) {
    const info = pointInfo[i];
    const pCurr = poly[i];
    if (info.isConvex && Math.abs(info.angle - sharpAngleThresh) < 1) {
      const norm1 = Math.sqrt(info.v1[0] ** 2 + info.v1[1] ** 2);
      const norm2 = Math.sqrt(info.v2[0] ** 2 + info.v2[1] ** 2);
      const v1n = [info.v1[0] / norm1, info.v1[1] / norm1];
      const v2n = [info.v2[0] / norm2, info.v2[1] / norm2];
      const dir = [v1n[0] + v2n[0], v1n[1] + v2n[1]];
      const d = (norm1 + norm2) / 2;
      const dirNorm = Math.sqrt(dir[0] ** 2 + dir[1] ** 2);
      res.push([pCurr[0] + (dir[0] / dirNorm) * d, pCurr[1] + (dir[1] / dirNorm) * d]);
    } else {
      res.push([...pCurr]);
    }
  }

  return res;
}

// ─── mask2polygon ─────────────────────────────────────────────────────────────

/**
 * Convert a binary mask to a simplified polygon using OpenCV.js.
 * Matches Python: mask2polygon(mask, max_allowed_dist, epsilon_ratio, extract_custom)
 *
 * @param {cv.Mat} mask - CV_8UC1 binary mask
 * @param {number} maxAllowedDist
 * @param {number} [epsilonRatio=0.004]
 * @param {boolean} [extractCustom=true]
 * @returns {number[][]|null}
 */
export function mask2polygon(mask, maxAllowedDist, epsilonRatio = 0.004, extractCustom = true) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let approx = null;

  try {
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    if (contours.size() === 0) return null;

    // Find largest contour by area
    let maxArea = -1;
    let maxIdx = 0;
    for (let i = 0; i < contours.size(); i++) {
      const area = cv.contourArea(contours.get(i));
      if (area > maxArea) { maxArea = area; maxIdx = i; }
    }

    const cnt = contours.get(maxIdx);
    const epsilon = epsilonRatio * cv.arcLength(cnt, true);
    approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, epsilon, true);

    // Extract points from approx Mat
    const points = [];
    for (let i = 0; i < approx.rows; i++) {
      points.push([approx.data32S[i * 2], approx.data32S[i * 2 + 1]]);
    }

    if (points.length < 2) return null;
    const polygonPoints = points.length === 1 ? [[points[0][0], points[0][1]]] : points;

    if (extractCustom && polygonPoints.length >= 3) {
      return extractCustomVertices(polygonPoints, maxAllowedDist);
    }

    return polygonPoints;
  } finally {
    contours.delete();
    hierarchy.delete();
    if (approx) approx.delete();
  }
}

// ─── convertPolygonToQuad ─────────────────────────────────────────────────────

/**
 * Convert a polygon to a minimum bounding rectangle (quad) using OpenCV.js.
 * Matches Python: convert_polygon_to_quad(polygon)
 *
 * @param {number[][]} polygon
 * @returns {number[][]|null}
 */
export function convertPolygonToQuad(polygon) {
  if (!polygon || polygon.length < 3) return null;

  let pointsMat = null;
  try {
    const flat = new Float32Array(polygon.flat());
    pointsMat = cv.matFromArray(polygon.length, 1, cv.CV_32FC2, flat);

    const minRect = cv.minAreaRect(pointsMat);
    // OpenCV.js 4.x only accepts the 1-arg form.
    let quad = cv.boxPoints(minRect);

    // Read 4 points safely: try data32F first, else floatAt fallback.
    let cx, cy, pts;
    if (quad && quad.data32F && quad.data32F.length >= 8) {
      const qd = quad.data32F;
      cx = (qd[0] + qd[2] + qd[4] + qd[6]) / 4;
      cy = (qd[1] + qd[3] + qd[5] + qd[7]) / 4;
      pts = Array.from({ length: 4 }, (_, i) => [qd[i * 2], qd[i * 2 + 1]]);
    } else if (quad && quad.floatAt) {
      pts = [];
      for (let r = 0; r < 4; r++) pts.push([quad.floatAt(r, 0), quad.floatAt(r, 1)]);
      cx = pts.reduce((s, p) => s + p[0], 0) / 4;
      cy = pts.reduce((s, p) => s + p[1], 0) / 4;
    } else {
      // Last resort: compute from RotatedRect manually
      const rcx = minRect.center.x, rcy = minRect.center.y;
      const w = minRect.size.width / 2, h = minRect.size.height / 2;
      const a = (minRect.angle * Math.PI) / 180;
      const cos = Math.cos(a), sin = Math.sin(a);
      pts = [
        [rcx - w * cos + h * sin, rcy - w * sin - h * cos],
        [rcx + w * cos + h * sin, rcy + w * sin - h * cos],
        [rcx + w * cos - h * sin, rcy + w * sin + h * cos],
        [rcx - w * cos - h * sin, rcy - w * sin + h * cos],
      ];
      cx = rcx; cy = rcy;
    }

    pts.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));

    // Roll so top-left (min sum) is first
    const sums = pts.map(p => p[0] + p[1]);
    const topLeftIdx = sums.indexOf(Math.min(...sums));
    const rolled = [...pts.slice(topLeftIdx), ...pts.slice(0, topLeftIdx)];

    quad.delete();
    return rolled;
  } finally {
    if (pointsMat) pointsMat.delete();
  }
}

// ─── extractPolygonPointsByMasks ─────────────────────────────────────────────

/**
 * Extract polygon points from segmentation masks for each detected box.
 * Matches Python: extract_polygon_points_by_masks(boxes, masks, scale_ratio, layout_shape_mode)
 *
 * @param {number[][]} boxes       - [[cls, score, x1, y1, x2, y2], ...]
 * @param {Uint8Array[]} masks     - Per-box binary masks
 * @param {number[]} scaleRatio    - [scaleW, scaleH]
 * @param {string} layoutShapeMode
 * @returns {(number[][])[]}
 */
export function extractPolygonPointsByMasks(boxes, masks, scaleRatio, layoutShapeMode) {
  const scaleW = scaleRatio[0] / 4;
  const scaleH = scaleRatio[1] / 4;

  // Infer mask dimensions from the first mask (assumed square flat array)
  const maskH = masks[0] ? Math.round(Math.sqrt(masks[0].length)) : 1;
  const maskW = maskH;

  const maxBoxW = Math.max(...boxes.map(b => b[4] - b[3]));
  const polygonPoints = [];

  for (let i = 0; i < boxes.length; i++) {
    const [, , xMin, yMin, xMax, yMax] = boxes[i].map(Math.round);
    const boxW = xMax - xMin;
    const boxH = yMax - yMin;

    const rect = [[xMin, yMin], [xMax, yMin], [xMax, yMax], [xMin, yMax]];

    if (boxW <= 0 || boxH <= 0) { polygonPoints.push(rect); continue; }

    const xS = [
      Math.min(maskW, Math.max(0, Math.round(xMin * scaleW))),
      Math.min(maskW, Math.max(0, Math.round(xMax * scaleW))),
    ];
    const yS = [
      Math.min(maskH, Math.max(0, Math.round(yMin * scaleH))),
      Math.min(maskH, Math.max(0, Math.round(yMax * scaleH))),
    ];

    // Crop mask region
    const croppedW = xS[1] - xS[0];
    const croppedH = yS[1] - yS[0];
    if (croppedW <= 0 || croppedH <= 0) { polygonPoints.push(rect); continue; }

    // Extract crop from flat mask (row-major)
    const mask = masks[i];
    let hasContent = false;
    const cropped = new Uint8Array(croppedW * croppedH);
    for (let row = 0; row < croppedH; row++) {
      for (let col = 0; col < croppedW; col++) {
        const val = mask[(yS[0] + row) * maskW + (xS[0] + col)];
        cropped[row * croppedW + col] = val;
        if (val) hasContent = true;
      }
    }

    if (!hasContent) { polygonPoints.push(rect); continue; }
    if (layoutShapeMode === 'rect') { polygonPoints.push(rect); continue; }

    // Resize mask to match box size using OpenCV.js
    let croppedMat = null, resizedMat = null;
    let polygon = null;

    try {
      croppedMat = cv.matFromArray(croppedH, croppedW, cv.CV_8UC1, cropped);
      resizedMat = new cv.Mat();
      cv.resize(croppedMat, resizedMat, new cv.Size(boxW, boxH), 0, 0, cv.INTER_NEAREST);

      const mdist = boxW > maxBoxW * 0.6 ? boxW : maxBoxW;
      polygon = mask2polygon(resizedMat, mdist);
    } finally {
      if (croppedMat) croppedMat.delete();
      if (resizedMat) resizedMat.delete();
    }

    if (!polygon || polygon.length < 4) { polygonPoints.push(rect); continue; }

    // Offset polygon by box origin
    const offsetPoly = polygon.map(p => [p[0] + xMin, p[1] + yMin]);

    if (layoutShapeMode === 'poly') {
      polygonPoints.push(offsetPoly);
    } else if (layoutShapeMode === 'quad') {
      const quad = convertPolygonToQuad(offsetPoly);
      polygonPoints.push(quad ?? rect);
    } else if (layoutShapeMode === 'auto') {
      const rectList = rect;
      const quad = convertPolygonToQuad(offsetPoly);

      if (quad) {
        const iouQuad = calculatePolygonOverlapRatio(rectList, quad, 'union');
        const finalQuad = iouQuad >= 0.95 ? rect : quad;
        const polyList = offsetPoly;
        const iouPolyQuad = calculatePolygonOverlapRatio(polyList, finalQuad, 'union');
        const prev = polygonPoints.length > 0 ? polygonPoints[polygonPoints.length - 1] : null;
        const iouPre = prev ? calculatePolygonOverlapRatio(prev, rectList, 'small') : 0;

        if (iouPolyQuad >= 0.8 && iouPre < 0.01) {
          polygonPoints.push(finalQuad);
          continue;
        }
      }
      polygonPoints.push(offsetPoly);
    } else {
      throw new Error(`layout_shape_mode must be one of ['rect', 'poly', 'quad', 'auto']`);
    }
  }

  return polygonPoints;
}

// ─── findLabelPosition ────────────────────────────────────────────────────────

/**
 * Find a position inside a polygon to place a text label.
 * Replaces Shapely-based Python version with a simple scan approach.
 *
 * @param {number[]} bbox - [x1, y1, x2, y2]
 * @param {number[][]} polygonPoints
 * @param {number} textW
 * @param {number} textH
 * @param {number} [maxShift=50]
 * @returns {[number, number]}
 */
export function findLabelPosition(bbox, polygonPoints, textW, textH, maxShift = 50) {
  const minX = Math.min(...polygonPoints.map(p => p[0]));
  const minY = Math.min(...polygonPoints.map(p => p[1]));

  for (let dy = 0; dy < maxShift; dy++) {
    const x1 = minX, y1 = minY + dy;
    const x2 = x1 + textW, y2 = y1 + textH;
    // Simplified: check if the label rect centre is inside the polygon
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    if (isPointInPolygon(cx, cy, polygonPoints)) {
      return [Math.round(x1), Math.round(y1)];
    }
  }
  return [Math.round(minX), Math.round(minY)];
}

/**
 * Point-in-polygon test (ray casting).
 * @param {number} px
 * @param {number} py
 * @param {number[][]} polygon
 * @returns {boolean}
 */
function isPointInPolygon(px, py, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
