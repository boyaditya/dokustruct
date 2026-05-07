// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table_structure/unet/main.py → main.js
// TSRUnetStructurer: strict parity with Python implementation

import * as ort from "onnxruntime-web";
import { OrtInferSession } from "../../inference_engine/onnxruntime/main.js";
import { ModelProcessor } from "../../model_processor/main.js";
import { ModelType } from "../../utils/typings.js";
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

  async run(oriImgs) {
    const results = [];
    for (const img of oriImgs) {
      const { data, dims } = this._preprocess(img);
      const inputName = this.session.getInputNames()[0];
      const inputTensor = new ort.Tensor("float32", data, dims);
      const outputMap = await this.session.run({ [inputName]: inputTensor });
      const outputName = this.session.getOutputNames()[0];
      const pred = outputMap[outputName];
      const res = this.postprocess(img, pred);
      results.push(res);
    }
    return results;
  }

  _preprocess(img) {
    const _cv = typeof cv !== "undefined" ? cv : (globalThis.cv || null);
    let resized = new _cv.Mat(), rgb = new _cv.Mat(), f32 = new _cv.Mat();
    try {
      _cv.resize(img, resized, new _cv.Size(this.inp_width, this.inp_height), 0, 0, _cv.INTER_LINEAR);
      _cv.cvtColor(resized, rgb, _cv.COLOR_BGR2RGB);
      rgb.convertTo(f32, _cv.CV_32F);
      const src = f32.data32F, chw = new Float32Array(3 * 1024 * 1024);
      for (let c = 0; c < 3; c++) {
        const m = this.mean[c], s = this.std[c];
        for (let i = 0; i < 1024 * 1024; i++) chw[c * 1024 * 1024 + i] = (src[i * 3 + c] - m) / s;
      }
      return { data: chw, dims: [1, 3, 1024, 1024] };
    } finally {
      resized.delete(); rgb.delete(); f32.delete();
    }
  }

  postprocess(img, pred) {
    const _cv = typeof cv !== "undefined" ? cv : (globalThis.cv || null);
    const oriH = img.rows, oriW = img.cols;
    const data = pred.data, dims = pred.dims;
    const C = Number(dims.length === 3 ? dims[0] : (dims.length === 4 ? dims[1] : 1));
    const H = Number(dims[dims.length - 2]), W = Number(dims[dims.length - 1]);
    const HW = H * W;

    let hMat = _cv.Mat.zeros(H, W, _cv.CV_8UC1);
    let vMat = _cv.Mat.zeros(H, W, _cv.CV_8UC1);
    for (let i = 0; i < HW; i++) {
      const val = C === 3 ? (data[HW+i] > 0.5 ? 1 : (data[2*HW+i] > 0.5 ? 2 : 0)) : Math.round(Number(data[i]));
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
    _cv.morphologyEx(hPred, hPred, _cv.MORPH_CLOSE, hKernel);
    _cv.morphologyEx(vPred, vPred, _cv.MORPH_CLOSE, vKernel);
    hKernel.delete(); vKernel.delete();

    const rowBoxes = getTableLine(hPred.data, oriW, oriH, 0, 50);
    const colBoxes = getTableLine(vPred.data, oriW, oriH, 1, 30);
    hPred.delete(); vPred.delete();

    const moreRow = adjustLines(rowBoxes, 100, 50);
    const moreCol = adjustLines(colBoxes, 15, 50);
    let finalRow = rowBoxes.concat(moreRow), finalCol = colBoxes.concat(moreCol);
    finalAdjustLines(finalRow, finalCol);

    let lineImg = _cv.Mat.zeros(oriH, oriW, _cv.CV_8UC1);
    drawLines(lineImg, finalRow.concat(finalCol));

    const polygons = this.calRegionBoxes(lineImg);
    lineImg.delete();

    if (polygons.length === 0) return { polygons: null, rotatedPolygons: null };

    // Swap indices 1 and 3 to match Python's CCW order after sort
    for (const poly of polygons) {
      const p1 = poly[1], p3 = poly[3];
      poly[1] = p3; poly[3] = p1;
    }

    const [, idx] = sortedOcrBoxes(polygons.map(p => box42PolyToBox41(p)), 0.3);
    const finalPolys = idx.map(i => polygons[i]);
    return { polygons: finalPolys, rotatedPolygons: finalPolys };
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
      const w = Math.sqrt((box[1][0]-box[0][0])**2 + (box[1][1]-box[0][1])**2);
      const h = Math.sqrt((box[3][0]-box[0][0])**2 + (box[3][1]-box[0][1])**2);
      if (w * h < maxArea * 0.5 && w >= 15 && h >= 15) boxes.push(box);
    }
    return boxes;
  }
}

export default TSRUnetStructurer;
