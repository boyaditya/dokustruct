import * as ort from "onnxruntime-web";
import { configureOrtRuntime, acquireGlobalGpu } from "../../utils/ort_runtime.js";
import { LoadImage } from "../table/rapid_table_self/utils/load_image.js";
import { deleteMat } from "../../utils/resource_utils.js";

const DEFAULT_MODEL_URL = "/models/orientation/rapid_orientation.onnx";
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];
const FALLBACK_LABELS = ["0", "90", "180", "270"];
const INPUT_SIZE = 224;
const RESIZE_SHORT_SIDE = 256;

/** Aspect ratio threshold below which image is considered non-rotated. */
const ASPECT_RATIO_SKIP_THRESHOLD = 1.2;
/** Fraction of vertical boxes needed to trigger model inference. */
const VERTICAL_BOX_FRACTION = 0.28;
/** Minimum count of vertical boxes to trigger model inference. */
const MIN_VERTICAL_BOX_COUNT = 3;
/** Majority threshold for vertical box detection. */
const MAJORITY_VERTICAL_FRACTION = 0.5;
/** Aspect ratio threshold for individual text boxes. */
const TEXT_BOX_ASPECT_THRESHOLD = 0.8;

/**
 * Find the index of the maximum value in each row of a flat 2D array.
 * @param {Float32Array|number[]} data
 * @param {number} rows
 * @param {number} cols
 * @returns {number[]}
 */
function argmaxPerRow(data, rows, cols) {
  const idxs = [];
  for (let r = 0; r < rows; r++) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    const offset = r * cols;
    for (let c = 0; c < cols; c++) {
      const value = Number(data[offset + c]);
      if (value > bestVal) {
        bestVal = value;
        bestIdx = c;
      }
    }
    idxs.push(bestIdx);
  }
  return idxs;
}

/**
 * Return the most frequent value in an array.
 * @param {number[]} values
 * @returns {number}
 */
function majorityVote(values) {
  if (!values || values.length === 0) return 0;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
}

/**
 * Extract label list from ONNX session metadata.
 * @param {object} session
 * @returns {string[]}
 */
function getLabels(session) {
  const meta = session?.customMetadataMap ?? {};
  const raw = meta.character ?? meta.label ?? meta.labels ?? "";
  if (!raw) return FALLBACK_LABELS;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed.map(String);
  } catch {
    // Fall through to line-split parsing
  }
  const labels = String(raw).split(/\r?\n/).filter(Boolean);
  return labels.length ? labels : FALLBACK_LABELS;
}

/**
 * Preprocess a cv.Mat for orientation model inference.
 * Resizes, center-crops, normalizes with ImageNet stats, and tiles into a batch.
 * @param {object} mat - cv.Mat input image
 * @param {number} batchSize
 * @returns {Float32Array}
 */
function preprocessOrientationMat(mat, batchSize = 3) {
  if (!mat || mat.rows === 0 || mat.cols === 0) {
    throw new Error("[RapidOrientation] Cannot preprocess empty or invalid Mat.");
  }

  const h = mat.rows;
  const w = mat.cols;
  const scale = RESIZE_SHORT_SIDE / Math.min(w, h);
  const newW = Math.round(w * scale);
  const newH = Math.round(h * scale);
  const resized = new cv.Mat();
  const cropped = new cv.Mat();
  const rgb = new cv.Mat();
  const floatMat = new cv.Mat();

  try {
    cv.resize(mat, resized, new cv.Size(newW, newH), 0, 0, cv.INTER_LANCZOS4 ?? cv.INTER_CUBIC);
    const x0 = Math.floor((newW - INPUT_SIZE) / 2);
    const y0 = Math.floor((newH - INPUT_SIZE) / 2);
    const roi = resized.roi(new cv.Rect(x0, y0, INPUT_SIZE, INPUT_SIZE));
    try {
      roi.copyTo(cropped);
    } finally {
      roi.delete();
    }

    cv.cvtColor(cropped, rgb, cv.COLOR_BGR2RGB);
    rgb.convertTo(floatMat, cv.CV_32F, 1.0 / 255.0);

    const pixelCount = INPUT_SIZE * INPUT_SIZE;
    const single = new Float32Array(3 * pixelCount);
    const src = floatMat.data32F;
    for (let c = 0; c < 3; c++) {
      const mean = IMAGENET_MEAN[c];
      const std = IMAGENET_STD[c];
      const dstOffset = c * pixelCount;
      for (let i = 0; i < pixelCount; i++) {
        single[dstOffset + i] = (src[i * 3 + c] - mean) / std;
      }
    }

    const batched = new Float32Array(batchSize * single.length);
    for (let b = 0; b < batchSize; b++) batched.set(single, b * single.length);
    return batched;
  } finally {
    deleteMat(resized);
    deleteMat(cropped);
    deleteMat(rgb);
    deleteMat(floatMat);
  }
}

/**
 * Count text boxes that appear vertically oriented (height > width).
 * @param {Array} detRes - OCR detection results (polygon arrays)
 * @returns {number}
 */
function countVerticalBoxes(detRes) {
  let verticalCount = 0;
  for (const box of detRes) {
    if (!Array.isArray(box) || box.length < 3) continue;
    const p1 = box[0];
    const p3 = box[2];
    const width = Number(p3?.[0] ?? 0) - Number(p1?.[0] ?? 0);
    const height = Number(p3?.[1] ?? 0) - Number(p1?.[1] ?? 0);
    const aspectRatio = height > 0 ? width / height : 1.0;
    if (aspectRatio < TEXT_BOX_ASPECT_THRESHOLD) verticalCount += 1;
  }
  return verticalCount;
}

export class RapidOrientationEngine {
  constructor() {
    this.session = null;
    this.labels = FALLBACK_LABELS;
    this.loader = new LoadImage();
    this.batchSize = 3;
    this.useWebGpu = false;
  }

  static async create({ modelUrl = DEFAULT_MODEL_URL, executionProviders = ["webgpu", "wasm"] } = {}) {
    const inst = new RapidOrientationEngine();
    inst.useWebGpu = executionProviders.includes("webgpu");
    await configureOrtRuntime({ numThreads: 4, useWebGpu: inst.useWebGpu });

    const resp = await fetch(modelUrl);
    if (!resp.ok) {
      throw new Error(`[RapidOrientation] Failed to fetch model at ${modelUrl} (HTTP ${resp.status})`);
    }

    const modelBytes = await resp.arrayBuffer();
    inst.session = await ort.InferenceSession.create(modelBytes, {
      executionProviders,
      logSeverityLevel: 4,
      graphOptimizationLevel: "all",
      ...(inst.useWebGpu ? { preferredOutputLocation: "gpu-buffer" } : {}),
    });
    inst.labels = getLabels(inst.session);
    return inst;
  }

  async predictRaw(image) {
    if (!image) {
      throw new Error("[RapidOrientation] predictRaw called with null/undefined image.");
    }

    const mat = image instanceof cv.Mat ? image.clone() : await this.loader.run(image);
    let feeds = null;
    let result = null;
    try {
      const input = preprocessOrientationMat(mat, this.batchSize);
      const inputName = this.session.inputNames[0];
      const outputName = this.session.outputNames[0];
      feeds = { [inputName]: new ort.Tensor("float32", input, [this.batchSize, 3, INPUT_SIZE, INPUT_SIZE]) };

      const releaseGpu = this.useWebGpu ? await acquireGlobalGpu() : null;
      try {
        result = await this.session.run(feeds);
      } finally {
        releaseGpu?.();
      }

      const tensor = result instanceof Map ? result.get(outputName) : result[outputName];
      const outputData = typeof tensor?.getData === "function" ? await tensor.getData() : (tensor?.cpuData ?? tensor?.data);
      const dims = tensor.dims ?? [this.batchSize, this.labels.length];
      const rows = Number(dims[0] ?? this.batchSize);
      const cols = Number(dims[1] ?? this.labels.length);
      const predIdx = majorityVote(argmaxPerRow(outputData, rows, cols));
      return this.labels[predIdx] ?? String(predIdx);
    } finally {
      if (feeds) {
        for (const tensor of Object.values(feeds)) tensor?.dispose?.();
      }
      if (result) {
        const tensors = result instanceof Map ? result.values() : Object.values(result);
        for (const tensor of tensors) tensor?.dispose?.();
      }
      deleteMat(mat);
    }
  }

  async dispose() {
    if (this.session) {
      await this.session.release?.();
      this.session = null;
    }
  }
}

export class RapidOrientationModel {
  constructor(engine) {
    this.orientationEngine = engine;
  }

  static async create(opts = {}) {
    return new RapidOrientationModel(await RapidOrientationEngine.create(opts));
  }

  async predict(inputImg, detRes = null) {
    if (!inputImg) return "0";

    const imgHeight = inputImg?.rows ?? inputImg?.height ?? 0;
    const imgWidth = inputImg?.cols ?? inputImg?.width ?? 0;
    const imgAspectRatio = imgWidth > 0 ? imgHeight / imgWidth : 1.0;

    if (imgAspectRatio <= ASPECT_RATIO_SKIP_THRESHOLD) return "0";

    if (Array.isArray(detRes) && detRes.length > 0) {
      const verticalCount = countVerticalBoxes(detRes);
      const majorityVertical = verticalCount / detRes.length >= MAJORITY_VERTICAL_FRACTION;
      const isRotated =
        (verticalCount >= detRes.length * VERTICAL_BOX_FRACTION && verticalCount >= MIN_VERTICAL_BOX_COUNT) ||
        majorityVertical;

      if (!isRotated) return "0";
    }

    return await this.orientationEngine.predictRaw(inputImg);
  }

  async dispose() {
    await this.orientationEngine?.dispose();
  }
}

export default RapidOrientationModel;
