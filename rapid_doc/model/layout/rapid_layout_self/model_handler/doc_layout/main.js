/**
 * DocLayoutModelHandler: single-image pipeline for DocLayout YOLO models
 * (doclayout_docstructbench).
 */

import { BaseModelHandler } from '../base/index.js';
import { DocLayoutPreProcess }  from './pre_process.js';
import { DocLayoutPostProcess } from './post_process.js';
import { RapidLayoutOutput } from '../../utils/typings.js';

export class DocLayoutModelHandler extends BaseModelHandler {
  /**
   * @param {string[]} labels
   * @param {number} confThres
   * @param {number} iouThres
   * @param {import('../../inference_engine/base.js').InferSession} session
   */
  constructor(labels, confThres, iouThres, session) {
    super();
    this.imgSize     = [1024, 1024];    // [H, W]
    this._preProcess  = new DocLayoutPreProcess(this.imgSize);
    this._postProcess = new DocLayoutPostProcess(labels, confThres, iouThres);
    this.session      = session;
  }

  /**
   * Run inference on a list of images.
   * @param {cv.Mat[]} oriImgList
   * @returns {Promise<import('../../utils/typings.js').RapidLayoutOutput[]>}
   */
  async call(oriImgList) {
    const t0 = performance.now();
    const resultList = [];

    for (const oriImg of oriImgList) {
      const oriImgShape = [oriImg.rows, oriImg.cols]; // [H, W]

      // 1. Preprocess → { data: Float32Array, shape: [1,3,H,W] }
      const { data, shape } = this._preProcess.call(oriImg);

      // 2. Inference → ort.Tensor[]
      const preds = await this.session.run(data, null, shape);

      // 3. Postprocess → { boxes, scores, labels }
      const { boxes, scores, labels } = this._postProcess.call(
        preds,
        oriImgShape,
        this.imgSize,
      );

      const elapse = (performance.now() - t0) / 1000;  // seconds (parity with Python)

      resultList.push(new RapidLayoutOutput({
        img: oriImg,
        boxes,
        class_names: labels,
        scores,
        elapse,
      }));
    }

    return resultList;
  }

  // ── BaseModelHandler overrides ─────────────────────────────────────────────

  preprocess(image) { return this._preProcess.call(image); }

  postprocess(preds, oriImgShape, imgShape) {
    return this._postProcess.call(preds, oriImgShape, imgShape);
  }
}
