// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: rapid_table_self/table_cls/main.py → main.js
// TableCls → dispatches to PaddleCls or QanythingCls based on model_type
// W1: __init__(cfg) → static async create(cfg)
// W2: cv.Mat cleanup in try/finally

import * as ort from "onnxruntime-web";
import { OrtInferSession } from "../inference_engine/onnxruntime/main.js";
import { ModelProcessor } from "../model_processor/main.js";
import { ModelType } from "../utils/typings.js";
import { getLogger } from "./utils/logger.js";

const logger = getLogger("TableCls");

// ImageNet normalization constants
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

/**
 * Resize image so shortest side = targetSize, then center-crop to (cropSize x cropSize).
 * PORTING NOTE: PaddleCls preprocessing (resize_short=256, crop=224)
 * W2: all cv.Mat objects freed in try/finally
 * @param {cv.Mat} img - BGR uint8
 * @param {number} resizeShort
 * @param {number} cropSize
 * @returns {Float32Array} CHW float32 normalized array [3, cropSize, cropSize]
 */
function paddleClsPreprocess(img, resizeShort = 256, cropSize = 224) {
  const h = img.rows, w = img.cols;
  // Step 1: resize so shortest side = resizeShort
  let scale, newH, newW;
  if (h < w) { scale = resizeShort / h; newH = resizeShort; newW = Math.round(w * scale); }
  else { scale = resizeShort / w; newW = resizeShort; newH = Math.round(h * scale); }

  let resized = new cv.Mat();
  let cropped = null;
  try {
    cv.resize(img, resized, new cv.Size(newW, newH), 0, 0, cv.INTER_LINEAR);
    // Step 2: center crop to (cropSize x cropSize)
    const y0 = Math.floor((newH - cropSize) / 2);
    const x0 = Math.floor((newW - cropSize) / 2);
    const roi = resized.roi(new cv.Rect(x0, y0, cropSize, cropSize));
    cropped = roi.clone();
    roi.delete();
  } finally {
    resized.delete();
  }

  // Step 3: BGR → RGB, normalize to CHW float32
  let rgb = new cv.Mat();
  let float32 = new cv.Mat();
  try {
    cv.cvtColor(cropped, rgb, cv.COLOR_BGR2RGB);
    rgb.convertTo(float32, cv.CV_32F, 1.0 / 255.0);

    const data = new Float32Array(3 * cropSize * cropSize);
    const src = float32.data32F;
    // Convert HWC → CHW and apply ImageNet normalization
    for (let c = 0; c < 3; c++) {
      const mean = IMAGENET_MEAN[c], std = IMAGENET_STD[c];
      const offset = c * cropSize * cropSize;
      for (let i = 0; i < cropSize * cropSize; i++) {
        data[offset + i] = (src[i * 3 + c] - mean) / std;
      }
    }
    return data;
  } finally {
    if (cropped) cropped.delete();
    rgb.delete();
    float32.delete();
  }
}

/**
 * PaddleCls-style ONNX classifier.
 * PORTING NOTE: PaddleCls(cfg) → static async create(cfg)
 */
export class PaddleCls {
  constructor() {
    this.session = null;
  }

  static async create(cfg) {
    const inst = new PaddleCls();
    const modelBytes = await ModelProcessor.getModelPath(
      cfg.model_type ?? ModelType.PADDLE_CLS,
      cfg.model_dir_or_path ?? null
    );
    inst.session = await OrtInferSession.create({
      model_dir_or_path: modelBytes,
      engine_cfg: cfg.engine_cfg ?? {},
    });
    return inst;
  }

  /**
   * Classify a single image.
   * @param {cv.Mat} img - BGR uint8
   * @returns {Promise<[string, number]>} [className, score]
   */
  async run(img) {
    const data = paddleClsPreprocess(img, 256, 224);
    const inputTensor = new ort.Tensor("float32", data, [1, 3, 224, 224]);
    const inputName = this.session.getInputNames()[0];
    const result = await this.session.run({ [inputName]: inputTensor });
    const outputName = this.session.getOutputNames()[0];
    const outputData = Array.from(result[outputName].cpuData ?? result[outputName].data);
    const softmax = _softmax(outputData);
    const maxIdx = softmax.indexOf(Math.max(...softmax));
    return [String(maxIdx), softmax[maxIdx]];
  }
}

/**
 * QanythingCls-style ONNX classifier.
 * PORTING NOTE: QanythingCls(cfg) → similar to PaddleCls with different preprocessing.
 */
export class QanythingCls {
  constructor() {
    this.session = null;
  }

  static async create(cfg) {
    const inst = new QanythingCls();
    const modelBytes = await ModelProcessor.getModelPath(
      cfg.model_type ?? ModelType.Q_CLS,
      cfg.model_dir_or_path ?? null
    );
    inst.session = await OrtInferSession.create({
      model_dir_or_path: modelBytes,
      engine_cfg: cfg.engine_cfg ?? {},
    });
    return inst;
  }

  /**
   * Classify a single image.
   * @param {cv.Mat} img - BGR uint8
   * @returns {Promise<[string, number]>} [className, score]
   */
  async run(img) {
    // QanythingCls uses same PaddleCls preprocessing (resize+crop+normalize)
    const data = paddleClsPreprocess(img, 256, 224);
    const inputTensor = new ort.Tensor("float32", data, [1, 3, 224, 224]);
    const inputName = this.session.getInputNames()[0];
    const result = await this.session.run({ [inputName]: inputTensor });
    const outputName = this.session.getOutputNames()[0];
    const outputData = Array.from(result[outputName].cpuData ?? result[outputName].data);
    const softmax = _softmax(outputData);
    const maxIdx = softmax.indexOf(Math.max(...softmax));
    const labels = ["wired", "wireless"];
    return [labels[maxIdx] ?? String(maxIdx), softmax[maxIdx]];
  }
}

/**
 * Table type classifier dispatcher.
 * PORTING NOTE: TableCls(cfg) → static async create(cfg)
 * Dispatches to QanythingCls (Q_CLS) or PaddleCls based on model_type.
 */
export class TableCls {
  constructor() {
    this._cls = null;
  }

  static async create(cfg = null) {
    const inst = new TableCls();
    const modelType = cfg?.model_type ?? ModelType.Q_CLS;
    if (modelType === ModelType.Q_CLS) {
      inst._cls = await QanythingCls.create(cfg ?? {});
    } else {
      inst._cls = await PaddleCls.create(cfg ?? {});
    }
    return inst;
  }

  /**
   * Classify table image as "wired" or "wireless".
   * @param {cv.Mat} img
   * @returns {Promise<[string, number]>} [tableType, score]
   */
  async run(img) {
    return this._cls.run(img);
  }
}

/**
 * Numerically stable softmax.
 * @param {number[]} x
 * @returns {number[]}
 */
function _softmax(x) {
  const max = Math.max(...x);
  const exp = x.map(v => Math.exp(v - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map(v => v / sum);
}

export default TableCls;
