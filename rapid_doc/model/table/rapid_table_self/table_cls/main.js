// Copyright (c) Opendatalab. All rights reserved.

import * as ort from "onnxruntime-web";
import { OrtInferSession } from "../inference_engine/onnxruntime/main.js";
import { ModelProcessor } from "../model_processor/main.js";
import { ModelType } from "../utils/typings.js";
import { getLogger } from "./utils/logger.js";
import { disposeOutputMap } from "../../../../utils/resource_utils.js";

const logger = getLogger("TableCls");

// ImageNet normalization constants
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

/**
 * Resize image so shortest side = targetSize, then center-crop to (cropSize x cropSize).
 * Returns CHW float32 normalized array [3, cropSize, cropSize].
 * @param {cv.Mat} img - BGR uint8
 * @param {number} resizeShort
 * @param {number} cropSize
 * @returns {Float32Array}
 */
function paddleClsPreprocess(img, resizeShort = 256, cropSize = 224) {
  const h = img.rows, w = img.cols;
  let scale, newH, newW;
  if (h < w) { scale = resizeShort / h; newH = resizeShort; newW = Math.round(w * scale); }
  else { scale = resizeShort / w; newW = resizeShort; newH = Math.round(h * scale); }

  let resized = new cv.Mat();
  let cropped = null;
  try {
    cv.resize(img, resized, new cv.Size(newW, newH), 0, 0, cv.INTER_LANCZOS4);
    const y0 = Math.floor((newH - cropSize) / 2);
    const x0 = Math.floor((newW - cropSize) / 2);
    const roi = resized.roi(new cv.Rect(x0, y0, cropSize, cropSize));
    cropped = roi.clone();
    roi.delete();
  } finally {
    resized.delete();
  }

  // Porting fix: keep BGR — model trained against BGR-input; do not convert.
  let float32 = new cv.Mat();
  try {
    cropped.convertTo(float32, cv.CV_32F, 1.0 / 255.0);

    const data = new Float32Array(3 * cropSize * cropSize);
    const src = float32.data32F;
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
    float32.delete();
  }
}

/**
 * Qanything table classifier preprocessing.
 * BGR -> RGB -> grayscale -> 3-channel -> resize 224x224 -> normalize.
 * @param {cv.Mat} img - BGR uint8
 * @param {number} cropSize
 * @returns {Float32Array}
 */
function qanythingClsPreprocess(img, cropSize = 224) {
  const rgb = new cv.Mat();
  const gray = new cv.Mat();
  const gray3 = new cv.Mat();
  const resized = new cv.Mat();
  const float32 = new cv.Mat();
  try {
    cv.cvtColor(img, rgb, cv.COLOR_BGR2RGB);
    // Porting fix: INTENTIONAL R/B swap in luminance — matches Python training distribution. DO NOT "FIX".
    // Python applies cv2.COLOR_BGR2GRAY coefficients to an RGB Mat → Y = 0.114·R + 0.587·G + 0.299·B
    // (standard is Y = 0.299·R + 0.587·G + 0.114·B). The model was trained against this quirk.
    cv.cvtColor(rgb, gray, cv.COLOR_BGR2GRAY);
    cv.cvtColor(gray, gray3, cv.COLOR_GRAY2RGB);
    // Porting fix: INTER_CUBIC matches Pillow ≥9.1 default BICUBIC interpolation used in Python
    cv.resize(gray3, resized, new cv.Size(cropSize, cropSize), 0, 0, cv.INTER_CUBIC);
    resized.convertTo(float32, cv.CV_32F, 1.0 / 255.0);

    const data = new Float32Array(3 * cropSize * cropSize);
    const src = float32.data32F;
    for (let c = 0; c < 3; c++) {
      const mean = IMAGENET_MEAN[c], std = IMAGENET_STD[c];
      const offset = c * cropSize * cropSize;
      for (let i = 0; i < cropSize * cropSize; i++) {
        data[offset + i] = (src[i * 3 + c] - mean) / std;
      }
    }
    return data;
  } finally {
    rgb.delete();
    gray.delete();
    gray3.delete();
    resized.delete();
    float32.delete();
  }
}

function resolveModelPath(modelDirOrPath, modelType) {
  if (!modelDirOrPath || typeof modelDirOrPath !== "object") return modelDirOrPath ?? null;
  return modelDirOrPath[modelType] ?? modelDirOrPath[String(modelType)] ?? null;
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

/**
 * PaddleCls-style ONNX classifier.
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
    let result = null;
    try {
      result = await this.session.run({ [inputName]: inputTensor });
      const outputName = this.session.getOutputNames()[0];
      const outputData = Array.from(result[outputName].cpuData ?? result[outputName].data);
      const softmax = _softmax(outputData);
      const maxIdx = softmax.indexOf(Math.max(...softmax));
      const labels = ["wired", "wireless"];
      return [labels[maxIdx] ?? String(maxIdx), softmax[maxIdx]];
    } finally {
      if (inputTensor?.dispose) inputTensor.dispose();
      disposeOutputMap(result);
    }
  }

  async dispose() {
    if (this.session && typeof this.session.dispose === 'function') {
      await this.session.dispose();
    }
    this.session = null;
  }
}

/**
 * QanythingCls-style ONNX classifier.
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
    const data = qanythingClsPreprocess(img, 224);
    const inputTensor = new ort.Tensor("float32", data, [1, 3, 224, 224]);
    const inputName = this.session.getInputNames()[0];
    let result = null;
    try {
      result = await this.session.run({ [inputName]: inputTensor });
      const outputName = this.session.getOutputNames()[0];
      const outputData = Array.from(result[outputName].cpuData ?? result[outputName].data);
      const softmax = _softmax(outputData);
      const maxIdx = softmax.indexOf(Math.max(...softmax));
      const labels = ["wired", "wireless"];
      return [labels[maxIdx] ?? String(maxIdx), softmax[maxIdx]];
    } finally {
      if (inputTensor?.dispose) inputTensor.dispose();
      disposeOutputMap(result);
    }
  }

  async dispose() {
    if (this.session && typeof this.session.dispose === 'function') {
      await this.session.dispose();
    }
    this.session = null;
  }
}

/**
 * Combined Paddle + Qanything classifier.
 * If both classifiers disagree, treats the table as wireless (Python parity).
 */
export class PaddleQCls {
  constructor() {
    this.paddleCls = null;
    this.qanythingCls = null;
  }

  static async create(cfg) {
    const inst = new PaddleQCls();
    inst.paddleCls = await PaddleCls.create({
      ...cfg,
      model_type: ModelType.PADDLE_CLS,
      model_dir_or_path: resolveModelPath(cfg?.model_dir_or_path, ModelType.PADDLE_CLS),
    });
    inst.qanythingCls = await QanythingCls.create({
      ...cfg,
      model_type: ModelType.Q_CLS,
      model_dir_or_path: resolveModelPath(cfg?.model_dir_or_path, ModelType.Q_CLS),
    });
    return inst;
  }

  async run(img) {
    const [paddleType, paddleScore] = await this.paddleCls.run(img);
    const [qanythingType, qanythingScore] = await this.qanythingCls.run(img);
    if (paddleType === qanythingType) {
      return [paddleType, Math.min(paddleScore, qanythingScore)];
    }
    return ["wireless", Math.min(paddleScore, qanythingScore)];
  }

  async dispose() {
    if (this.paddleCls) await this.paddleCls.dispose();
    if (this.qanythingCls) await this.qanythingCls.dispose();
    this.paddleCls = null;
    this.qanythingCls = null;
  }
}

/**
 * Table type classifier dispatcher.
 * Dispatches to Paddle, Qanything, or combined Paddle+Qanything based on model_type.
 */
export class TableCls {
  constructor() {
    this._cls = null;
  }

  static async create(cfg = null) {
    const inst = new TableCls();
    const modelType = cfg?.model_type ?? ModelType.PADDLE_Q_CLS;
    if (modelType === ModelType.PADDLE_Q_CLS) {
      try {
        inst._cls = await PaddleQCls.create(cfg ?? {});
      } catch (err) {
        logger.warn(
          `TableCls: Paddle+Q classifier unavailable (${err?.message ?? err}); falling back to QanythingCls.`
        );
        inst._cls = await QanythingCls.create({ ...(cfg ?? {}), model_type: ModelType.Q_CLS });
      }
    } else if (modelType === ModelType.Q_CLS) {
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

  async dispose() {
    if (this._cls && typeof this._cls.dispose === 'function') {
      await this._cls.dispose();
    }
    this._cls = null;
  }
}

export default TableCls;
