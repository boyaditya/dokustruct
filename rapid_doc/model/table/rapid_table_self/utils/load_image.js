// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: rapid_table_self/utils/load_image.py → load_image.js
// Table LoadImage — same pattern as formula but no BGR conversion (returns native format).
// W5: cv.Mat cleanup in try/finally

export class LoadImage {
  /**
   * Load image from various browser-compatible sources into cv.Mat (BGR uint8).
   * @param {HTMLImageElement|ImageBitmap|ImageData|Uint8Array|string} img
   * @returns {Promise<cv.Mat>}
   */
  async run(img) {
    if (typeof img === "string") return this._fromUrl(img);
    if (img instanceof Uint8Array || img instanceof ArrayBuffer) {
      const bytes = img instanceof ArrayBuffer ? new Uint8Array(img) : img;
      return this._fromBytes(bytes);
    }
    if (img instanceof ImageData) return this._fromImageData(img);
    if (img instanceof ImageBitmap) return this._fromBitmap(img);
    if (img instanceof HTMLImageElement) return this._fromHtmlImage(img);
    if (typeof cv !== "undefined" && img instanceof cv.Mat) return img.clone();
    throw new Error(`LoadImage: unsupported input type ${typeof img}`);
  }

  async _fromUrl(url) {
    const blob = await fetch(url).then(r => r.blob());
    const bitmap = await createImageBitmap(blob);
    return this._fromBitmap(bitmap);
  }

  async _fromBytes(bytes) {
    const blob = new Blob([bytes]);
    const bitmap = await createImageBitmap(blob);
    return this._fromBitmap(bitmap);
  }

  _fromBitmap(bitmap) {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    return this._fromImageData(ctx.getImageData(0, 0, bitmap.width, bitmap.height));
  }

  _fromHtmlImage(elem) {
    const canvas = document.createElement("canvas");
    canvas.width = elem.naturalWidth;
    canvas.height = elem.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(elem, 0, 0);
    return this._fromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
  }

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
