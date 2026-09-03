/**
 * OCR post-processing — DB probability map to text detection boxes.
 *
 * Converts the raw probability map from the DB text detection model into
 * a list of 4-vertex bounding boxes suitable for text recognition cropping.
 */

/* global cv */
import { deleteMat } from '../../utils/resource_utils.js';
import { AbortException } from '../../utils/exceptions.js';
import { throwIfAborted } from '../../utils/abort_registry.js';
import { intTrunc } from '../../utils/math_utils.js';

// ─── Polygon geometry helpers ─────────────────────────────────────────────────

function polygonArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return Math.abs(area) / 2;
}

function polygonPerimeter(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const dx = pts[j][0] - pts[i][0];
    const dy = pts[j][1] - pts[i][1];
    p += Math.sqrt(dx * dx + dy * dy);
  }
  return p;
}

// ─── safeBoxPoints ────────────────────────────────────────────────────────────

/**
 * Safely extract the 4 corner points from a RotatedRect via cv.boxPoints.
 * Handles multiple OpenCV.js build variants.
 * @param {object} rect - RotatedRect from cv.minAreaRect
 * @returns {[[number,number],[number,number],[number,number],[number,number]]}
 */
export function safeBoxPoints(rect) {
  const pts = cv.boxPoints(rect);
  let coords;
  try {
    if (pts.data32F && pts.data32F.length >= 8) {
      const d = pts.data32F;
      coords = [[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]];
    } else if (pts.floatAt) {
      coords = [];
      for (let r = 0; r < 4; r++) {
        coords.push([pts.floatAt(r, 0), pts.floatAt(r, 1)]);
      }
    } else {
      coords = computeBoxPointsManually(rect);
    }
  } finally {
    deleteMat(pts);
  }
  return coords;
}

/**
 * Manual calculation of box points from RotatedRect when OpenCV helpers are unavailable.
 * @private
 */
function computeBoxPointsManually(rect) {
  const cx = rect.center.x, cy = rect.center.y;
  const w = rect.size.width / 2, h = rect.size.height / 2;
  const a = (rect.angle * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  return [
    [cx - w * cos + h * sin, cy - w * sin - h * cos],
    [cx + w * cos + h * sin, cy + w * sin - h * cos],
    [cx + w * cos - h * sin, cy + w * sin + h * cos],
    [cx - w * cos - h * sin, cy - w * sin + h * cos],
  ];
}

// ─── Unclip polygon ───────────────────────────────────────────────────────────

/**
 * Expand polygon using OpenCV dilation-based approximation of pyclipper unclip.
 * All intermediate Mats are cleaned up via try/finally.
 */
export function unclipPolygon(pts, unclipRatio) {
  const area = polygonArea(pts);
  const perimeter = polygonPerimeter(pts);
  const distance = area * unclipRatio / perimeter;

  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  const minX = Math.floor(Math.min(...xs));
  const minY = Math.floor(Math.min(...ys));
  const maxX = Math.ceil(Math.max(...xs));
  const maxY = Math.ceil(Math.max(...ys));

  const offset = Math.ceil(distance) * 2;
  const w = maxX - minX + offset * 2;
  const h = maxY - minY + offset * 2;

  const shiftedPts = pts.map(([x, y]) => [x - minX + offset, y - minY + offset]);

  let mask = null;
  let ptsMat = null;
  let ptsVec = null;
  let kernel = null;
  let dilated = null;
  let contours = null;
  let hierarchy = null;

  try {
    mask = new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(0));
    ptsMat = cv.matFromArray(shiftedPts.length, 1, cv.CV_32SC2, shiftedPts.flat().map(intTrunc));
    ptsVec = new cv.MatVector();
    ptsVec.push_back(ptsMat);
    cv.fillPoly(mask, ptsVec, new cv.Scalar(255));

    const kernelSize = Math.max(1, Math.round(distance));
    kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kernelSize * 2 + 1, kernelSize * 2 + 1));
    dilated = new cv.Mat();
    cv.dilate(mask, dilated, kernel);

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    if (contours.size() === 0) return pts;

    return extractLargestContour(contours, offset, minX, minY);
  } finally {
    deleteMat(mask);
    deleteMat(ptsMat);
    if (ptsVec) ptsVec.delete();
    deleteMat(kernel);
    deleteMat(dilated);
    if (contours) contours.delete();
    deleteMat(hierarchy);
  }
}

/**
 * Finds the largest contour and approximates it to a polygon.
 * @private
 */
function extractLargestContour(contours, offset, minX, minY) {
  let maxArea = 0;
  let maxIdx = 0;
  for (let i = 0; i < contours.size(); i++) {
    const a = cv.contourArea(contours.get(i));
    if (a > maxArea) { maxArea = a; maxIdx = i; }
  }

  const contour = contours.get(maxIdx);
  const epsilon = 0.01 * cv.arcLength(contour, true);
  const approx = new cv.Mat();
  try {
    cv.approxPolyDP(contour, approx, epsilon, true);
    const expandedPts = [];
    for (let i = 0; i < approx.rows; i++) {
      expandedPts.push([
        approx.intAt(i, 0) - offset + minX,
        approx.intAt(i, 1) - offset + minY,
      ]);
    }
    return expandedPts;
  } finally {
    deleteMat(approx);
  }
}

// ─── DetPostProcess ───────────────────────────────────────────────────────────

const MIN_RECT_SIDE = 3;

/**
 * Converts DB probability map to list of text detection boxes.
 *
 * Supports two box_type modes:
 *   - 'quad' (default): returns 4-vertex min-area-rect quads (standard text detection).
 *   - 'poly': returns raw polygon contours from the binary mask, matching Python
 *             `polygons_from_bitmap` (rapid_ocr_onnxruntime). Used for seal text.
 *
 * Porting fix: added `box_type='poly'` path — `polygons_from_bitmap`.
 */
export class DetPostProcess {
  /**
   * @param {number} thresh
   * @param {number} boxThresh
   * @param {number} unclipRatio
   * @param {number} minSize
   * @param {boolean} useDilation
   * @param {number} maxCandidates
   * @param {'quad'|'poly'} [boxType='quad']
   */
  constructor(thresh = 0.3, boxThresh = 0.5, unclipRatio = 1.6, minSize = 3, useDilation = true, maxCandidates = 1000, boxType = 'quad') {
    this.thresh = thresh;
    this.boxThresh = boxThresh;
    this.unclipRatio = unclipRatio;
    this.minSize = minSize;
    this.useDilation = useDilation;
    this.maxCandidates = maxCandidates;
    // Porting fix: store box_type for quad vs poly dispatch
    this.boxType = boxType === 'poly' ? 'poly' : 'quad';
    this.dilationKernel = useDilation ? [[1, 1], [1, 1]] : null;
    // Porting fix: Cache the 2×2 dilation kernel cv.Mat once at construction
    // time rather than recreating it on every _applyDilation call. Only allocated
    // when useDilation=true to avoid unnecessary WASM heap allocation.
    // Must be released by calling dispose when this instance is no longer needed.
    this._dilationKernelMat = useDilation ? cv.matFromArray(2, 2, cv.CV_8UC1, [1, 1, 1, 1]) : null;
  }

  /**
   * Release WASM-heap resources owned by this instance.
   * Must be called when the DetPostProcess instance is no longer needed.
   */
  dispose() {
    deleteMat(this._dilationKernelMat);
    this._dilationKernelMat = null;
  }

  /**
   * @param {ort.Tensor} predTensor - shape [1, 1, H, W] (float32)
   * @param {{ h:number, w:number }} ratio
   * @param {[number,number]} oriShape - [oriH, oriW]
   * @returns {Array<Array<[number,number]>>}
   */
  async call(predTensor, ratio, oriShape) {
    const [srcH, srcW] = oriShape;
    const pred = predTensor.data;
    const [, , H, W] = predTensor.dims;

    const segmentation = this._binarize(pred, H, W);

    // Porting fix: dispatch to poly path when box_type='poly'.
    // polygons_from_bitmap extracts raw contour polygons instead of min-area-rect quads.
    if (this.boxType === 'poly') {
      return await this._polygonsFromBitmap(segmentation, pred, H, W, srcH, srcW);
    }

    let mask = null;
    let kernel = null;
    let contours = null;
    let hierarchy = null;

    try {
      mask = cv.matFromArray(H, W, cv.CV_8UC1, Array.from(segmentation));
      mask = this._applyDilation(mask);

      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      const { boxes, scores } = await this._processContours(contours, pred, W, H, srcH, srcW);
      return this._filterDetRes(boxes, scores, srcH, srcW);
    } finally {
      deleteMat(mask);
      deleteMat(kernel);
      if (contours) contours.delete();
      deleteMat(hierarchy);
    }
  }

  /**
   * Porting fix: polygons_from_bitmap — poly box_type path.
   *
   * Matches Python `rapid_ocr_onnxruntime` `polygons_from_bitmap`:
   *   1. Find contours on the binary mask.
   *   2. For each contour: score check, unclip, scale back to original image coordinates.
   *   3. Return polygon contour points directly (not min-area-rect quads).
   *
   * The returned polygons may have more than 4 vertices, which is appropriate
   * for curved seal text. Callers (e.g. _ocrSeal via cropByPolys) handle N-point polys.
   *
   * Caller is responsible for deleting any returned cv.Mat objects only if
   * this method returns Mats — it does not; all intermediate Mats are cleaned up here.
   *
   * @private
   * @param {Uint8Array} segmentation - binarised H×W bitmap
   * @param {Float32Array} pred - raw probability map (H×W)
   * @param {number} H
   * @param {number} W
   * @param {number} srcH - original image height
   * @param {number} srcW - original image width
   * @returns {Array<Array<[number,number]>>} array of polygons, each [[x,y],...]
   */
  async _polygonsFromBitmap(segmentation, pred, H, W, srcH, srcW) {
    let mask = null;
    let contours = null;
    let hierarchy = null;

    try {
      mask = cv.matFromArray(H, W, cv.CV_8UC1, Array.from(segmentation));
      // NOTE: dilation is intentionally skipped for poly mode — Python's
      // polygons_from_bitmap operates on the raw binarised mask, not dilated.

      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

      const numContours = Math.min(contours.size(), this.maxCandidates);
      const polygons = [];

      for (let i = 0; i < numContours; i++) {
        // Cancel check inside the contour loop — large images can produce
        // hundreds of contours and this loop blocks the main thread.
        throwIfAborted();
        if (i % 50 === 0) await this._yieldContours();
        const contour = contours.get(i);
        let approx = null;
        try {
          // Minimum bounding side-length check (same as quad path)
          const rect = cv.minAreaRect(contour);
          const sside = Math.min(rect.size.width, rect.size.height);
          if (sside < this.minSize) continue;

          // Score check using the contour's bounding area
          const score = this._polygonScoreFast(pred, W, H, contour);
          if (score < this.boxThresh) continue;

          // Approximate contour to reduce vertex count (matches Python approxPolyDP)
          const epsilon = 0.002 * cv.arcLength(contour, true);
          approx = new cv.Mat();
          cv.approxPolyDP(contour, approx, epsilon, true);

          // Need at least 3 points for a valid polygon
          if (approx.rows < 3) continue;

          // Unclip using the approximated contour points
          const pts = [];
          for (let r = 0; r < approx.rows; r++) {
            pts.push([approx.intAt(r, 0), approx.intAt(r, 1)]);
          }
          const unclipped = unclipPolygon(pts, this.unclipRatio);
          if (unclipped.length < 3) continue;

          // Scale from detection-map coordinates → original image coordinates
          const scaledPoly = unclipped.map(([x, y]) => [
            Math.max(0, Math.min(Math.round(x / W * srcW), srcW)),
            Math.max(0, Math.min(Math.round(y / H * srcH), srcH)),
          ]);

          polygons.push(scaledPoly);
        } catch (err) {
          if (err instanceof AbortException) throw err;
          // Skip failed contour, continue
        } finally {
          contour.delete?.();
          if (approx) deleteMat(approx);
        }
      }

      return polygons;
    } finally {
      deleteMat(mask);
      if (contours) contours.delete();
      deleteMat(hierarchy);
    }
  }

  /**
   * Score a polygon region using the raw probability bitmap.
   * Uses the contour directly for mask filling (more accurate than bounding-box for curved text).
   * @private
   */
  _polygonScoreFast(bitmap, W, H, contour) {
    const rect = contour.boundingRect();
    const xmin = Math.max(0, rect.x);
    const ymin = Math.max(0, rect.y);
    const xmax = Math.min(W - 1, rect.x + rect.width);
    const ymax = Math.min(H - 1, rect.y + rect.height);

    const maskH = ymax - ymin + 1;
    const maskW = xmax - xmin + 1;
    if (maskH <= 0 || maskW <= 0) return 0;

    // Shift contour points to the ROI coordinate system
    const pts = [];
    for (let r = 0; r < contour.rows; r++) {
      pts.push([contour.intAt(r, 0) - xmin, contour.intAt(r, 1) - ymin]);
    }

    let roiMat = null;
    let ptsM = null;
    let ptsVec = null;

    try {
      roiMat = new cv.Mat(maskH, maskW, cv.CV_8UC1, new cv.Scalar(0));
      ptsM = cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flat().map(Math.round));
      ptsVec = new cv.MatVector();
      ptsVec.push_back(ptsM);
      cv.fillPoly(roiMat, ptsVec, new cv.Scalar(1));

      let sum = 0, count = 0;
      const maskData = roiMat.data;
      for (let y = 0; y < maskH; y++) {
        for (let x = 0; x < maskW; x++) {
          if (maskData[y * maskW + x] > 0) {
            sum += bitmap[(ymin + y) * W + (xmin + x)];
            count++;
          }
        }
      }
      return count > 0 ? sum / count : 0;
    } finally {
      deleteMat(roiMat);
      deleteMat(ptsM);
      if (ptsVec) ptsVec.delete();
    }
  }

  /** @private */
  _binarize(pred, H, W) {
    const segmentation = new Uint8Array(H * W);
    for (let i = 0; i < H * W; i++) {
      segmentation[i] = pred[i] > this.thresh ? 1 : 0;
    }
    return segmentation;
  }

  /** @private */
  _applyDilation(mask) {
    if (!this.useDilation || !this._dilationKernelMat) return mask;

    // Porting fix: Reuse the cached kernel Mat instead of allocating a new one.
    const dilated = new cv.Mat();
    try {
      cv.dilate(mask, dilated, this._dilationKernelMat);
      deleteMat(mask);
      return dilated;
    } catch (err) {
      deleteMat(dilated);
      throw err;
    }
  }

  /** @private */
  async _processContours(contours, pred, W, H, srcH, srcW) {
    const boxes = [];
    const scores = [];
    const numContours = Math.min(contours.size(), this.maxCandidates);

    // Porting fix: Hoist the quad-points cv.Mat and its MatVector out of the
    // hot contour loop. The pts Mat always has shape 4×1 CV_32SC2 (4 corners, x/y
    // int32); pre-allocating once and updating data in-place via data32S avoids a
    // per-iteration WASM heap alloc + data copy for every contour.
    //
    // Note: maskMat inside _boxScoreFast CANNOT be hoisted — its shape (maskH×maskW)
    // changes per contour because it mirrors each contour's individual bounding rect.
    let hoistedPtsMat = null;
    let hoistedPtsVec = null;
    try {
      hoistedPtsMat = new cv.Mat(4, 1, cv.CV_32SC2);
      hoistedPtsVec = new cv.MatVector();
      hoistedPtsVec.push_back(hoistedPtsMat);

      for (let i = 0; i < numContours; i++) {
        throwIfAborted();
        // Yield every 50 contours so large detection maps (hundreds of
        // contours) don't freeze the UI between inference batches.
        if (i % 50 === 0) await this._yieldContours();
        const contour = contours.get(i);
        try {
          const result = this._processSingleContour(contour, pred, W, H, srcH, srcW, hoistedPtsMat, hoistedPtsVec);
          if (result) {
            boxes.push(result.box);
            scores.push(result.score);
          }
        } catch (err) {
          if (err instanceof AbortException) throw err;
          // Skip failed contour, continue processing others
          continue;
        } finally {
          contour.delete?.();
        }
      }
    } finally {
      if (hoistedPtsVec) hoistedPtsVec.delete();
      deleteMat(hoistedPtsMat);
    }

    return { boxes, scores };
  }

  /** @private */
  async _yieldContours() {
    const { yieldToBrowser } = await import('../../utils/browser_utils.js');
    await yieldToBrowser();
  }

  /** @private */
  _processSingleContour(contour, pred, W, H, srcH, srcW, hoistedPtsMat, hoistedPtsVec) {
    const { box: points, sside } = this._getMiniBoxes(contour);
    if (sside < this.minSize) return null;

    const score = this._boxScoreFast(pred, W, H, points, hoistedPtsMat, hoistedPtsVec);
    if (score < this.boxThresh) return null;

    const unclipped = unclipPolygon(points, this.unclipRatio);
    const { box: finalBox, sside: finalSside } = this._getMiniBoxes(unclipped);
    if (finalSside < this.minSize + 2) return null;

    const scaledBox = finalBox.map(([x, y]) => [
      Math.max(0, Math.min(Math.round(x / W * srcW), srcW)),
      Math.max(0, Math.min(Math.round(y / H * srcH), srcH)),
    ]);

    return { box: scaledBox, score };
  }

  /**
   * Porting fix: Accept optional hoisted pts Mat + MatVector to avoid
   * per-call cv.matFromArray allocation for the 4 box corner points.
   * When hoistedPtsMat/Vec are provided the method writes corner data in-place
   * via data32S; they must have shape 4×1 CV_32SC2 and already be pushed into
   * the MatVector. The maskMat is still allocated per-call because its
   * dimensions (maskH × maskW) differ per contour and cannot be pre-allocated.
   *
   * @param {Float32Array} bitmap
   * @param {number} W
   * @param {number} H
   * @param {Array<[number,number]>} box
   * @param {cv.Mat|null} [hoistedPtsMat]
   * @param {cv.MatVector|null} [hoistedPtsVec]
   */
  _boxScoreFast(bitmap, W, H, box, hoistedPtsMat = null, hoistedPtsVec = null) {
    const xs = box.map(p => p[0]);
    const ys = box.map(p => p[1]);
    const xmin = Math.max(0, Math.floor(Math.min(...xs)));
    const xmax = Math.min(W - 1, Math.ceil(Math.max(...xs)));
    const ymin = Math.max(0, Math.floor(Math.min(...ys)));
    const ymax = Math.min(H - 1, Math.ceil(Math.max(...ys)));

    const maskH = ymax - ymin + 1;
    const maskW = xmax - xmin + 1;
    const shiftedBox = box.map(([x, y]) => [x - xmin, y - ymin]);

    // Build pts Mat — reuse hoisted allocation when caller provides one.
    let pts = null;
    let ptsList = null;
    let ownedPts = false;
    let ownedVec = false;
    if (hoistedPtsMat && hoistedPtsVec) {
      // Write corner data in-place (4 points × 2 int32 values = 8 elements)
      const d = hoistedPtsMat.data32S;
      for (let k = 0; k < 4; k++) {
        d[k * 2]     = Math.round(shiftedBox[k][0]);
        d[k * 2 + 1] = Math.round(shiftedBox[k][1]);
      }
      pts = hoistedPtsMat;
      ptsList = hoistedPtsVec;
    } else {
      pts = cv.matFromArray(4, 1, cv.CV_32SC2, shiftedBox.flat().map(Math.round));
      ptsList = new cv.MatVector();
      ptsList.push_back(pts);
      ownedPts = true;
      ownedVec = true;
    }

    // maskMat shape varies per contour — must be allocated here
    let maskMat = null;
    try {
      maskMat = new cv.Mat(maskH, maskW, cv.CV_8UC1, new cv.Scalar(0));
      cv.fillPoly(maskMat, ptsList, new cv.Scalar(1));

      let sum = 0, count = 0;
      const maskData = maskMat.data;
      for (let y = 0; y < maskH; y++) {
        for (let x = 0; x < maskW; x++) {
          if (maskData[y * maskW + x] > 0) {
            sum += bitmap[(ymin + y) * W + (xmin + x)];
            count++;
          }
        }
      }
      return count > 0 ? sum / count : 0;
    } finally {
      deleteMat(maskMat);
      if (ownedVec && ptsList) ptsList.delete();
      if (ownedPts) deleteMat(pts);
    }
  }

  /**
   * Get minimum area rectangle with proper point ordering.
   * @param {cv.Mat|Array} contourOrPoints
   * @returns {{ box: Array<[number,number]>, sside: number }}
   */
  _getMiniBoxes(contourOrPoints) {
    let rect;
    if (contourOrPoints.matSize) {
      rect = cv.minAreaRect(contourOrPoints);
    } else {
      const mat = cv.matFromArray(contourOrPoints.length, 1, cv.CV_32FC2, contourOrPoints.flat());
      try {
        rect = cv.minAreaRect(mat);
      } finally {
        deleteMat(mat);
      }
    }

    const rawBox = safeBoxPoints(rect);
    const sside = Math.min(rect.size.width, rect.size.height);

    const sorted = [...rawBox].sort((a, b) => a[0] - b[0]);

    let index_1, index_2, index_3, index_4;
    if (sorted[1][1] > sorted[0][1]) { index_1 = 0; index_4 = 1; }
    else { index_1 = 1; index_4 = 0; }
    if (sorted[3][1] > sorted[2][1]) { index_2 = 2; index_3 = 3; }
    else { index_2 = 3; index_3 = 2; }

    const box = [sorted[index_1], sorted[index_2], sorted[index_3], sorted[index_4]];
    return { box, sside };
  }

  _filterDetRes(boxes, scores, imgHeight, imgWidth) {
    const newBoxes = [];
    for (let i = 0; i < boxes.length; i++) {
      const box = this._orderPointsClockwise(boxes[i]);
      const clipped = this._clipDetRes(box, imgHeight, imgWidth);

      const dx01 = clipped[1][0] - clipped[0][0];
      const dy01 = clipped[1][1] - clipped[0][1];
      const dx03 = clipped[3][0] - clipped[0][0];
      const dy03 = clipped[3][1] - clipped[0][1];

      const rectWidth = Math.round(Math.sqrt(dx01 * dx01 + dy01 * dy01));
      const rectHeight = Math.round(Math.sqrt(dx03 * dx03 + dy03 * dy03));

      if (rectWidth <= MIN_RECT_SIDE || rectHeight <= MIN_RECT_SIDE) continue;
      newBoxes.push(clipped);
    }
    return newBoxes;
  }

  _orderPointsClockwise(pts) {
    const sorted = [...pts].sort((a, b) => a[0] - b[0]);
    const leftMost = sorted.slice(0, 2);
    const rightMost = sorted.slice(2, 4);
    leftMost.sort((a, b) => a[1] - b[1]);
    rightMost.sort((a, b) => a[1] - b[1]);
    return [leftMost[0], rightMost[0], rightMost[1], leftMost[1]];
  }

  _clipDetRes(points, imgHeight, imgWidth) {
    return points.map(([x, y]) => [
      Math.max(0, Math.min(Math.round(x), imgWidth - 1)),
      Math.max(0, Math.min(Math.round(y), imgHeight - 1)),
    ]);
  }
}
