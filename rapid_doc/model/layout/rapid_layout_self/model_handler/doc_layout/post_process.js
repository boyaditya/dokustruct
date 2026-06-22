/**
 * DocLayoutPostProcess: confidence masking, scaleBoxes rescaling, class lookup.
 *
 * INPUT:  preds = ort.Tensor[] (returned by OrtInferSession.run())
 *         Also accepts plain Float32Array (for direct tensor data passing)
 * OUTPUT: { boxes: number[][], scores: number[], labels: string[] }
 */

import { scaleBoxes } from './utils.js';

export class DocLayoutPostProcess {
  /**
   * @param {string[]} labels
   * @param {number}   [confThres=0.2]
   * @param {number}   [iouThres=0.5]   (retained for API parity; NMS done inside ONNX)
   */
  constructor(labels, confThres = 0.2, iouThres = 0.5) {
    this.labels = labels;
    this.confThreshold = confThres;
    this.iouThreshold = iouThres;
  }

  /**
   * Post-process ONNX output for DocLayout YOLO-based models.
   * Mirrors: __call__(preds, ori_img_shape, img_shape=(1024, 1024))
   *
   * @param {import('onnxruntime-web').Tensor[]|Float32Array[]} preds
   *        preds[0] shape: [1, num_boxes, 6]  (x1,y1,x2,y2,conf,cls)
   * @param {[number,number]} oriImgShape  - [H, W] of original image
   * @param {[number,number]} [imgShape]   - [H, W] of model input (default 1024×1024)
   * @returns {{ boxes: number[][], scores: number[], labels: string[] }}
   */
  call(preds, oriImgShape, imgShape = [1024, 1024]) {
    // preds[0] can be ort.Tensor or plain Float32Array
    const rawTensor = preds[0];
    const rawData = rawTensor?.data ?? rawTensor;  // ort.Tensor.data or Float32Array

    // Python: preds = preds[0]; mask = preds[..., 4] > self.conf_threshold
    // Shape: [batch=1, numBoxes, 6]
    // We squeeze the batch dimension — assume batch=1
    const totalDims = rawData.length;

    // Detect layout: [1, N, 6] vs [N, 6] flat
    // numBoxes * 6 == totalDims (batch has already been removed by model or ONNX graph)
    const numCols = 6;
    const numBoxes = totalDims / numCols;

    // Apply confidence mask
    /** @type {Array<{x1:number,y1:number,x2:number,y2:number,conf:number,cls:number}>} */
    const kept = [];
    for (let i = 0; i < numBoxes; i++) {
      const off = i * numCols;
      const conf = rawData[off + 4];
      if (conf > this.confThreshold) {
        kept.push({
          x1: rawData[off],
          y1: rawData[off + 1],
          x2: rawData[off + 2],
          y2: rawData[off + 3],
          conf,
          cls: Math.round(rawData[off + 5]),
        });
      }
    }

    if (kept.length === 0) {
      return { boxes: [], scores: [], labels: [] };
    }

    // Build flat Float32Array for scaleBoxes
    const flatBoxes = new Float32Array(kept.length * 4);
    kept.forEach(({ x1, y1, x2, y2 }, i) => {
      flatBoxes[i * 4]     = x1;
      flatBoxes[i * 4 + 1] = y1;
      flatBoxes[i * 4 + 2] = x2;
      flatBoxes[i * 4 + 3] = y2;
    });

    // Python: preds[:, :4] = scale_boxes(list(img_shape), preds[:, :4], list(ori_img_shape))
    const scaled = scaleBoxes(imgShape, flatBoxes, oriImgShape);

    // Unpack results
    const boxes = [];
    const scores = [];
    const resultLabels = [];
    for (let i = 0; i < kept.length; i++) {
      boxes.push([
        scaled[i * 4],
        scaled[i * 4 + 1],
        scaled[i * 4 + 2],
        scaled[i * 4 + 3],
      ]);
      scores.push(kept[i].conf);
      resultLabels.push(this.labels[kept[i].cls] ?? `class_${kept[i].cls}`);
    }

    return { boxes, scores, labels: resultLabels };
  }
}
