// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: load_image.py → load_image.js
// Python PIL/cv2 image loading → browser OpenCV.js (cv global)
// All cv.Mat objects must be freed in try/finally blocks

/**
 * Load and decode an image from various input types into a cv.Mat (BGR, uint8).
 * PORTING NOTE: LoadImage.__call__ handles str/bytes/ndarray/PIL.Image input.
 * In browser, input can be: HTMLImageElement | ImageBitmap | ImageData | Uint8Array | string(URL)
 */
export class LoadImage {
  /**
   * Load an image from various source types.
   * @param {HTMLImageElement|ImageBitmap|ImageData|Uint8Array|string} img
   * @returns {Promise<cv.Mat>} BGR uint8 Mat
   */
  async run(img) {
    // cv is a global from opencv.js
    if (typeof img === "string") {
      return this._loadFromUrl(img);
    }
    if (img instanceof Uint8Array || img instanceof ArrayBuffer) {
      return this._loadFromBytes(img instanceof ArrayBuffer ? new Uint8Array(img) : img);
    }
    if (img instanceof ImageData) {
      return this._fromImageData(img);
    }
    if (img instanceof ImageBitmap) {
      return this._fromImageBitmap(img);
    }
    if (img instanceof HTMLImageElement) {
      return this._fromHtmlImage(img);
    }
    if (typeof cv !== "undefined" && img instanceof cv.Mat) {
      return img.clone();
    }
    throw new Error(`LoadImage: unsupported input type ${typeof img}`);
  }

  /**
   * @param {string} url
   * @returns {Promise<cv.Mat>}
   */
  async _loadFromUrl(url) {
    const blob = await fetch(url).then(r => r.blob());
    const bitmap = await createImageBitmap(blob);
    return this._fromImageBitmap(bitmap);
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {Promise<cv.Mat>}
   */
  async _loadFromBytes(bytes) {
    const blob = new Blob([bytes]);
    const bitmap = await createImageBitmap(blob);
    return this._fromImageBitmap(bitmap);
  }

  /**
   * @param {ImageBitmap} bitmap
   * @returns {cv.Mat}
   */
  _fromImageBitmap(bitmap) {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return this._fromImageData(imageData);
  }

  /**
   * @param {HTMLImageElement} elem
   * @returns {cv.Mat}
   */
  _fromHtmlImage(elem) {
    const canvas = document.createElement("canvas");
    canvas.width = elem.naturalWidth;
    canvas.height = elem.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(elem, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return this._fromImageData(imageData);
  }

  /**
   * Converts RGBA ImageData → BGR cv.Mat (3 channels, uint8).
   * @param {ImageData} imageData
   * @returns {cv.Mat}
   */
  _fromImageData(imageData) {
    const rgba = cv.matFromImageData(imageData);
    let bgr = new cv.Mat();
    try {
      cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    } finally {
      rgba.delete();
    }
    return bgr;
  }
}

export default LoadImage;
