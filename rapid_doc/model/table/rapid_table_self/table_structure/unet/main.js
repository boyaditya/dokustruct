// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table_structure/unet/main.py → main.js
// TSRUnetStructurer: strict parity with Python implementation

import * as ort from "onnxruntime-web";
import { OrtInferSession } from "../../inference_engine/onnxruntime/main.js";
import { ModelProcessor } from "../../model_processor/main.js";
import { ModelType } from "../../utils/typings.js";
import { disposeOutputMap } from "../../../../../utils/resource_utils.js";
import { labelConnectedComponents } from "./utils/utils.js";
import { getTableLine, adjustLines, finalAdjustLines, drawLines, imageLocationSortBox } from "./utils/utils_table_line_rec.js";
import { box42PolyToBox41, sortedOcrBoxes } from "./utils/utils_table_recover.js";

export class TSRUnetStructurer {
  constructor() {
    this.session = null;
    this.inp_height = 1024;
    this.inp_width = 1024;
    this.mean = [123.675, 116.28, 103.53];
    this.std = [58.395, 57.12, 57.375];
  }

  static async create(cfg = {}) {
    const inst = new TSRUnetStructurer();
    const modelType = cfg.model_type ?? ModelType.UNET;
    const modelBytes = await ModelProcessor.getModelPath(modelType, cfg.model_dir_or_path ?? null);
    inst.session = await OrtInferSession.create({
      model_dir_or_path: modelBytes,
      engine_cfg: cfg.engine_cfg ?? {},
    });
    return inst;
  }

  async run(oriImgs, opts = {}) {
    const results = [];
    for (const img of oriImgs) {
      const { data, dims } = this._preprocess(img);
      const inputName = this.session.getInputNames()[0];
      const inputTensor = new ort.Tensor("float32", data, dims);
      let outputMap = null;
      try {
        outputMap = await this.session.run({ [inputName]: inputTensor });
        const outputName = this.session.getOutputNames()[0];
        const pred = outputMap[outputName];
        const res = this.postprocess(img, pred, opts);
        results.push(res);
      } finally {
        if (inputTensor?.dispose) inputTensor.dispose();
        disposeOutputMap(outputMap);
      }
    }
    return results;
  }

  /**
   * Release the underlying ORT session.
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this.session && typeof this.session.dispose === 'function') {
      await this.session.dispose();
    }
    this.session = null;
  }

  _preprocess(img) {
    const _cv = typeof cv !== "undefined" ? cv : (globalThis.cv || null);
    // Parity with Python resize_img(img, (1024,1024), keep_ratio=True):
    // Python uses imrescale which resizes the longest side to 1024 WITHOUT padding.
    // The UNet ONNX model has dynamic input shapes and accepts any (H, W).
    // Padding to 1024x1024 causes the padded zeros to affect model predictions
    // (e.g. via batch norm statistics), producing different cell boundaries than Python.
    const scale = Math.min(this.inp_height / img.rows, this.inp_width / img.cols);
    const newH = Math.round(img.rows * scale);
    const newW = Math.round(img.cols * scale);
    const interp = scale < 1 ? _cv.INTER_AREA : _cv.INTER_CUBIC;
    let resized = new _cv.Mat(), rgb = new _cv.Mat(), f32 = new _cv.Mat();
    try {
      _cv.resize(img, resized, new _cv.Size(newW, newH), 0, 0, interp);
      _cv.cvtColor(resized, rgb, _cv.COLOR_BGR2RGB);
      rgb.convertTo(f32, _cv.CV_32F);
      const HW = newH * newW;
      const src = f32.data32F, chw = new Float32Array(3 * HW);
      for (let c = 0; c < 3; c++) {
        const m = this.mean[c], s = this.std[c];
        for (let i = 0; i < HW; i++) chw[c * HW + i] = (src[i * 3 + c] - m) / s;
      }
      return { data: chw, dims: [1, 3, newH, newW] };
    } finally {
      resized.delete(); rgb.delete(); f32.delete();
    }
  }

  /**
   * Convert model prediction to polygons.
   *
   * @param {cv.Mat} img - Original BGR image
   * @param {ort.Tensor} pred - Raw model output tensor
   * @param {object} [opts={}] - Optional kwargs forwarded from caller chain
   * @param {number} [opts.row=50] - Minimum pixel size for horizontal line segments in getTableLine (Python `row`)
   * @param {number} [opts.col=30] - Minimum pixel size for vertical line segments in getTableLine (Python `col`)
   * @param {number} [opts.h_lines_threshold=100] - Alpha distance threshold for adjustLines on horizontal lines (Python `h_lines_threshold`)
   * @param {number} [opts.v_lines_threshold=15] - Alpha distance threshold for adjustLines on vertical lines (Python `v_lines_threshold`)
   * @param {number} [opts.angle=50] - Angle tolerance (degrees) passed to adjustLines for both row and col lines
   * @param {boolean} [opts.enhance_box_line=false] - Whether to enhance box-border lines (reserved for future use)
   * @param {boolean} [opts.morph_close=true] - Whether to apply MORPH_CLOSE on hPred (unconditional on vPred); see
   * @param {boolean} [opts.more_h_lines=true] - Gate: whether to run adjustLines for horizontal lines (Python `more_h_lines`, default true via enhance_box_line)
   * @param {boolean} [opts.more_v_lines=true] - Gate: whether to run adjustLines for vertical lines (Python `more_v_lines`, default true via enhance_box_line)
   * @param {boolean} [opts.extend_line=true] - Gate: whether to run finalAdjustLines (Python `extend_line`, default true via enhance_box_line)
   * @param {boolean} [opts.rotated_fix=true] - Whether to apply rotation correction via cal_rotate_angle + rotate_image + unrotate_polygons
   * @returns {{ polygons: Array|null, rotatedPolygons: Array|null }}
   */
  // Forward kwargs from caller chain to postprocess (matches Python)
  postprocess(img, pred, opts = {}) {
    const _cv = typeof cv !== "undefined" ? cv : (globalThis.cv || null);
    const oriH = img.rows, oriW = img.cols;
    const data = pred.data, dims = pred.dims;
    const C = Number(dims.length === 3 ? dims[0] : (dims.length === 4 ? dims[1] : 1));
    const H = Number(dims[dims.length - 2]), W = Number(dims[dims.length - 1]);
    const HW = H * W;

    // Handle dims [1, 1, H, W] — single channel class IDs (not softmax probs)
    // Python: result = result[0][0][0] → shape [1, 1, H, W]; data is uint8 class IDs (0=bg, 1=hline, 2=vline)
    // C=1: data contains class IDs directly — Math.round passes them through correctly
    // C=3: use argmax across [bg, hline, vline] channels — do NOT threshold > 0.5 (Python uses argmax, not threshold)
    let hMat = _cv.Mat.zeros(H, W, _cv.CV_8UC1);
    let vMat = _cv.Mat.zeros(H, W, _cv.CV_8UC1);
    for (let i = 0; i < HW; i++) {
      let val;
      if (C === 3) {
        // argmax over 3 channels: channel 0 = bg, channel 1 = hline, channel 2 = vline
        const c0 = Number(data[i]), c1 = Number(data[HW + i]), c2 = Number(data[2 * HW + i]);
        val = c1 > c0 && c1 >= c2 ? 1 : c2 > c0 ? 2 : 0;
      } else {
        val = Math.round(Number(data[i]));
      }
      if (val === 1) hMat.data[i] = 255;
      if (val === 2) vMat.data[i] = 255;
    }

    let hPred = new _cv.Mat(), vPred = new _cv.Mat();
    _cv.resize(hMat, hPred, new _cv.Size(oriW, oriH), 0, 0, _cv.INTER_NEAREST);
    _cv.resize(vMat, vPred, new _cv.Size(oriW, oriH), 0, 0, _cv.INTER_NEAREST);
    hMat.delete(); vMat.delete();

    const kHSize = (Math.sqrt(W) * 1.2) | 0, kVSize = (Math.sqrt(H) * 1.2) | 0;
    let hKernel = _cv.getStructuringElement(_cv.MORPH_RECT, new _cv.Size(kHSize, 1));
    let vKernel = _cv.getStructuringElement(_cv.MORPH_RECT, new _cv.Size(1, kVSize));
    // MORPH_CLOSE on hPred conditional on morph_close opt (matches Python)
    if (opts.morph_close !== false) {
      _cv.morphologyEx(hPred, hPred, _cv.MORPH_CLOSE, hKernel);
    }
    _cv.morphologyEx(vPred, vPred, _cv.MORPH_CLOSE, vKernel);
    hKernel.delete(); vKernel.delete();

    const rowBoxes = getTableLine(hPred.data, oriW, oriH, 0, opts.row ?? 50);
    const colBoxes = getTableLine(vPred.data, oriW, oriH, 1, opts.col ?? 30);
    hPred.delete(); vPred.delete();

    // Python parity: more_h_lines / more_v_lines are boolean gates (default true via
    // enhance_box_line=True); the actual alph comes from h_lines_threshold / v_lines_threshold.
    const hLinesThreshold = opts.h_lines_threshold ?? 100;
    const vLinesThreshold = opts.v_lines_threshold ?? 15;
    const moreHLines = opts.more_h_lines !== false;  // default true
    const moreVLines = opts.more_v_lines !== false;  // default true
    const moreRow = moreHLines ? adjustLines(rowBoxes, hLinesThreshold, opts.angle ?? 50) : [];
    const moreCol = moreVLines ? adjustLines(colBoxes, vLinesThreshold, opts.angle ?? 50) : [];
    let finalRow = rowBoxes.concat(moreRow), finalCol = colBoxes.concat(moreCol);
    // Python parity: extend_line is a boolean gate (default true via enhance_box_line=True)
    if (opts.extend_line !== false) {
      finalAdjustLines(finalRow, finalCol);
    }

    let lineImg = _cv.Mat.zeros(oriH, oriW, _cv.CV_8UC1);
    drawLines(lineImg, finalRow.concat(finalCol));

    // Rotation correction — matches Python cal_rotate_angle + rotate_image + unrotate_polygons
    const rotatedFix = opts.rotated_fix !== false; // default enabled
    const rotatedAngle = this._calRotateAngle(lineImg);

    let polygons, rotatedPolygons;
    if (rotatedFix && Math.abs(rotatedAngle) > 0.3) {
      const rotatedLineImg = this._rotateImage(lineImg, rotatedAngle);
      rotatedPolygons = this.calRegionBoxes(rotatedLineImg);
      rotatedLineImg.delete();
      polygons = this._unrotatePolygons(rotatedPolygons, rotatedAngle, oriW, oriH);
    } else {
      polygons = this.calRegionBoxes(lineImg);
      rotatedPolygons = polygons.map(p => p.map(v => [...v])); // deep copy
    }
    lineImg.delete();

    if (polygons.length === 0) return { polygons: null, rotatedPolygons: null };

    // Swap indices 1 and 3 to match Python's CCW order after sort
    for (const poly of polygons) {
      const p1 = poly[1], p3 = poly[3];
      poly[1] = p3; poly[3] = p1;
    }
    for (const poly of rotatedPolygons) {
      const p1 = poly[1], p3 = poly[3];
      poly[1] = p3; poly[3] = p1;
    }

    const [, idx] = sortedOcrBoxes(rotatedPolygons.map(p => box42PolyToBox41(p)), 0.4);
    const finalPolys = idx.map(i => polygons[i]);
    const finalRotatedPolys = idx.map(i => rotatedPolygons[i]);
    return { polygons: finalPolys, rotatedPolygons: finalRotatedPolys };
  }

  calRegionBoxes(tmp) {
    const _cv = typeof cv !== "undefined" ? cv : (globalThis.cv || null);
    const lineMask = new Uint8Array(tmp.rows * tmp.cols);
    for (let i = 0; i < lineMask.length; i++) if (tmp.data[i] < 255) lineMask[i] = 1;
    const { labels, numComponents } = labelConnectedComponents(lineMask, tmp.cols, tmp.rows, 8);
    const coordsByLabel = Array.from({ length: numComponents + 1 }, () => []);
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] > 0) coordsByLabel[labels[i]].push(i % tmp.cols, (i / tmp.cols) | 0);
    }
    const boxes = [];
    const maxArea = tmp.rows * tmp.cols;
    for (let l = 1; l <= numComponents; l++) {
      const coords = coordsByLabel[l];
      if (coords.length < 6) continue;

      // Compute axis-aligned bbox area (matches Python component.bbox_area = width * height)
      // Used for the large-region skip filter (Python: bbox_area > H*W*3/4)
      let axMinX = Infinity, axMinY = Infinity, axMaxX = -Infinity, axMaxY = -Infinity;
      for (let k = 0; k < coords.length; k += 2) {
        const cx = coords[k], cy = coords[k + 1];
        if (cx < axMinX) axMinX = cx;
        if (cy < axMinY) axMinY = cy;
        if (cx > axMaxX) axMaxX = cx;
        if (cy > axMaxY) axMaxY = cy;
      }
      const axisAlignedArea = (axMaxX - axMinX + 1) * (axMaxY - axMinY + 1);
      // Skip outer-table-border region using axis-aligned area (Python parity)
      if (axisAlignedArea > maxArea * 0.75) continue;

      let mat = _cv.matFromArray(coords.length / 2, 1, _cv.CV_32SC2, coords);
      let rect = _cv.minAreaRect(mat);
      mat.delete();
      const pts = _cv.boxPoints(rect);
      let boxArr = [];
      if (pts.data32F) {
        boxArr = Array.from(pts.data32F);
      } else if (pts.rows !== undefined) {
        for (let i = 0; i < pts.rows; i++) {
          for (let j = 0; j < pts.cols; j++) {
            boxArr.push(pts.floatAt(i, j));
          }
        }
      } else if (Array.isArray(pts)) {
        for (const p of pts) boxArr.push(p.x, p.y);
      }

      if (pts && typeof pts.delete === 'function') {
        pts.delete();
      }

      const sorted = imageLocationSortBox(boxArr);
      const box = [[sorted[0], sorted[1]], [sorted[2], sorted[3]], [sorted[4], sorted[5]], [sorted[6], sorted[7]]];
      // Average opposite sides for w/h (matches Python)
      const w = (Math.sqrt((box[1][0]-box[0][0])**2 + (box[1][1]-box[0][1])**2)
               + Math.sqrt((box[2][0]-box[3][0])**2 + (box[2][1]-box[3][1])**2)) / 2;
      const h = (Math.sqrt((box[3][0]-box[0][0])**2 + (box[3][1]-box[0][1])**2)
               + Math.sqrt((box[2][0]-box[1][0])**2 + (box[2][1]-box[1][1])**2)) / 2;
      const bboxArea = w * h;
      if (bboxArea < maxArea * 0.5 && w >= 15 && h >= 15) boxes.push(box);
    }
    return boxes;
  }
  /**
   * Port of Python cal_rotate_angle(lineMat).
   * Finds the largest contour in the line image, computes minAreaRect angle,
   * and normalizes to [-45, 45] range. Returns 0 if no contours found.
   * @param {cv.Mat} lineMat - CV_8UC1 binary line image
   * @returns {number} rotation angle in degrees
   */
  _calRotateAngle(lineMat) {
    const _cv = typeof cv !== "undefined" ? cv : (globalThis.cv || null);
    const contours = new _cv.MatVector();
    const hierarchy = new _cv.Mat();
    try {
      _cv.findContours(lineMat, contours, hierarchy, _cv.RETR_EXTERNAL, _cv.CHAIN_APPROX_SIMPLE);
      if (contours.size() === 0) return 0;

      // Find the largest contour by area
      let largestIdx = 0, largestArea = -1;
      for (let i = 0; i < contours.size(); i++) {
        const area = _cv.contourArea(contours.get(i));
        if (area > largestArea) {
          largestArea = area;
          largestIdx = i;
        }
      }

      const rect = _cv.minAreaRect(contours.get(largestIdx));
      // rect.angle is in degrees; normalize to tilt range
      let angle = rect.angle;
      if (angle < -45) {
        angle += 90;
      } else if (angle > 45) {
        angle -= 90;
      }
      return angle;
    } finally {
      contours.delete();
      hierarchy.delete();
    }
  }

  /**
   * Port of Python rotate_image(image, angle).
   * Rotates the image using getRotationMatrix2D at its center,
   * keeping the same size with INTER_NEAREST + BORDER_REPLICATE.
   * Caller is responsible for deleting the returned Mat.
   * @param {cv.Mat} image - source image
   * @param {number} angle - rotation angle in degrees
   * @returns {cv.Mat} rotated image (caller must delete)
   */
  _rotateImage(image, angle) {
    const _cv = typeof cv !== "undefined" ? cv : (globalThis.cv || null);
    const h = image.rows, w = image.cols;
    const center = new _cv.Point2f(Math.floor(w / 2), Math.floor(h / 2));
    const M = _cv.getRotationMatrix2D(center, angle, 1.0);
    const rotated = new _cv.Mat();
    _cv.warpAffine(image, rotated, M, new _cv.Size(w, h), _cv.INTER_NEAREST, _cv.BORDER_REPLICATE);
    M.delete();
    return rotated;
  }

  /**
   * Port of Python unrotate_polygons(polygons, angle, img_shape).
   * Applies inverse rotation (-angle) to each polygon vertex to map
   * rotated-frame polygons back to the original image frame.
   * @param {Array<Array<[number, number]>>} polys - array of [[x,y],[x,y],[x,y],[x,y]]
   * @param {number} angle - original rotation angle in degrees
   * @param {number} W - original image width
   * @param {number} H - original image height
   * @returns {Array<Array<[number, number]>>} unrotated polygons
   */
  _unrotatePolygons(polys, angle, W, H) {
    const _cv = typeof cv !== "undefined" ? cv : (globalThis.cv || null);
    const center = new _cv.Point2f(Math.floor(W / 2), Math.floor(H / 2));
    const Minv = _cv.getRotationMatrix2D(center, -angle, 1.0);
    // Minv is a 2x3 affine matrix stored row-major: [m00, m01, m02, m10, m11, m12]
    const m = Minv.data64F;
    const m00 = m[0], m01 = m[1], m02 = m[2];
    const m10 = m[3], m11 = m[4], m12 = m[5];
    Minv.delete();

    return polys.map(poly =>
      poly.map(([x, y]) => [
        m00 * x + m01 * y + m02,
        m10 * x + m11 * y + m12,
      ])
    );
  }
}

export default TSRUnetStructurer;
