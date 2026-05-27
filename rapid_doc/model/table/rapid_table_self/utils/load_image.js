// Copyright (c) Opendatalab. All rights reserved.

/**
 * Load image from various browser-compatible sources into cv.Mat (BGR uint8).
 */
export class LoadImage {
  /**
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

    // Split channels to inspect the alpha channel.
    const channels = new cv.MatVector();
    cv.split(rgba, channels);
    const aChannel = channels.get(3);

    // Check if alpha is non-trivial (i.e. any pixel is not fully opaque).
    // In Python, cvt_four_to_three is only called for 4-channel images loaded
    // from RGBA sources (transparent PNGs). Opaque images arrive as 3-channel
    // and skip this path entirely. In JS, canvas always gives RGBA, so we
    // replicate the split by checking whether the alpha mean is < 255.
    const alphaMean = cv.mean(aChannel);
    const hasTransparency = alphaMean[0] < 255;

    if (!hasTransparency) {
      // Fully opaque image – mirrors the Python 3-channel path (COLOR_RGB2BGR).
      let bgr = new cv.Mat();
      cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
      channels.get(0).delete();
      channels.get(1).delete();
      channels.get(2).delete();
      aChannel.delete();
      channels.delete();
      rgba.delete();
      return bgr;
    }

    // Transparent image – replicate Python cvt_four_to_three exactly.
    const r = channels.get(0);
    const g = channels.get(1);
    const b = channels.get(2);
    // a = aChannel already held above

    // new_img = merge(b, g, r)  →  BGR ordering
    const bgrVec = new cv.MatVector();
    bgrVec.push_back(b);
    bgrVec.push_back(g);
    bgrVec.push_back(r);
    let bgrMat = new cv.Mat();
    cv.merge(bgrVec, bgrMat);

    // not_a = bitwise_not(a);  not_a_bgr = cvtColor(not_a, GRAY2BGR)
    let notA = new cv.Mat();
    cv.bitwise_not(aChannel, notA);
    let notABgr = new cv.Mat();
    cv.cvtColor(notA, notABgr, cv.COLOR_GRAY2BGR);

    // masked = bitwise_and(bgr, bgr, mask=a)  →  transparent pixels become 0
    let masked = new cv.Mat();
    cv.bitwise_and(bgrMat, bgrMat, masked, aChannel);

    // mean_color = np.mean(masked)  →  average over all channels and pixels
    const meanVals = cv.mean(masked);
    const meanColor = (meanVals[0] + meanVals[1] + meanVals[2]) / 3;

    let result = new cv.Mat();
    if (meanColor <= 0.0) {
      // Image is fully transparent / black → white-fill transparent regions
      cv.add(masked, notABgr, result);
    } else {
      // Image has opaque content → invert so transparent areas become white (255)
      cv.bitwise_not(masked, result);
    }

    // Cleanup
    r.delete();
    g.delete();
    b.delete();
    aChannel.delete();
    channels.delete();
    bgrVec.delete();
    bgrMat.delete();
    notA.delete();
    notABgr.delete();
    masked.delete();
    rgba.delete();

    return result;
  }
}

export default LoadImage;
