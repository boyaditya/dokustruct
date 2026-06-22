/**
 * PPPreProcess: image preprocessing for PP-DocLayout models.
 * Resizes, normalizes, and transposes BGR cv.Mat to NCHW Float32Array for ONNX inference.
 *
 * BROWSER WORKAROUND: NumPy is not available; cv2 → OpenCV.js, array ops → Float32Array loops.
 * Memory management: every cv.Mat created inside this class is freed in a
 * try/finally block before returning.
 */

import { ModelType } from '../utils.js';

export class PPPreProcess {
  /**
   * @param {[number, number]} imgSize - [height, width]
   * @param {string} modelType - One of ModelType.*
   */
  constructor(imgSize, modelType) {
    this.size = imgSize; // [h, w]
    this.scale = 1 / 255.0;

    const ppDocLayoutFamily = [
      ModelType.PP_DOCLAYOUT_L,
      ModelType.PP_DOCLAYOUT_PLUS_L,
      ModelType.PP_DOCLAYOUTV2,
      ModelType.PP_DOCLAYOUTV3,
    ];

    if (ppDocLayoutFamily.includes(modelType)) {
      this.mean = [0, 0, 0];
      this.std  = [1.0, 1.0, 1.0];
    } else {
      this.mean = [0.485, 0.456, 0.406];
      this.std  = [0.229, 0.224, 0.225];
    }
  }

  /**
   * Preprocess a BGR cv.Mat into a flat NCHW Float32Array ready for ONNX inference.
   *
   * @param {cv.Mat} img - Input BGR Mat (CV_8UC3)
   * @returns {{ data: Float32Array, shape: [1, 3, number, number] }}
   */
  call(img) {
    if (!img || img.empty()) throw new Error('PPPreProcess.call: img is null or empty');

    let resized = null;
    try {
      resized = this.resize(img);
      const h = resized.rows;
      const w = resized.cols;
      const hwcData = this.normalize(resized);
      const data = this.permute(hwcData, h, w);
      return { data, shape: [1, 3, h, w] };
    } finally {
      if (resized) resized.delete();
    }
  }

  /**
   * Resize to the target [height, width] using INTER_CUBIC (interpolation=2).
   * Returns a new cv.Mat; caller must delete it.
   *
   * @param {cv.Mat} img
   * @returns {cv.Mat}
   */
  resize(img) {
    const [resizeH, resizeW] = this.size;
    const resized = new cv.Mat();
    cv.resize(img, resized, new cv.Size(resizeW, resizeH), 0, 0, cv.INTER_CUBIC);
    return resized;
  }

  /**
   * Apply scale → mean subtraction → std division to produce a float32 HWC array.
   * Matches Python: (img.astype("float32") * scale - mean) / std
   * The Mat channels are interpreted as BGR; the mean/std arrays are in BGR order
   * (matching the Python code which also keeps BGR order).
   *
   * @param {cv.Mat} mat - Resized BGR Mat (CV_8UC3)
   * @returns {Float32Array} HWC float32 data, shape [H, W, C]
   */
  normalize(mat) {
    const h = mat.rows;
    const w = mat.cols;
    const c = mat.channels();
    const total = h * w * c;
    const out = new Float32Array(total);
    const data = mat.data; // Uint8ClampedArray — BGRA or BGR

    const matChannels = mat.channels(); // typically 3 (BGR) or 4 (BGRA)

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const srcBase = (y * w + x) * matChannels;
        const dstBase = (y * w + x) * c;
        for (let ch = 0; ch < c; ch++) {
          const pixelVal = data[srcBase + ch];
          out[dstBase + ch] = (pixelVal * this.scale - this.mean[ch]) / this.std[ch];
        }
      }
    }
    return out;
  }

  /**
   * Transpose HWC Float32Array to CHW (matching Python: img.transpose((2,0,1))).
   *
   * @param {Float32Array} hwcData - shape [H, W, C]
   * @param {number} h
   * @param {number} w
   * @returns {Float32Array} shape [C, H, W]
   */
  permute(hwcData, h, w) {
    const c = hwcData.length / (h * w);
    const out = new Float32Array(c * h * w);
    for (let ch = 0; ch < c; ch++) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          out[ch * h * w + y * w + x] = hwcData[(y * w + x) * c + ch];
        }
      }
    }
    return out;
  }
}
