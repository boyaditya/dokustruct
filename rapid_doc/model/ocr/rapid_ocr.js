/**
 * PORTING NOTE: rapid_doc/model/ocr/rapid_ocr.py → rapid_ocr.js
 *
 * RapidOcrModel: text detection + recognition pipeline using PaddleOCR ONNX models.
 *
 * MAJOR ARCHITECTURE CHANGE:
 *   Python uses the `rapidocr` library which wraps PaddleOCR models internally.
 *   JS re-implements the same pipeline directly with onnxruntime-web:
 *     1. DB (Differentiable Binarization) text detector.
 *     2. CRNN text recognizer with CTC decoding.
 *
 *   This follows the same internal structure as rapidocr itself, so the overall
 *   behaviour is preserved; only the implementation layer is replaced.
 *
 * CHANGES:
 *   __init__           → static async create(params)  [W1 factory pattern]
 *   cv2 ops            → global cv (OpenCV.js)
 *   numpy              → Float32Array / plain JS arrays
 *   tqdm               → optional onProgress callback
 *   loguru.logger      → console-based logger (getLogger)
 *   time.perf_counter  → performance.now() / 1000
 *   TextRecInput/Output→ plain JS objects
 *   CUDA/NPU paths     → WebGPU (auto-selected by ProviderConfig silently)
 *   OpenVINO path      → no-op (browser does not support OpenVINO)
 *
 * DEFAULT MODEL URLS (PP-OCRv5):
 *   Det: https://www.modelscope.cn/models/RapidAI/PP-OCRv5_det/resolve/main/PP-OCRv5_mobile_det.onnx
 *   Rec: https://www.modelscope.cn/models/RapidAI/PP-OCRv5_rec/resolve/main/PP-OCRv5_mobile_rec.onnx
 *   Override via params.detModelUrl / params.recModelUrl.
 *
 * REGARDING ocr_patch.js:
 *   apply_ocr_patch() is called at module load for parity. In JS it is a no-op.
 *   The TextDetector.get_preprocess fix (the primary reason for the patch) is
 *   baked into DetPreProcess below.
 */

/* global cv */
import * as ort from 'onnxruntime-web';
import { applyOcrPatch } from './ocr_patch.js';
import { getLogger } from '../../model/layout/rapid_layout_self/utils/logger.js';
import {
  checkImg, preprocessImage, sortedBoxes, mergeDetBoxes,
  updateDetBoxes, getRotateCropImage, calculateIsAngle,
} from '../../utils/ocr_utils.js';
import { configureOrtWasmRuntime } from '../../utils/ort_runtime.js';

// Apply patches (no-op in browser)
applyOcrPatch();

const logger = getLogger('RapidOcrModel');

/**
 * Safely extract the 4 corner points from a RotatedRect via cv.boxPoints.
 * Some OpenCV.js builds require an explicit output Mat and/or return
 * a Mat whose .data32F is undefined (different depth). This helper
 * handles all variants.
 *
 * @param {object} rect   RotatedRect from cv.minAreaRect
 * @returns {[[number,number],[number,number],[number,number],[number,number]]}
 */
function safeBoxPoints(rect) {
  // OpenCV.js 4.x (docs.opencv.org) only accepts 1-arg form.
  const pts = cv.boxPoints(rect);

  let coords;
  if (pts.data32F && pts.data32F.length >= 8) {
    const d = pts.data32F;
    coords = [[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]];
  } else if (pts.floatAt) {
    // Fallback: read element-by-element (works for any depth)
    coords = [];
    for (let r = 0; r < 4; r++) {
      coords.push([pts.floatAt(r, 0), pts.floatAt(r, 1)]);
    }
  } else {
    // Last resort: manual calculation from RotatedRect
    const cx = rect.center.x, cy = rect.center.y;
    const w = rect.size.width / 2, h = rect.size.height / 2;
    const a = (rect.angle * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    coords = [
      [cx - w * cos + h * sin, cy - w * sin - h * cos],
      [cx + w * cos + h * sin, cy + w * sin - h * cos],
      [cx + w * cos - h * sin, cy + w * sin + h * cos],
      [cx - w * cos - h * sin, cy - w * sin + h * cos],
    ];
  }

  if (pts && pts.delete) pts.delete();
  return coords;
}

// ─── Default model URLs ───────────────────────────────────────────────────────

// Models are served locally from public/models/ (Vite static assets).
// Run `python scripts/copy-models-to-public.py` to populate public/models/.
const DEFAULT_DET_MODEL_URL = '/models/ocr/ch_PP-OCRv5_mobile_det.onnx';
const DEFAULT_REC_MODEL_URL_CH = '/models/ocr/ch_PP-OCRv5_rec_mobile_infer.onnx';
const DEFAULT_REC_MODEL_URL_EN = '/models/ocr/en_PP-OCRv5_rec_mobile_infer.onnx';
const REMOTE_REC_MODEL_URL_EN_CANDIDATES = [
  'https://www.modelscope.cn/models/RapidAI/PP-OCRv5_rec/resolve/main/en_PP-OCRv5_rec_mobile_infer.onnx',
  'https://www.modelscope.cn/models/RapidAI/PP-OCRv5_rec/resolve/main/PP-OCRv5_mobile_rec.onnx',
];

// ─── DetPreProcess ────────────────────────────────────────────────────────────

/**
 * Preprocessing for PP-OCR DB text detection model.
 * Mirrors: rapidocr.ch_ppocr_det.DetPreProcess
 *
 * Steps:
 *   1. Limit the longer side to limit_side_len (aligned to 32).
 *   2. Normalise: (x / 255 - mean) / std per channel.
 *   3. Transpose HWC → NCHW, output as Float32Array.
 *
 * The patched version (from ocr_patch.py) passes (max_side_len, limit_type, mean, std)
 * directly — this is baked in here.
 */
class DetPreProcess {
  /**
   * @param {number}   limitSideLen    - e.g. 960
   * @param {string}   limitType       - 'max' or 'min'
   * @param {number[]} mean            - [0.485, 0.456, 0.406]
   * @param {number[]} std             - [0.229, 0.224, 0.225]
   */
  constructor(limitSideLen = 960, limitType = 'max', mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225]) {
    this.limitSideLen = limitSideLen;
    this.limitType    = limitType;
    this.mean         = mean;
    this.std          = std;
  }

  /**
   * @param {cv.Mat} img   - BGR, uint8
   * @returns {{ data: Float32Array, shape: [1,3,number,number], ratio: number }}
   */
  call(img) {
    const srcH = img.rows;
    const srcW = img.cols;

    // Compute scale
    let ratio;
    if (this.limitType === 'max') {
      ratio = this.limitSideLen / Math.max(srcH, srcW);
    } else {
      ratio = this.limitSideLen / Math.min(srcH, srcW);
    }
    if (ratio > 1) ratio = 1;   // do not up-scale

    // Align target dimensions to multiple of 32
    const tgtH = Math.max(32, Math.round(srcH * ratio / 32) * 32);
    const tgtW = Math.max(32, Math.round(srcW * ratio / 32) * 32);
    const actualRatio = { h: tgtH / srcH, w: tgtW / srcW };

    // Resize
    const resized = new cv.Mat();
    cv.resize(img, resized, new cv.Size(tgtW, tgtH), 0, 0, cv.INTER_LINEAR);

    // Normalise HWC → NCHW Float32Array
    const H = resized.rows;
    const W = resized.cols;
    const channels = resized.channels();
    const raw = resized.data;  // Uint8Array, BGR layout
    const data = new Float32Array(H * W * 3);
    const [m0, m1, m2] = [this.mean[0], this.mean[1], this.mean[2]];
    const [s0, s1, s2] = [this.std[0],  this.std[1],  this.std[2]];

    for (let h = 0; h < H; h++) {
      for (let w = 0; w < W; w++) {
        const off = (h * W + w) * channels;
        const b = raw[off] / 255;
        const g = raw[off + 1] / 255;
        const r = raw[off + 2] / 255;
        // Native rapidocr parity: cv2 BGR image is normalized channel-wise
        // without RGB reordering before transpose.
        data[0 * H * W + h * W + w] = (b - m0) / s0;
        data[1 * H * W + h * W + w] = (g - m1) / s1;
        data[2 * H * W + h * W + w] = (r - m2) / s2;
      }
    }

    resized.delete();
    return { data, shape: [1, 3, H, W], ratio: actualRatio };
  }
}

// ─── DB Post-Process helpers ──────────────────────────────────────────────────

function _polygonArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return Math.abs(area) / 2;
}

function _polygonPerimeter(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1];
    p += Math.sqrt(dx * dx + dy * dy);
  }
  return p;
}

function _unclipPolygon(pts, unclipRatio) {
  /* global cv */
  // Port of Python pyclipper-based unclip using OpenCV approximation
  // Python: distance = poly.area * unclip_ratio / poly.length
  //         offset = pyclipper.PyclipperOffset()
  //         offset.AddPath(box, pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
  //         expanded = offset.Execute(distance)
  
  const area = _polygonArea(pts);
  const perimeter = _polygonPerimeter(pts);
  const distance = area * unclipRatio / perimeter;
  
  // OpenCV-based polygon expansion (approximates pyclipper)
  // Create a binary mask with the polygon
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  const minX = Math.floor(Math.min(...xs));
  const minY = Math.floor(Math.min(...ys));
  const maxX = Math.ceil(Math.max(...xs));
  const maxY = Math.ceil(Math.max(...ys));
  
  const w = maxX - minX + Math.ceil(distance) * 4;
  const h = maxY - minY + Math.ceil(distance) * 4;
  const offset = Math.ceil(distance) * 2;
  
  // Shift points to mask coordinates
  const shiftedPts = pts.map(([x, y]) => [x - minX + offset, y - minY + offset]);
  
  // Create mask and fill polygon
  const mask = new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(0));
  const ptsMat = cv.matFromArray(shiftedPts.length, 1, cv.CV_32SC2, shiftedPts.flat().map(Math.round));
  const ptsVec = new cv.MatVector();
  ptsVec.push_back(ptsMat);
  cv.fillPoly(mask, ptsVec, new cv.Scalar(255));
  
  // Dilate to expand polygon
  const kernelSize = Math.max(1, Math.round(distance));
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kernelSize * 2 + 1, kernelSize * 2 + 1));
  const dilated = new cv.Mat();
  cv.dilate(mask, dilated, kernel);
  
  // Find contours of dilated mask
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  
  let expandedPts = pts; // fallback
  if (contours.size() > 0) {
    // Get the largest contour
    let maxArea = 0;
    let maxIdx = 0;
    for (let i = 0; i < contours.size(); i++) {
      const area = cv.contourArea(contours.get(i));
      if (area > maxArea) {
        maxArea = area;
        maxIdx = i;
      }
    }
    
    const contour = contours.get(maxIdx);
    // Approximate contour to reduce points
    const epsilon = 0.01 * cv.arcLength(contour, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(contour, approx, epsilon, true);
    
    // Extract points and shift back to original coordinates
    expandedPts = [];
    for (let i = 0; i < approx.rows; i++) {
      const x = approx.intAt(i, 0) - offset + minX;
      const y = approx.intAt(i, 1) - offset + minY;
      expandedPts.push([x, y]);
    }
    
    approx.delete();
  }
  
  // Cleanup
  mask.delete();
  dilated.delete();
  kernel.delete();
  ptsMat.delete();
  ptsVec.delete();
  contours.delete();
  hierarchy.delete();
  
  return expandedPts;
}

// ─── DetPostProcess ───────────────────────────────────────────────────────────

class DetPostProcess {
  /**
   * Full port of rapidocr DBPostProcess
   * @param {number} [thresh=0.3]
   * @param {number} [boxThresh=0.5]
   * @param {number} [unclipRatio=1.6]
   * @param {number} [minSize=3]
   * @param {boolean} [useDilation=true]
   * @param {number} [maxCandidates=1000]
   */
  constructor(thresh = 0.3, boxThresh = 0.5, unclipRatio = 1.6, minSize = 3, useDilation = true, maxCandidates = 1000) {
    this.thresh      = thresh;
    this.boxThresh   = boxThresh;
    this.unclipRatio = unclipRatio;
    this.minSize     = minSize;
    this.useDilation = useDilation;
    this.maxCandidates = maxCandidates;
    this.dilationKernel = useDilation ? [[1, 1], [1, 1]] : null;
  }

  /**
   * Convert DB probability map to list of 4-vertex boxes.
   * Exact port of rapidocr DBPostProcess.__call__
   *
   * @param {ort.Tensor} predTensor   - shape [1, 1, H, W] (float32)
   * @param {{ h:number, w:number }} ratio  - scale factors from DetPreProcess
   * @param {[number,number]}         oriShape  - [oriH, oriW]
   * @returns {Array<Array<[number,number]>>}  - list of 4-vertex quads
   */
  call(predTensor, ratio, oriShape) {
    const [srcH, srcW] = oriShape;
    const pred = predTensor.data;
    const [, , H, W] = predTensor.dims;
    
    // Binarize using configured threshold
    const segmentation = new Uint8Array(H * W);
    for (let i = 0; i < H * W; i++) {
      segmentation[i] = pred[i] > this.thresh ? 1 : 0;
    }
    
    // Apply dilation if enabled
    /* global cv */
    let mask = cv.matFromArray(H, W, cv.CV_8UC1, Array.from(segmentation));
    if (this.useDilation && this.dilationKernel) {
      const kernel = cv.matFromArray(2, 2, cv.CV_8UC1, [1, 1, 1, 1]);
      const dilated = new cv.Mat();
      cv.dilate(mask, dilated, kernel);
      mask.delete();
      mask = dilated;
      kernel.delete();
    }
    
    // Find contours
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    
    const boxes = [];
    const scores = [];
    const numContours = Math.min(contours.size(), 1000); // max_candidates
    
    for (let i = 0; i < numContours; i++) {
      const contour = contours.get(i);
      
      // Get min area rect with proper ordering (Python get_mini_boxes)
      const { box: points, sside } = this._getMiniBoxes(contour);
      
      // Check min size before unclip
      if (sside < this.minSize) continue;
      
      // Calculate score
      const score = this._boxScoreFast(pred, W, H, points);
      if (score < this.boxThresh) continue;
      
      // Unclip
      const unclipped = _unclipPolygon(points, this.unclipRatio);
      
      // Get final box after unclip
      const { box: finalBox, sside: finalSside } = this._getMiniBoxes(unclipped);
      
      // Check min size after unclip (min_size + 2)
      if (finalSside < this.minSize + 2) continue;
      
      // Scale to original image size
      const scaledBox = finalBox.map(([x, y]) => [
        Math.max(0, Math.min(Math.round(x / W * srcW), srcW)),
        Math.max(0, Math.min(Math.round(y / H * srcH), srcH))
      ]);
      
      boxes.push(scaledBox);
      scores.push(score);
    }
    
    mask.delete();
    contours.delete();
    hierarchy.delete();
    
    // Filter boxes (Python filter_det_res)
    return this._filterDetRes(boxes, scores, srcH, srcW);
  }

  _boxScoreFast(bitmap, W, H, box) {
    // Exact port of box_score_fast
    const xs = box.map(p => p[0]);
    const ys = box.map(p => p[1]);
    const xmin = Math.max(0, Math.floor(Math.min(...xs)));
    const xmax = Math.min(W - 1, Math.ceil(Math.max(...xs)));
    const ymin = Math.max(0, Math.floor(Math.min(...ys)));
    const ymax = Math.min(H - 1, Math.ceil(Math.max(...ys)));

    // Create mask for polygon
    const maskH = ymax - ymin + 1;
    const maskW = xmax - xmin + 1;
    const mask = new Uint8Array(maskH * maskW);
    
    // Shift box to mask coordinates
    const shiftedBox = box.map(([x, y]) => [x - xmin, y - ymin]);
    
    // Fill polygon using OpenCV
    const maskMat = cv.matFromArray(maskH, maskW, cv.CV_8UC1, Array.from(mask));
    const pts = cv.matFromArray(4, 1, cv.CV_32SC2, shiftedBox.flat().map(Math.round));
    const ptsList = new cv.MatVector();
    ptsList.push_back(pts);
    cv.fillPoly(maskMat, ptsList, new cv.Scalar(1));
    
    // Calculate mean score
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
    
    maskMat.delete();
    pts.delete();
    ptsList.delete();
    
    return count > 0 ? sum / count : 0;
  }

  /**
   * Port of Python get_mini_boxes: get minimum area rectangle with proper point ordering
   * @param {cv.Mat|Array} contourOrPoints - OpenCV contour or array of points
   * @returns {{ box: Array<[number,number]>, sside: number }}
   */
  _getMiniBoxes(contourOrPoints) {
    /* global cv */
    let rect;
    if (contourOrPoints.matSize) {
      // It's a cv.Mat (contour)
      rect = cv.minAreaRect(contourOrPoints);
    } else {
      // It's an array of points
      const mat = cv.matFromArray(contourOrPoints.length, 1, cv.CV_32FC2, contourOrPoints.flat());
      rect = cv.minAreaRect(mat);
      mat.delete();
    }
    
    const rawBox = safeBoxPoints(rect);
    const sside = Math.min(rect.size.width, rect.size.height);
    
    // Sort by x coordinate
    const sorted = [...rawBox].sort((a, b) => a[0] - b[0]);
    
    // Apply Python's ordering logic
    let index_1, index_2, index_3, index_4;
    
    if (sorted[1][1] > sorted[0][1]) {
      index_1 = 0;
      index_4 = 1;
    } else {
      index_1 = 1;
      index_4 = 0;
    }
    
    if (sorted[3][1] > sorted[2][1]) {
      index_2 = 2;
      index_3 = 3;
    } else {
      index_2 = 3;
      index_3 = 2;
    }
    
    const box = [sorted[index_1], sorted[index_2], sorted[index_3], sorted[index_4]];
    return { box, sside };
  }

  _getMinAreaBox(points) {
    // Wrapper for backward compatibility
    return this._getMiniBoxes(points).box;
  }

  /**
   * Exact port of filter_det_res
   */
  _filterDetRes(boxes, scores, imgHeight, imgWidth) {
    const newBoxes = [];
    const newScores = [];
    
    for (let i = 0; i < boxes.length; i++) {
      const box = this._orderPointsClockwise(boxes[i]);
      const clipped = this._clipDetRes(box, imgHeight, imgWidth);
      
      // Calculate rect dimensions
      const dx01 = clipped[1][0] - clipped[0][0];
      const dy01 = clipped[1][1] - clipped[0][1];
      const dx03 = clipped[3][0] - clipped[0][0];
      const dy03 = clipped[3][1] - clipped[0][1];
      
      const rectWidth = Math.round(Math.sqrt(dx01 * dx01 + dy01 * dy01));
      const rectHeight = Math.round(Math.sqrt(dx03 * dx03 + dy03 * dy03));
      
      // Python: if rect_width <= 3 or rect_height <= 3: continue
      if (rectWidth <= 3 || rectHeight <= 3) {
        continue;
      }
      
      newBoxes.push(clipped);
      newScores.push(scores[i]);
    }
    
    return newBoxes;
  }

  _orderPointsClockwise(pts) {
    // Exact port of order_points_clockwise
    const sorted = [...pts].sort((a, b) => a[0] - b[0]);
    const leftMost = sorted.slice(0, 2);
    const rightMost = sorted.slice(2, 4);
    
    leftMost.sort((a, b) => a[1] - b[1]);
    const [tl, bl] = leftMost;
    
    rightMost.sort((a, b) => a[1] - b[1]);
    const [tr, br] = rightMost;
    
    return [tl, tr, br, bl];
  }

  _clipDetRes(points, imgHeight, imgWidth) {
    // Exact port of clip_det_res
    return points.map(([x, y]) => [
      Math.max(0, Math.min(Math.round(x), imgWidth - 1)),
      Math.max(0, Math.min(Math.round(y), imgHeight - 1))
    ]);
  }
}

// ─── RecPreProcess ────────────────────────────────────────────────────────────

class RecPreProcess {
  /**
   * @param {[number,number,number]} recImageShape  - [C, H, W] e.g. [3, 48, 320]
   */
  constructor(recImageShape = [3, 48, 320]) {
    this.recImageShape = recImageShape;
  }

  /**
   * Resize a crop to fixed height while preserving aspect ratio,
   * then normalise to [-1, 1].
   * Mirrors: TextRecognizer.resize_norm_img
   *
   * @param {cv.Mat} img         - BGR crop (not modified, caller retains ownership)
   * @param {number} maxWhRatio  - max W/H ratio for the whole batch
   * @returns {{ data: Float32Array, shape: [1, 3, number, number] }}
   */
  call(img, maxWhRatio) {
    const [, imgH, imgW] = this.recImageShape;
    const srcH = img.rows;
    const srcW = img.cols;
    const ratio = srcW / srcH;

    // Mirror python: img_width = int(img_height * max_wh_ratio)
    // and resized_w = min(ceil(img_height * ratio), img_width)
    const targetW = Math.max(1, Math.floor(imgH * maxWhRatio));
    const resizedW = Math.min(targetW, Math.max(1, Math.ceil(imgH * ratio)));

    const resized = new cv.Mat();
    cv.resize(img, resized, new cv.Size(resizedW, imgH), 0, 0, cv.INTER_LINEAR);

    const H = resized.rows;
    const channels = resized.channels();
    const raw = resized.data;
    const data = new Float32Array(imgH * targetW * 3);

    // OPTIMIZATION: Cache offset multipliers to avoid recalculating in the inner loop.
    const area = imgH * targetW;
    const area2 = area * 2;
    
    for (let h = 0; h < H; h++) {
      const srcRowOff = h * resizedW * channels;
      const dstRowOff = h * targetW;
      for (let w = 0; w < resizedW; w++) {
        const off = srcRowOff + w * channels;
        const dstOff = dstRowOff + w;
        
        // (x / 255) * 2 - 1  => x / 127.5 - 1
        data[dstOff]         = raw[off]     / 127.5 - 1; // B
        data[area + dstOff]  = raw[off + 1] / 127.5 - 1; // G
        data[area2 + dstOff] = raw[off + 2] / 127.5 - 1; // R
      }
    }
    resized.delete();
    return { data, shape: [1, 3, imgH, targetW] };
  }
}

// ─── CTC decode ───────────────────────────────────────────────────────────────

/**
 * CTC greedy decode with optional character position tracking.
 * Mirrors: rapidocr CTCLabelDecode
 *
 * @param {Float32Array} preds        - [T, numChars] flattened logits
 * @param {number}       T             - time steps
 * @param {number}       numChars
 * @param {string[]}     charList      - character vocabulary
 * @param {boolean}      returnWordBox - track character positions for word boxes
 * @returns {{ text: string, score: number, selection?: boolean[], validCols?: number[] }}
 */
function ctcDecode(preds, T, numChars, charList, returnWordBox = false) {
  let text  = '';
  let scoreSum = 0;
  let scoreCount = 0;
  let prevIdx = null;
  
  // Track character positions for word box calculation
  const selection = returnWordBox ? new Array(T).fill(false) : null;

  // Native rapidocr parity: character list is prepared as
  // ["blank", ...dictChars, " "] and decoder ignores index 0.
  const hasLeadingBlank = charList.length > 0 && charList[0] === 'blank';
  const directIndexMode = hasLeadingBlank && charList.length === numChars;

  // Compatibility fallback for old list format without explicit leading blank.
  const shiftedIndexMode = !directIndexMode && (numChars === charList.length + 1);
  const blankIdx = 0;

  for (let t = 0; t < T; t++) {
    const off = t * numChars;
    // OPTIMIZATION: Reduce array lookups and use local variables for argmax.
    let maxVal = preds[off];
    let maxIdx = 0;
    
    for (let c = 1; c < numChars; c++) {
      const val = preds[off + c];
      if (val > maxVal) { 
        maxVal = val; 
        maxIdx = c; 
      }
    }

    const isDuplicate = prevIdx !== null && maxIdx === prevIdx;
    if (maxIdx !== blankIdx && !isDuplicate) {
      const charIdx = shiftedIndexMode ? (maxIdx - 1) : maxIdx;
      const ch = charList[charIdx];
      if (ch !== undefined) {
        text += ch;
        scoreSum += maxVal;
        scoreCount++;
        if (selection) selection[t] = true;
      }
    }
    prevIdx = maxIdx;
  }

  const score = scoreCount > 0 ? scoreSum / scoreCount : 0;
  const result = { text, score };
  
  if (returnWordBox && selection) {
    // Extract valid column indices where characters appear
    const validCols = [];
    for (let t = 0; t < T; t++) {
      if (selection[t]) validCols.push(t);
    }
    result.selection = selection;
    result.validCols = validCols;
  }
  
  return result;
}

// ─── getWordInfo ──────────────────────────────────────────────────────────────

/**
 * Group decoded characters into words with position tracking.
 * Mirrors: rapidocr/ch_ppocr_rec/utils.py get_word_info
 * 
 * @param {string} text - Decoded text
 * @param {number[]} validCols - Column indices where characters appear
 * @returns {{ words: string[][], wordCols: number[][], wordTypes: string[], lineTxtLen: number, confs: number[] }}
 */
function getWordInfo(text, validCols) {
  const wordList = [];
  const wordColList = [];
  const stateList = [];
  
  let wordContent = [];
  let wordColContent = [];
  
  if (validCols.length === 0) {
    return { words: [], wordCols: [], wordTypes: [], lineTxtLen: 0, confs: [] };
  }
  
  // Calculate column widths
  const colWidth = new Array(validCols.length);
  for (let i = 1; i < validCols.length; i++) {
    colWidth[i] = validCols[i] - validCols[i - 1];
  }
  // First column width: min(3 for Chinese / 2 for others, actual position)
  const hasChinese = (char) => /[\u4e00-\u9fa5]/.test(char);
  colWidth[0] = Math.min(hasChinese(text[0]) ? 3 : 2, validCols[0]);
  
  let state = null;
  
  for (let cI = 0; cI < text.length; cI++) {
    const char = text[cI];
    
    // Skip whitespace
    if (/\s/.test(char)) {
      if (wordContent.length > 0) {
        wordList.push(wordContent);
        wordColList.push(wordColContent);
        stateList.push(state);
        wordContent = [];
        wordColContent = [];
      }
      continue;
    }
    
    // Determine character type
    const cState = hasChinese(char) ? 'CN' : 'EN_NUM';
    if (state === null) {
      state = cState;
    }
    
    // Split on type change or large gap
    if (state !== cState || (colWidth[cI] && colWidth[cI] > 5)) {
      if (wordContent.length > 0) {
        wordList.push(wordContent);
        wordColList.push(wordColContent);
        stateList.push(state);
        wordContent = [];
        wordColContent = [];
      }
      state = cState;
    }
    
    wordContent.push(char);
    wordColContent.push(validCols[cI]);
  }
  
  // Add last word
  if (wordContent.length > 0) {
    wordList.push(wordContent);
    wordColList.push(wordColContent);
    stateList.push(state);
  }
  
  return {
    words: wordList,
    wordCols: wordColList,
    wordTypes: stateList,
    lineTxtLen: validCols.length,
    confs: []
  };
}

// ─── TextDetector ────────────────────────────────────────────────────────────

class TextDetector {
  constructor(session, detPreProcess, detPostProcess) {
    this.session      = session;
    this.preProcess   = detPreProcess;
    this.postProcess  = detPostProcess;
  }

  /**
   * @param {cv.Mat} img
   * @returns {{ boxes: Array<Array<[number,number]>>|null, elapse: number }}
   */
  async call(img) {
    const t0 = performance.now();
    const { data, shape, ratio } = this.preProcess.call(img);
    const inputName = this.session.inputNames?.[0] ?? 'x';
    let results, tensor;
    try {
      tensor = new ort.Tensor('float32', data, shape);
      results = await this.session.run({ [inputName]: tensor });

      // Retrieve first output tensor by position — avoids outputNames key-mismatch.
      // Works with both plain object and Map returns from session.run.
      const predTensor = results instanceof Map
        ? results.values().next().value
        : Object.values(results)[0];
      if (!predTensor?.dims?.length) {
        console.warn('[TextDetector] inference returned no valid output tensor; dims:', predTensor?.dims);
        return { boxes: null, elapse: (performance.now() - t0) / 1000 };
      }

      // WEBGPU FIX: If data is on GPU, download it to CPU before post-processing.
      // This handles the "The data is not on CPU" error.
      const predData = typeof predTensor.getData === 'function'
        ? await predTensor.getData()
        : predTensor.data;

      const boxes  = this.postProcess.call({ ...predTensor, data: predData }, ratio, [img.rows, img.cols]);
      const elapse = (performance.now() - t0) / 1000;
      return { boxes: boxes.length > 0 ? boxes : null, elapse };
    } catch (err) {
      console.warn('[TextDetector] session.run failed:', err?.message ?? err);
      return { boxes: null, elapse: (performance.now() - t0) / 1000 };
    } finally {
      // Memory cleanup: dispose input tensor and all output tensors
      if (tensor?.dispose) tensor.dispose();
      if (results) {
        for (const t of (results instanceof Map ? results.values() : Object.values(results))) {
          if (t?.dispose) t.dispose();
        }
      }
    }
  }
  }
import { acquireGlobalGpu } from '../../utils/ort_runtime.js';

// ─── TextRecognizer ──────────────────────────────────────────────────────────

class TextRecognizer {
  /**
   * @param {ort.InferenceSession} session
   * @param {string[]}               charList
   * @param {number}                 recBatchNum
   * @param {[number,number,number]} recImageShape
   */
  constructor(session, charList, recBatchNum = 48, recImageShape = [3, 48, 320]) {
    this.session       = session;
    this.charList      = charList;
    this.recBatchNum   = recBatchNum;
    this.recImageShape = recImageShape;  // [C, H, W]
    this.preProcess    = new RecPreProcess(recImageShape);

    // Use the global mutex
    this._acquireGpu = acquireGlobalGpu;
  }

  /**
   * Recognise text in a list of image crops.
   *
   * @param {cv.Mat[]} crops
   * @param {boolean} returnWordBox - Return character-level bounding boxes
   * @returns {Promise<{txts: string[], scores: number[], wordResults?: any[][], elapse: number}>}
   */
  async call(crops, returnWordBox = false) {
    const t0 = performance.now();
    const imgH = this.recImageShape[1];
    const imgW = this.recImageShape[2];

    crops = crops.filter(c => c != null && typeof c.cols === 'number' && typeof c.rows === 'number');
    if (!crops.length) return { txts: [], scores: [], wordResults: [], elapse: 0 };

    const ratioList = crops.map(c => c.cols / c.rows);
    const indices   = [...ratioList.keys()].sort((a, b) => ratioList[a] - ratioList[b]);

    const txts   = new Array(crops.length).fill('');
    const scores = new Array(crops.length).fill(0);
    const wordResults = returnWordBox ? new Array(crops.length).fill(null) : null;

    const batchTasks = [];
    for (let beg = 0; beg < crops.length; beg += this.recBatchNum) {
      batchTasks.push({ beg, end: Math.min(crops.length, beg + this.recBatchNum) });
    }

    const processBatch = async (task) => {
      const { beg, end } = task;
      const batchI = indices.slice(beg, end);

      // ─── 1. CPU PREPROCESS (Runs concurrently) ───
      let maxWhRatio = batchI.reduce((m, i) => Math.max(m, ratioList[i]), imgW / imgH);
      maxWhRatio = Math.min(maxWhRatio, 32); 

      const bucketW = Math.ceil(Math.max(imgW, Math.floor(imgH * maxWhRatio)) / 160) * 160;
      maxWhRatio = bucketW / imgH;

      const batchData = [];
      let batchW = 0;
      for (const i of batchI) {
        const { data, shape } = this.preProcess.call(crops[i], maxWhRatio);
        batchData.push(data);
        batchW = shape[3];
      }

      const N = batchI.length;
      const paddedN = this.recBatchNum;
      const C = 3;
      const flat = new Float32Array(paddedN * C * imgH * batchW);
      batchData.forEach((d, b) => flat.set(d, b * C * imgH * batchW));

      // ─── 2. GPU INFERENCE (Strictly Serialized via Mutex) ───
      const recInputName = this.session.inputNames?.[0] ?? 'x';
      
      let res, tensor;
      let predDataFloat32 = null;
      let T = 0, numChars = 0;

      try {
        tensor = new ort.Tensor('float32', flat, [paddedN, C, imgH, batchW]);
        
        // Lock GPU just for the run command
        const releaseGpu = await this._acquireGpu();
        try {
          res = await this.session.run({ [recInputName]: tensor });
        } finally {
          // Hand off GPU to the next batch IMMEDIATELY!
          // Do not wait for .getData() mapAsync to finish.
          releaseGpu();
        }

        // Dispose input tensor early to keep VRAM flat
        if (tensor?.dispose) { tensor.dispose(); tensor = null; }

        const pred = res instanceof Map ? res.values().next().value : Object.values(res)[0];
        if (!pred?.dims?.length) throw new Error('[TextRecognizer] no valid output from rec session');
        
        T = Number(pred.dims[pred.dims.length - 2]);
        numChars = Number(pred.dims[pred.dims.length - 1]);

        // Download data to CPU (Asynchronous, runs concurrently with next batch's GPU inference)
        const rawData = typeof pred.getData === 'function' ? await pred.getData() : pred.data;
        predDataFloat32 = new Float32Array(rawData);

      } catch (err) {
        console.warn('[TextRecognizer] session.run failed:', err?.message ?? err);
      } finally {
        // Strict VRAM Disposal for any remaining tensors
        if (tensor?.dispose) tensor.dispose();
        if (res) {
          for (const t of (res instanceof Map ? res.values() : Object.values(res))) {
            if (t?.dispose) t.dispose();
          }
        }
      }

      // ─── 3. CPU POSTPROCESS (Runs concurrently) ───
      if (predDataFloat32) {
        for (let b = 0; b < N; b++) {
          const batchPred = predDataFloat32.subarray(b * T * numChars, (b + 1) * T * numChars);
          const decoded   = ctcDecode(batchPred, T, numChars, this.charList, returnWordBox);
          const origIdx = indices[beg + b];
          txts[origIdx]   = decoded.text;
          scores[origIdx] = decoded.score;
          
          if (returnWordBox && decoded.validCols) {
            // Calculate line_txt_len: len(token_indices) * wh_ratio / max_wh_ratio
            const lineTxtLen = T * ratioList[origIdx] / maxWhRatio;
            const wordInfo = getWordInfo(decoded.text, decoded.validCols);
            wordInfo.lineTxtLen = lineTxtLen;
            wordResults[origIdx] = wordInfo;
          }
        }
      }
    };

    // Overlapping Pipeline: Keep up to 5 batches in flight to ensure GPU is never starved
    const inFlight = new Set();
    for (const task of batchTasks) {
      const p = processBatch(task).finally(() => inFlight.delete(p));
      inFlight.add(p);
      if (inFlight.size >= 5) {
        await Promise.race(inFlight);
      }
      // Yield to event loop to allow Promises to resolve cleanly
      await new Promise(r => setTimeout(r, 0));
    }
    await Promise.all(inFlight);

    const elapse = (performance.now() - t0) / 1000;
    const result = { txts, scores, elapse };
    if (returnWordBox) result.wordResults = wordResults;
    return result;
  }
}

// ─── calRecBoxes ──────────────────────────────────────────────────────────────

/**
 * Calculate word-level bounding boxes from recognition results.
 * Mirrors: rapidocr/cal_rec_boxes/main.py CalRecBoxes
 * 
 * @param {cv.Mat[]} crops - Cropped images
 * @param {Array} dtBoxes - Detection boxes (4-point polygons)
 * @param {object} recRes - Recognition results with wordResults
 * @returns {Array} Word results [[text, score, bbox], ...]
 */
function calRecBoxes(crops, dtBoxes, recRes) {
  const wordResults = [];
  
  for (let idx = 0; idx < crops.length; idx++) {
    const img = crops[idx];
    const box = dtBoxes[idx];
    const wordInfo = recRes.wordResults?.[idx];
    
    if (!wordInfo || !img || img.rows === 0 || img.cols === 0) {
      wordResults.push([]);
      continue;
    }
    
    const h = img.rows;
    const w = img.cols;
    const imgBox = [[0, 0], [w, 0], [w, h], [0, h]];
    
    // Calculate word boxes in crop coordinates
    const wordBoxList = calOcrWordBox(recRes.txts[idx], imgBox, wordInfo);
    
    // Reverse perspective transform to original image coordinates
    const finalWordBoxList = reverseRotateCropImage(box, wordBoxList);
    
    // Format: [[text, score, bbox], ...]
    const wordResult = [];
    for (let i = 0; i < wordInfo.words.length; i++) {
      const text = wordInfo.words[i].join('');
      const score = recRes.scores[idx];
      const bbox = finalWordBoxList[i];
      wordResult.push([text, score, bbox]);
    }
    
    wordResults.push(wordResult);
  }
  
  return wordResults;
}

function calOcrWordBox(recTxt, bbox, wordInfo) {
  if (!recTxt || wordInfo.lineTxtLen === 0) {
    return [];
  }
  
  // Convert bbox to [x0, y0, x1, y1]
  const bboxRect = [
    Math.min(bbox[0][0], bbox[1][0], bbox[2][0], bbox[3][0]),
    Math.min(bbox[0][1], bbox[1][1], bbox[2][1], bbox[3][1]),
    Math.max(bbox[0][0], bbox[1][0], bbox[2][0], bbox[3][0]),
    Math.max(bbox[0][1], bbox[1][1], bbox[2][1], bbox[3][1]),
  ];
  
  const avgColWidth = (bboxRect[2] - bboxRect[0]) / wordInfo.lineTxtLen;
  
  const isAllEnNum = wordInfo.wordTypes.every(t => t === 'EN_NUM');
  
  const lineBoxes = [];
  for (let i = 0; i < wordInfo.words.length; i++) {
    const word = wordInfo.words[i];
    const wordCol = wordInfo.wordCols[i];
    
    if (isAllEnNum) {
      // English: one box per word
      const wordBoxes = calcBox(wordCol, avgColWidth, avgColWidth, bboxRect);
      const x0 = Math.min(...wordBoxes.map(b => b[0][0]));
      const y0 = Math.min(...wordBoxes.map(b => b[0][1]));
      const x1 = Math.max(...wordBoxes.map(b => b[1][0]));
      const y1 = Math.max(...wordBoxes.map(b => b[2][1]));
      lineBoxes.push([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    } else {
      // Chinese or mixed: one box per character
      const charBoxes = calcBox(wordCol, avgColWidth, avgColWidth, bboxRect);
      lineBoxes.push(...charBoxes);
    }
  }
  
  return lineBoxes;
}

function calcBox(lineCols, avgCharWidth, avgColWidth, bboxPoints) {
  const [x0, y0, x1, y1] = bboxPoints;
  const results = [];
  
  for (const colIdx of lineCols) {
    const centerX = (colIdx + 0.5) * avgColWidth;
    const charX0 = Math.max(Math.floor(centerX - avgCharWidth / 2), 0) + x0;
    const charX1 = Math.min(Math.floor(centerX + avgCharWidth / 2), x1 - x0) + x0;
    const cell = [
      [charX0, y0],
      [charX1, y0],
      [charX1, y1],
      [charX0, y1],
    ];
    results.push(cell);
  }
  
  return results.sort((a, b) => a[0][0] - b[0][0]);
}

function reverseRotateCropImage(bboxPoints, wordPointsList) {
  /* global cv */
  // Port of CalRecBoxes.reverse_rotate_crop_image
  // Inverse perspective transform to map word boxes from crop coords to original image coords
  
  const bbox = Array.isArray(bboxPoints[0]) ? bboxPoints : 
    [[bboxPoints[0], bboxPoints[1]], [bboxPoints[2], bboxPoints[3]], 
     [bboxPoints[4], bboxPoints[5]], [bboxPoints[6], bboxPoints[7]]];
  
  const left = Math.min(...bbox.map(p => p[0]));
  const top = Math.min(...bbox.map(p => p[1]));
  
  // Shift bbox to origin
  const bboxShifted = bbox.map(([x, y]) => [x - left, y - top]);
  
  // Calculate crop dimensions
  const dx01 = bboxShifted[1][0] - bboxShifted[0][0];
  const dy01 = bboxShifted[1][1] - bboxShifted[0][1];
  const dx03 = bboxShifted[3][0] - bboxShifted[0][0];
  const dy03 = bboxShifted[3][1] - bboxShifted[0][1];
  
  const imgCropWidth = Math.round(Math.sqrt(dx01 * dx01 + dy01 * dy01));
  const imgCropHeight = Math.round(Math.sqrt(dx03 * dx03 + dy03 * dy03));
  
  // Standard rectangle points
  const ptsStd = [
    [0, 0],
    [imgCropWidth, 0],
    [imgCropWidth, imgCropHeight],
    [0, imgCropHeight],
  ];
  
  // Get perspective transform matrix and its inverse
  let M, IM;
  if (typeof cv !== 'undefined' && cv.getPerspectiveTransform) {
    const srcMat = cv.matFromArray(4, 1, cv.CV_32FC2, bboxShifted.flat());
    const dstMat = cv.matFromArray(4, 1, cv.CV_32FC2, ptsStd.flat());
    M = cv.getPerspectiveTransform(srcMat, dstMat);
    IM = new cv.Mat();
    cv.invert(M, IM, cv.DECOMP_LU);
    srcMat.delete();
    dstMat.delete();
  } else {
    // Fallback: simplified transform (no rotation/skew)
    return wordPointsList.map(wordPoints => 
      wordPoints.map(([x, y]) => [Math.round(x + left), Math.round(y + top)])
    );
  }
  
  const newWordPointsList = [];
  
  for (const wordPoints of wordPointsList) {
    const newWordPoints = [];
    
    for (let [x, y] of wordPoints) {
      // Apply inverse perspective transform
      // p = [x, y, 1], result = IM * p, then divide by z
      const m = IM.data64F;
      const px = m[0] * x + m[1] * y + m[2];
      const py = m[3] * x + m[4] * y + m[5];
      const pz = m[6] * x + m[7] * y + m[8];
      
      x = px / pz;
      y = py / pz;
      
      // Shift back to original position
      newWordPoints.push([Math.round(x + left), Math.round(y + top)]);
    }
    
    newWordPointsList.push(newWordPoints);
  }
  
  if (M) M.delete();
  if (IM) IM.delete();
  
  return newWordPointsList;
}

// ─── RapidOcrModel ────────────────────────────────────────────────────────────

export class RapidOcrModel {
  /** @private */
  constructor() {
    /** @type {TextDetector}  */ this.textDetector   = null;
    /** @type {TextRecognizer}*/ this.textRecognizer = null;
    this.dropScore              = 0.5;
    this.enableMergeDetBoxes    = true;
    this.recBatchNum            = 6;
  }

  // ── Factory ─────────────────────────────────────────────────────────────────

  /**
   * Create and initialise a RapidOcrModel instance.
   * Mirrors: __init__(det_db_box_thresh, lang, ocr_config, ...)
   *
   * @param {{
   *   detModelUrl?:          string,
   *   recModelUrl?:          string,
   *   charList?:             string[],
   *   detDbBoxThresh?:       number,
   *   detDbUnclipRatio?:     number,
   *   useDilation?:          boolean,
   *   enableMergeDetBoxes?:  boolean,
   *   recBatchNum?:          number,
   *   limitSideLen?:         number,
   *   limitType?:            string,
   *   mean?:                 number[],
   *   std?:                  number[],
   *   executionProviders?:   string[],
   * }} [params={}]
   * @returns {Promise<RapidOcrModel>}
   */
  static async create(params = {}) {
    const inst = new RapidOcrModel();
    inst.dropScore           = 0.5;
    inst.enableMergeDetBoxes = params.enableMergeDetBoxes ?? true;
    inst.recBatchNum         = params.recBatchNum ?? 6;

    const epList = ['webgpu', 'wasm'];

    const sessOpts = {
      executionProviders: epList,
      logSeverityLevel: 4,
      graphOptimizationLevel: 'all',
      // WebGPU specific optimizations
      preferredOutputLocation: 'gpu-buffer', 
    };

    configureOrtWasmRuntime({ numThreads: 4 });

    // ── Load Det model (PERFORMANCE PATH: Testing WebGPU with fallback) ──
    const detUrl = (params.detModelUrl ?? DEFAULT_DET_MODEL_URL) + '?t=' + Date.now();
    logger.info(`Loading Det model: ${detUrl}`);
    const detBuf = await fetch(detUrl).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${detUrl}`);
      return r.arrayBuffer();
    });
    let detSession;
    try {
      detSession = await ort.InferenceSession.create(detBuf, {
        executionProviders: ['webgpu', 'wasm'], // Try WebGPU first, then WASM
        logSeverityLevel: 4,
        preferredOutputLocation: 'gpu-buffer', // Optimize WebGPU
      });
    } catch (err) {
      const detail = (err instanceof Error) ? err.message : String(err);
      throw new Error(`ONNX session creation failed (OCR det): ${detail}`);
    }

    const detPre  = new DetPreProcess(
      params.limitSideLen ?? 960,
      params.limitType    ?? 'max',
      params.mean         ?? [0.485, 0.456, 0.406],
      params.std          ?? [0.229, 0.224, 0.225],
    );
    // PARITY FIX (2026-05-11): align defaults with Python baseline (rapid_ocr.py:50).
    // Python: det_db_box_thresh=0.3, det_db_unclip_ratio=1.8.
    const detPost = new DetPostProcess(
      params.detDbThresh      ?? 0.3,  // thresh (binarization threshold)
      params.detDbBoxThresh   ?? 0.3,  // boxThresh (score threshold) - Python default
      params.detDbUnclipRatio ?? 1.8,  // unclipRatio - Python default
      3,                          // minSize
      params.useDilation ?? true, // useDilation
      1000,                       // maxCandidates
    );

    inst.textDetector = new TextDetector(detSession, detPre, detPost);

    // ── Load Rec model (PERFORMANCE PATH: WebGPU for the 26s bottleneck) ──
    const recUrl = params.recModelUrl
      ?? (params.lang === 'en' ? DEFAULT_REC_MODEL_URL_EN : DEFAULT_REC_MODEL_URL_CH);
    logger.info(`Loading Rec model (WebGPU): ${recUrl}`);
    
    const recSessOpts = {
      executionProviders: ['webgpu', 'wasm'],
      logSeverityLevel: 4,
      preferredOutputLocation: 'gpu-buffer',
    };
    const recCandidates = [recUrl];
    if (params.lang === 'en' && !params.recModelUrl) {
      recCandidates.push(...REMOTE_REC_MODEL_URL_EN_CANDIDATES);
    }

    let recBuf = null;
    let recLoadedFrom = null;
    let recLastErr = null;
    for (const candidate of recCandidates) {
      try {
        const response = await fetch(candidate);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} fetching ${candidate}`);
        }
        recBuf = await response.arrayBuffer();
        recLoadedFrom = candidate;
        break;
      } catch (err) {
        recLastErr = err;
      }
    }

    if (!recBuf) {
      throw new Error(
        `Failed to fetch OCR rec model from candidates: ${recCandidates.join(', ')}. ` +
        `Last error: ${recLastErr?.message ?? recLastErr}`,
      );
    }
    logger.info(`Loaded Rec model from: ${recLoadedFrom}`);
    
    let recSession;
    try {
      recSession = await ort.InferenceSession.create(recBuf, sessOpts);
    } catch (err) {
      const detail = (err instanceof Error) ? err.message : String(err);
      throw new Error(`ONNX session creation failed (OCR rec): ${detail}`);
    }

    // Character list: explicit param or local dict file (native parity),
    // then metadata fallback if dict file is unavailable.
    let charList = params.charList ?? null;
    if (!charList) {
      // Fallback to local dict file
      const dictUrl = params.lang === 'en'
        ? '/models/ocr/ppocrv5_en_dict.txt'
        : '/models/ocr/ppocrv5_dict.txt';
      logger.info(`Loading dictionary from: ${dictUrl}`);
      try {
        const dictBuf = await fetch(dictUrl).then(r => r.text());
        charList = dictBuf.split(/\r?\n/).filter(Boolean);
      } catch (err) {
        logger.warn(`Failed to load external dict: ${err.message}. Trying metadata.`);
      }

      if (!charList) {
        charList = RapidOcrModel._loadCharListFromMeta(recSession);
      }
      if (!charList) {
        logger.warn('Failed to load dictionary and metadata. Using default.');
        charList = _defaultCharList();
      }
    }
    charList = _prepareCtcCharacterList(charList);

    inst.textRecognizer = new TextRecognizer(
      recSession, charList, inst.recBatchNum,
    );

    logger.info('RapidOcrModel ready.');
    return inst;
  }

  static _loadCharListFromMeta(session) {
    try {
      const metadata = session?.getMetaData?.() ?? session?.metadata ?? null;
      const meta = session?.customMetadataMap
        ?? metadata?.customMetadataMap
        ?? metadata?.custom_metadata_map
        ?? {};
      const raw  = meta.character ?? meta.chars ?? meta.charset ?? '';
      const list = raw.split('\n').filter(Boolean);
      return list.length > 0 ? list : null;
    } catch (err) { 
      console.warn('[RapidOcrModel] failed to load charset from meta:', err.message);
      return null; 
    }
  }

  // ── ocr ──────────────────────────────────────────────────────────────────────

  /**
   * Run OCR on an image.
   * Mirrors: ocr(img, det, rec, mfd_res, ...)
   *
   * @param {cv.Mat|Uint8Array|ArrayBuffer} img
   * @param {{
   *   det?: boolean,
   *   rec?: boolean,
   *   mfdRes?: Array<{bbox:[number,number,number,number]}>,
   *   returnWordBox?: boolean,
   *   oriImg?: cv.Mat,
   *   dtBoxes?: any,
   * }} [opts]
   * @returns {Promise<Array|null>}
   */
  async ocr(img, opts = {}) {
    const {
      det = true,
      rec = true,
      mfdRes  = null,
      returnWordBox = false,
      enableMergeDetBoxes = undefined, // Per-call override
    } = opts;

    // Accept an Array<cv.Mat> for rec-only mode (batch recognition).
    if (Array.isArray(img)) {
      // Array path — used by runOcrRecPostprocess for batch rec-only.
      if (!det && rec) {
        return this._runRecOnly(img, opts);
      }
      // For det+rec on a list, run each image individually and merge.
      const results = [];
      for (const singleImg of img) {
        const res = await this.ocr(singleImg, opts);
        results.push(res);
      }
      return results;
    }

    const matImg = img instanceof cv.Mat ? img : checkImg(img);
    let shouldDeleteMat = !(img instanceof cv.Mat);

    try {
      const prepImg = preprocessImage(matImg);
      const deletePrep = prepImg !== matImg;

      try {
        if (det && rec) {
          return await this._runDetRec(prepImg, mfdRes, opts);
        } else if (det && !rec) {
          return await this._runDetOnly(prepImg, mfdRes, opts);
        } else if (!det && rec) {
          return await this._runRecOnly(prepImg, opts);
        }
        return null;
      } finally {
        if (deletePrep) prepImg.delete();
      }
    } finally {
      if (shouldDeleteMat) matImg.delete();
    }
  }

  async _runDetRec(img, mfdRes, opts = {}) {
    const { returnWordBox = false } = opts;
    
    const detRes = await this.textDetector.call(img);
    let dtBoxes  = detRes.boxes;
    if (!dtBoxes) return [null];

    dtBoxes = sortedBoxes(dtBoxes);
    // Allow per-call override of enableMergeDetBoxes
    const shouldMerge = opts.enableMergeDetBoxes ?? this.enableMergeDetBoxes;
    if (shouldMerge) dtBoxes = mergeDetBoxes(dtBoxes);
    if (mfdRes) dtBoxes = updateDetBoxes(dtBoxes, mfdRes);

    const crops = dtBoxes.map(box => getRotateCropImage(img, box));
    try {
      const recRes = await this.textRecognizer.call(crops, returnWordBox);
      
      if (returnWordBox && recRes.wordResults) {
        // Calculate word-level bounding boxes
        const wordResults = calRecBoxes(crops, dtBoxes, recRes);
        
        // Filter by drop score
        const result = [];
        for (let i = 0; i < dtBoxes.length; i++) {
          if (recRes.scores[i] >= this.dropScore) {
            result.push([dtBoxes[i].map(p => [...p]), [recRes.txts[i], recRes.scores[i], wordResults[i]]]);
          }
        }
        return [result];
      } else {
        const pairs  = recRes.txts.map((txt, i) => [txt, recRes.scores[i]]);

        // Filter by drop score and zip with boxes
        const result = dtBoxes
          .map((box, i) => [box, pairs[i]])
          .filter(([, [, score]]) => score >= this.dropScore)
          .map(([box, pair]) => [box.map(p => [...p]), pair]);

        return [result];
      }
    } finally {
      crops.forEach(c => c.delete());
    }
  }

  async _runDetOnly(img, mfdRes, opts = {}) {
    const detRes = await this.textDetector.call(img);
    let dtBoxes  = detRes.boxes;
    if (!dtBoxes) return [null];

    dtBoxes = sortedBoxes(dtBoxes);
    // Allow per-call override of enableMergeDetBoxes
    const shouldMerge = opts.enableMergeDetBoxes ?? this.enableMergeDetBoxes;
    if (shouldMerge) {
      dtBoxes = mergeDetBoxes(dtBoxes);
    }
    if (mfdRes) dtBoxes = updateDetBoxes(dtBoxes, mfdRes);

    return [dtBoxes.map(box => box.map(p => [...p]))];
  }

  async _runRecOnly(img, opts = {}) {
    const { returnWordBox = false, oriImg = null, dtBoxes = null } = opts;

    let crops;
    if (Array.isArray(img)) {
      crops = img; // already a list of images
    } else {
      crops = [img];
    }

    const recRes = await this.textRecognizer.call(crops, returnWordBox);

    let pairs;
    if (returnWordBox && recRes.wordResults) {
      // If we have original image and detection boxes, calculate word boxes
      if (oriImg && dtBoxes) {
        const wordResults = calRecBoxes(crops, dtBoxes, recRes);
        pairs = recRes.txts.map((txt, i) => [txt, recRes.scores[i], wordResults[i]]);
      } else {
        // No original context, return word results as-is
        pairs = recRes.txts.map((txt, i) => [txt, recRes.scores[i], recRes.wordResults[i]]);
      }
    } else {
      pairs = recRes.txts.map((txt, i) => [txt, recRes.scores[i]]);
    }
    return [pairs];
  }

  // ── detBatchPredict ──────────────────────────────────────────────────────────

  /**
   * Batch text detection on a list of images.
   * Mirrors: det_batch_predict(img_list, max_batch_size=8)
   *
   * @param {cv.Mat[]} imgList
   * @param {number}   [maxBatchSize=8]
   * @returns {Promise<Array<{boxes: Array|null, elapse: number}>>}
   */
  async detBatchPredict(imgList, maxBatchSize = 8) {
    if (!imgList.length) return [];
    const results = [];
    for (let i = 0; i < imgList.length; i += maxBatchSize) {
      const batch = imgList.slice(i, i + maxBatchSize);
      // Note: PP-OCR DB model is fundamentally single-image in ort-web
      // (dynamic input shape makes batching complex). Process sequentially.
      for (const img of batch) {
        results.push(await this.textDetector.call(img));
      }
    }
    return results;
  }

  // ── textRecognizerCall ───────────────────────────────────────────────────────

  /**
   * Public recognition entry-point (mirrors text_recognizer_call).
   *
   * @param {cv.Mat[]} imgList
   * @param {Function} [onProgress]
   * @returns {Promise<{txts: string[], scores: number[], elapse: number}>}
   */
  async textRecognizerCall(imgList, onProgress = null) {
    const res = await this.textRecognizer.call(imgList);
    if (onProgress) onProgress(imgList.length, imgList.length);
    return res;
  }
}

// ─── Default character list ───────────────────────────────────────────────────

/**
 * Minimal ASCII + common symbol fallback character list.
 * In production the char list is loaded from the model's custom metadata.
 * @returns {string[]}
 */
function _defaultCharList() {
  const chars = [];
  // digits
  for (let c = 48; c <= 57; c++)  chars.push(String.fromCharCode(c));
  // uppercase
  for (let c = 65; c <= 90; c++)  chars.push(String.fromCharCode(c));
  // lowercase
  for (let c = 97; c <= 122; c++) chars.push(String.fromCharCode(c));
  // common symbols
  chars.push(...' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
  return chars;
}

function _prepareCtcCharacterList(rawCharList) {
  const chars = Array.isArray(rawCharList) ? [...rawCharList] : [];

  // Match rapidocr.ch_ppocr_rec.CTCLabelDecode.get_character:
  // insert " " at the end and insert "blank" at index 0.
  chars.push(' ');
  chars.unshift('blank');
  return chars;
}
