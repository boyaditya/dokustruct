// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table_structure/pp_structure/pre_process.py → pre_process.js
// TablePreprocess: resize → normalize → pad → CHW
// W2: cv.Mat objects cleaned in try/finally

// ImageNet normalization (PP-StructureV2 standard values)
const IMG_MEAN = [0.485, 0.456, 0.406];
const IMG_STD = [0.229, 0.224, 0.225];

/**
 * Table image pre-processing pipeline for PP-Structure models.
 * PORTING NOTE: TablePreprocess(max_len=488) processes images to [1, 3, maxLen, maxLen] NCHW
 */
export class TablePreprocess {
  /**
   * @param {number} [maxLen=488]
   */
  constructor(maxLen = 488) {
    this.maxLen = maxLen;
  }

  /**
   * Resize image so longest side = maxLen, preserving aspect ratio.
   * @param {cv.Mat} img - BGR uint8
   * @returns {{ resized: cv.Mat, shape: number[] }} shape = [origH, origW, ratioH, ratioW]
   */
  resizeImage(img) {
    const h = img.rows, w = img.cols;
    const ratio = this.maxLen / Math.max(h, w);
    const newH = Math.round(h * ratio);
    const newW = Math.round(w * ratio);
    const resized = new cv.Mat();
    cv.resize(img, resized, new cv.Size(newW, newH), 0, 0, cv.INTER_LINEAR);
    return { resized, shape: [h, w, ratio, ratio] };
  }

  /**
   * Normalize image: scale 1/255, subtract ImageNet mean, divide std.
   * @param {cv.Mat} img - BGR uint8
   * @returns {cv.Mat} float32 BGR Mat (caller must delete)
   */
  normalize(img) {
    let float32 = new cv.Mat();
    let rgb = new cv.Mat();
    try {
      cv.cvtColor(img, rgb, cv.COLOR_BGR2RGB);
      rgb.convertTo(float32, cv.CV_32F, 1.0 / 255.0);
    } finally {
      rgb.delete();
    }

    let channels = new cv.MatVector();
    cv.split(float32, channels);
    for (let c = 0; c < 3; c++) {
      const ch = channels.get(c);
      ch.convertTo(ch, cv.CV_32F, 1.0 / IMG_STD[c], -IMG_MEAN[c] / IMG_STD[c]);
      channels.set(c, ch);
      ch.delete();
    }
    let merged = new cv.Mat();
    cv.merge(channels, merged);
    channels.delete();
    float32.delete();
    return merged;
  }

  /**
   * Pad image to (maxLen x maxLen) with zeros and append shape info.
   * @param {cv.Mat} img
   * @param {number[]} shape - [origH, origW, ratioH, ratioW]
   * @returns {{ padded: cv.Mat, shape: number[] }}
   */
  padImg(img, shape) {
    const padded = new cv.Mat(this.maxLen, this.maxLen, img.type(), new cv.Scalar(0, 0, 0));
    const roi = padded.roi(new cv.Rect(0, 0, img.cols, img.rows));
    img.copyTo(roi);
    roi.delete();
    return { padded, shape: [...shape, this.maxLen, this.maxLen] };
  }

  /**
   * Transpose HWC → CHW.
   * @param {cv.Mat} img - float32 [H,W,3]
   * @returns {Float32Array} CHW float32
   */
  toChw(img) {
    const H = img.rows, W = img.cols;
    const src = img.data32F;
    const out = new Float32Array(3 * H * W);
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < H * W; i++) {
        out[c * H * W + i] = src[i * 3 + c];
      }
    }
    return out;
  }

  /**
   * Full preprocessing pipeline for a single image.
   * @param {cv.Mat} img - BGR uint8
   * @returns {{ data: Float32Array, dims: number[], shape: number[] }}
   */
  run(img) {
    const { resized, shape } = this.resizeImage(img);
    let normalized = null;
    let padded = null;
    try {
      normalized = this.normalize(resized);
      resized.delete();
      const { padded: paddedMat, shape: paddedShape } = this.padImg(normalized, shape);
      padded = paddedMat;
      normalized.delete();
      normalized = null;
      const chw = this.toChw(padded);
      const H = this.maxLen, W = this.maxLen;
      return {
        data: chw,
        dims: [1, 3, H, W],
        shape: paddedShape,
      };
    } finally {
      if (normalized) normalized.delete();
      if (padded) padded.delete();
    }
  }

  /**
   * Process a batch of images.
   * @param {cv.Mat[]} imgs
   * @returns {{ data: Float32Array, dims: number[], shapes: number[][] }}
   */
  runBatch(imgs) {
    const results = imgs.map(img => this.run(img));
    const N = results.length, C = 3, H = this.maxLen, W = this.maxLen;
    const data = new Float32Array(N * C * H * W);
    let offset = 0;
    for (const r of results) {
      data.set(r.data, offset);
      offset += r.data.length;
    }
    return { data, dims: [N, C, H, W], shapes: results.map(r => r.shape) };
  }
}

export default TablePreprocess;
