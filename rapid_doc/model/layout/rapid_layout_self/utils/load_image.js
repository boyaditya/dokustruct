/**
 * LoadImage: multi-format image loader for browser context.
 * Accepts ArrayBuffer, Blob, ImageData, cv.Mat, HTMLImageElement, OffscreenCanvas,
 * or ImageBitmap. All paths decode into a BGR cv.Mat.
 * Caller is responsible for deleting the returned Mat.
 */

import { isUrl } from './utils.js';

/**
 * Supported input types for LoadImage.
 * @typedef {ArrayBuffer|Uint8Array|Blob|ImageData|HTMLImageElement|HTMLCanvasElement|cv.Mat|string} InputType
 */

export class LoadImageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'LoadImageError';
  }
}

export class LoadImage {
  constructor() {}

  /**
   * Load and normalise any supported image type to a BGR cv.Mat.
   * Caller MUST call .delete() on the returned Mat when done.
   *
   * @param {InputType} img
   * @returns {Promise<cv.Mat>} BGR cv.Mat
   */
  async call(img) {
    const mat = await this.loadImg(img);
    const converted = this.convertImg(mat);
    // If convertImg returned a new Mat, free the intermediate one
    if (converted !== mat) {
      mat.delete();
    }
    return converted;
  }

  /**
   * Load any input into an RGBA or grayscale cv.Mat.
   *
   * @param {InputType} img
   * @returns {Promise<cv.Mat>}
   */
  async loadImg(img) {
    if (typeof img === 'string') {
      // URL string → fetch → ArrayBuffer
      if (isUrl(img)) {
        const response = await fetch(img);
        if (!response.ok) throw new LoadImageError(`Failed to fetch image: ${img}`);
        const buf = await response.arrayBuffer();
        return this._decodeArrayBuffer(buf);
      }
      throw new LoadImageError(`String path ${img} is not a URL. Use a URL or File/ArrayBuffer instead.`);
    }

    if (img instanceof ArrayBuffer || img instanceof Uint8Array) {
      return this._decodeArrayBuffer(img);
    }

    if (img instanceof Blob) {
      const buf = await img.arrayBuffer();
      return this._decodeArrayBuffer(buf);
    }

    if (img instanceof ImageData) {
      // ImageData is RGBA → create Mat directly
      const mat = cv.matFromImageData(img);
      return mat;
    }

    if (img instanceof HTMLImageElement || img instanceof HTMLCanvasElement) {
      return this._matFromHtmlElement(img);
    }

    // OffscreenCanvas — not an HTMLCanvasElement but has the same 2D API
    if (typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas) {
      const ctx = img.getContext('2d');
      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      return cv.matFromImageData(imageData);
    }

    // ImageBitmap — draw onto an OffscreenCanvas then read back
    if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
      const oc = new OffscreenCanvas(img.width, img.height);
      const ctx = oc.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      return cv.matFromImageData(imageData);
    }

    // Already a cv.Mat — clone to maintain ownership contract
    if (img instanceof cv.Mat) {
      return img.clone();
    }

    throw new LoadImageError(`Unsupported image type: ${Object.prototype.toString.call(img)}`);
  }

  /**
   * Decode an ArrayBuffer / Uint8Array (JPEG/PNG/BMP/etc.) to a cv.Mat via cv.imdecode.
   *
   * @param {ArrayBuffer|Uint8Array} buffer
   * @returns {cv.Mat}
   */
  _decodeArrayBuffer(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const nativeArray = cv.matFromArray(bytes.length, 1, cv.CV_8UC1, bytes);
    let decoded;
    try {
      decoded = cv.imdecode(nativeArray, cv.IMREAD_UNCHANGED);
    } finally {
      nativeArray.delete();
    }
    if (decoded.empty()) {
      decoded.delete();
      throw new LoadImageError('cv.imdecode could not identify/decode image data');
    }
    return decoded;
  }

  /**
   * Draw an HTMLImageElement or HTMLCanvasElement onto an OffscreenCanvas and
   * read back as cv.Mat (RGBA).
   *
   * @param {HTMLImageElement|HTMLCanvasElement} element
   * @returns {cv.Mat}
   */
  _matFromHtmlElement(element) {
    const w = element.naturalWidth ?? element.width;
    const h = element.naturalHeight ?? element.height;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(element, 0, 0);
    const imageData = ctx.getImageData(0, 0, w, h);
    return cv.matFromImageData(imageData);
  }

  /**
   * Ensure the Mat is BGR (3-channel, 8-bit) regardless of the source colour space.
   * Creates and returns a new Mat; the caller should delete the old one if it differs.
   * @param {cv.Mat} mat
   * @returns {cv.Mat} BGR Mat
   */
  convertImg(mat) {
    const channels = mat.channels();
    const type = mat.type();

    // Grayscale (1 channel CV_8UC1 / CV_16UC1 etc.)
    if (channels === 1) {
      const bgr = new cv.Mat();
      cv.cvtColor(mat, bgr, cv.COLOR_GRAY2BGR);
      return bgr;
    }

    // 2-channel: gray + alpha
    if (channels === 2) {
      return LoadImage.cvtTwoToThree(mat);
    }

    // 3-channel: could be RGB (from PNG/JPEG via imdecode) or already BGR
    // cv.imdecode returns BGR by default; Canvas RGBA sources come through as RGBA Mat,
    // which we handle in the 4-channel branch below.
    if (channels === 3) {
      // Already BGR from imdecode — return a clone so ownership is clear
      return mat.clone();
    }

    // 4-channel RGBA (from Canvas / ImageData path)
    if (channels === 4) {
      return LoadImage.cvtFourToThree(mat);
    }

    throw new LoadImageError(`Unsupported number of channels: ${channels}`);
  }

  /**
   * Convert a 2-channel (gray + alpha) Mat to BGR.
   * @param {cv.Mat} img - 2-channel Mat
   * @returns {cv.Mat} BGR Mat
   */
  static cvtTwoToThree(img) {
    const channels = new cv.MatVector();
    cv.split(img, channels);

    const gray = channels.get(0);
    const alpha = channels.get(1);

    let bgr = new cv.Mat();
    let notA = new cv.Mat();
    let bgr3 = new cv.Mat();
    let result = new cv.Mat();

    try {
      cv.cvtColor(gray, bgr, cv.COLOR_GRAY2BGR);
      cv.bitwise_not(alpha, notA);
      cv.cvtColor(notA, bgr3, cv.COLOR_GRAY2BGR);

      cv.bitwise_and(bgr, bgr, result, alpha);
      cv.add(result, bgr3, result);

      return result.clone();
    } finally {
      gray.delete(); alpha.delete();
      bgr.delete(); notA.delete(); bgr3.delete(); result.delete();
      channels.delete();
    }
  }

  /**
   * Convert a 4-channel RGBA Mat to BGR.
   * Blends alpha onto white or inverts based on mean brightness.
   * @param {cv.Mat} img - RGBA Mat
   * @returns {cv.Mat} BGR Mat
   */
  static cvtFourToThree(img) {
    const channels = new cv.MatVector();
    cv.split(img, channels);

    // OpenCV.js split gives RGBA order
    const r = channels.get(0);
    const g = channels.get(1);
    const b = channels.get(2);
    const a = channels.get(3);

    let bgr = new cv.Mat();
    let notA = new cv.Mat();
    let bgr3 = new cv.Mat();
    let result = new cv.Mat();
    let merged = new cv.MatVector();

    try {
      // Build BGR Mat from R,G,B channels
      merged.push_back(b);
      merged.push_back(g);
      merged.push_back(r);
      cv.merge(merged, bgr);

      cv.bitwise_not(a, notA);
      cv.cvtColor(notA, bgr3, cv.COLOR_GRAY2BGR);

      cv.bitwise_and(bgr, bgr, result, a);

      // Compute mean of result to decide blend vs invert
      const mean = cv.mean(result);
      const meanColor = (mean[0] + mean[1] + mean[2]) / 3;

      if (meanColor <= 0.0) {
        cv.add(result, bgr3, result);
      } else {
        cv.bitwise_not(result, result);
      }

      return result.clone();
    } finally {
      r.delete(); g.delete(); b.delete(); a.delete();
      bgr.delete(); notA.delete(); bgr3.delete(); result.delete();
      merged.delete(); channels.delete();
    }
  }
}
