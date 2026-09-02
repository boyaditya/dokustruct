// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: model_handler/pp_formulanet_plus/pre_process.py → pre_process.js
// Matches Python's 3-stage pipeline exactly:
//   1. UniMERNetImgDecode: crop_margin → resize → thumbnail → center-pad
//   2. UniMERNetTestTransform: normalize (mean/std) → grayscale → 3ch
//   3. LatexImageFormat: pad to 16x → take channel 0 → [1,1,H,W]

// Normalization constants (from Python pre_process.py line 198-199)
const MEAN = 0.7931;
const STD = 0.1738;
const SCALE = 1.0 / 255.0;

/**
 * Crop whitespace margins using normalized thresholding.
 * PORTING NOTE: Matches Python's crop_margin() exactly (line 39-57):
 *   data = (data - min) / (max - min) * 255
 *   gray = 255 * (data < 200)
 *   coords = cv2.findNonZero(gray)
 *   boundingRect(coords)
 * @param {cv.Mat} img - Input image (BGR or gray)
 * @returns {cv.Mat} Cropped image (caller must delete)
 */
function cropMargin(img) {
  let gray = new cv.Mat();
  try {
    // Convert to grayscale
    if (img.channels() === 3 || img.channels() === 4) {
      cv.cvtColor(img, gray, cv.COLOR_BGR2GRAY);
    } else {
      img.copyTo(gray);
    }

    // Normalize to full 0-255 range (Python: (data - min) / (max - min) * 255)
    const data = gray.data;
    let minVal = 255, maxVal = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] < minVal) minVal = data[i];
      if (data[i] > maxVal) maxVal = data[i];
    }
    if (maxVal === minVal) return img.clone();

    const range = maxVal - minVal;
    const normalized = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      normalized[i] = ((data[i] - minVal) / range) * 255;
    }

    // Threshold at 200: gray = 255 * (data < 200)
    for (let i = 0; i < normalized.length; i++) {
      normalized[i] = normalized[i] < 200 ? 255 : 0;
    }

    // Compute bounding rect of non-zero pixels manually
    // (cv.boundingRect on an image mat doesn't work in OpenCV.js —
    //  it treats the mat as point coordinates, not as an image to scan)
    const rows = gray.rows;
    const cols = gray.cols;
    let minX = cols, minY = rows, maxX = -1, maxY = -1;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (normalized[y * cols + x] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0 || maxY < 0) return img.clone();

    const rect = new cv.Rect(minX, minY, maxX - minX + 1, maxY - minY + 1);
    if (rect.width <= 0 || rect.height <= 0) return img.clone();

    // Crop from original image (convert back to RGB if needed)
    let rgbImg = new cv.Mat();
    if (img.channels() === 1) {
      cv.cvtColor(img, rgbImg, cv.COLOR_GRAY2BGR);
    } else if (img.channels() === 4) {
      cv.cvtColor(img, rgbImg, cv.COLOR_BGRA2BGR);
    } else {
      img.copyTo(rgbImg);
    }

    const roi = rgbImg.roi(rect);
    const result = roi.clone();
    roi.delete();
    rgbImg.delete();
    return result;
  } finally {
    gray.delete();
  }
}

/**
 * Pre-processing pipeline matching Python's 3-stage flow exactly.
 * Stage 1: UniMERNetImgDecode - crop, resize, thumbnail, center-pad
 * Stage 2: UniMERNetTestTransform - normalize mean/std, gray, 3ch
 * Stage 3: LatexImageFormat - pad to 16x, channel 0, [1,1,H,W]
 */
export class PPPreProcess {
  /**
   * @param {[number, number]} inputSize - [width, height] (same as Python's img_size)
   */
  constructor(inputSize = [384, 384]) {
    // Python: input_size = (height, width) but model config may vary
    // In main.js constructor: targetSize comes from model config
    this.targetW = inputSize[0];
    this.targetH = inputSize[1];
  }

  /**
   * Stage 1: UniMERNetImgDecode.img_decode
   * PORTING NOTE: Matches Python lines 133-163
   * @param {cv.Mat} img
   * @returns {cv.Mat|null} RGB image, padded and resized (caller must delete)
   */
  _imgDecode(img) {
    let cropped = null;
    try {
      // 1. Crop margin (Python: self.crop_margin(Image.fromarray(img).convert("RGB")))
      cropped = cropMargin(img);

      if (cropped.rows === 0 || cropped.cols === 0) return null;

      // 2. Resize smallest edge to min(targetW, targetH)
      // Python: self.resize(img, min(self.input_size))
      const minTarget = Math.min(this.targetW, this.targetH);
      const h = cropped.rows;
      const w = cropped.cols;
      const short = Math.min(w, h);
      const long = Math.max(w, h);
      const newShort = minTarget;
      const newLong = Math.floor(minTarget * long / short);
      let newW, newH;
      if (w <= h) {
        newW = newShort;
        newH = newLong;
      } else {
        newW = newLong;
        newH = newShort;
      }

      let resized = new cv.Mat();
      // Python: img.resize(tuple(output_size[::-1]), resample=2)
      // resample=2 is PIL.Image.BILINEAR
      cv.resize(cropped, resized, new cv.Size(newW, newH), 0, 0, cv.INTER_LINEAR);

      // 3. Thumbnail: shrink to fit within (targetW, targetH)
      // Python: img.thumbnail((self.input_size[1], self.input_size[0]))
      // thumbnail preserves aspect ratio and uses LANCZOS
      if (resized.cols > this.targetW || resized.rows > this.targetH) {
        const scale = Math.min(this.targetW / resized.cols, this.targetH / resized.rows);
        const thumbW = Math.round(resized.cols * scale);
        const thumbH = Math.round(resized.rows * scale);
        const thumb = new cv.Mat();
        cv.resize(resized, thumb, new cv.Size(thumbW, thumbH), 0, 0, cv.INTER_AREA);
        resized.delete();
        resized = thumb;
      }

      // 4. Center-pad with BLACK (0,0,0)
      // Python: ImageOps.expand(img, padding) — default fill=0 (BLACK!)
      const deltaW = this.targetW - resized.cols;
      const deltaH = this.targetH - resized.rows;
      const padLeft = Math.floor(deltaW / 2);
      const padTop = Math.floor(deltaH / 2);
      const padRight = deltaW - padLeft;
      const padBottom = deltaH - padTop;

      // Ensure RGB (3 channels)
      let rgb = resized;
      if (resized.channels() === 1) {
        rgb = new cv.Mat();
        cv.cvtColor(resized, rgb, cv.COLOR_GRAY2BGR);
        resized.delete();
      } else if (resized.channels() === 4) {
        rgb = new cv.Mat();
        cv.cvtColor(resized, rgb, cv.COLOR_BGRA2BGR);
        resized.delete();
      }

      const padded = new cv.Mat();
      cv.copyMakeBorder(rgb, padded, padTop, padBottom, padLeft, padRight,
        cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
      rgb.delete();

      return padded;
    } finally {
      if (cropped) cropped.delete();
    }
  }

  /**
   * Stage 2: UniMERNetTestTransform.transform
   * PORTING NOTE: Matches Python lines 188-208
   * Normalizes with mean/std, converts to gray, merges to 3 channels.
   * @param {cv.Mat} img - RGB uint8 image
   * @returns {Float32Array} Normalized pixel data [H, W, 3]
   */
  _testTransform(img) {
    const h = img.rows;
    const w = img.cols;
    const pixels = img.data; // uint8, BGR interleaved
    const ch = img.channels();

    // Python:
    //   img = (img.astype("float32") * scale - mean) / std
    //   grayscale_image = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    //   squeezed = np.squeeze(grayscale_image)
    //   img = cv2.merge([squeezed] * 3)
    //
    // Porting fix: INTENTIONAL R/B coefficient swap — matches Python training distribution. DO NOT "FIX".
    // Python's pipeline feeds RGB-ordered data into cv2.COLOR_BGR2GRAY, which applies
    // BGR weights (0.114·B + 0.587·G + 0.299·R) to what it thinks is BGR but is actually
    // RGB. The net effect is the swapped formula: Y = 0.114·R + 0.587·G + 0.299·B.
    // The model was trained on this distribution; changing the coefficients back to the
    // standard BGR2GRAY formula will break parity with Python inference output.

    const result = new Float32Array(h * w * 3);

    for (let i = 0; i < h * w; i++) {
      // Normalize each channel, then convert to gray
      let grayVal;
      if (ch >= 3) {
        const b = (pixels[i * ch + 0] * SCALE - MEAN) / STD;
        const g = (pixels[i * ch + 1] * SCALE - MEAN) / STD;
        const r = (pixels[i * ch + 2] * SCALE - MEAN) / STD;
        // INTENTIONAL R/B swap (do not "fix" this — see )
        grayVal = 0.114 * r + 0.587 * g + 0.299 * b;
      } else {
        grayVal = (pixels[i] * SCALE - MEAN) / STD;
      }
      // cv2.merge([squeezed] * 3) → duplicate gray to 3 channels
      result[i * 3 + 0] = grayVal;
      result[i * 3 + 1] = grayVal;
      result[i * 3 + 2] = grayVal;
    }
    return result;
  }

  /**
   * Stage 3: LatexImageFormat.format
   * PORTING NOTE: Matches Python lines 229-246
   * Pads to multiple of 16, takes channel 0, outputs [1, 1, padH, padW]
   * @param {Float32Array} data - [H, W, 3] normalized data
   * @param {number} h
   * @param {number} w
   * @returns {{ data: Float32Array, dims: number[] }}
   */
  _latexImageFormat(data, h, w) {
    // Pad to multiple of 16
    const divideH = Math.ceil(h / 16) * 16;
    const divideW = Math.ceil(w / 16) * 16;

    const out = new Float32Array(divideH * divideW);
    // Fill with 1.0 (normalized white)
    // Python: np.pad(..., constant_values=(1, 1))
    out.fill(1.0);

    // Copy channel 0 (img[:, :, 0])
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        out[row * divideW + col] = data[(row * w + col) * 3 + 0];
      }
    }

    return { data: out, dims: [1, 1, divideH, divideW] };
  }

  /**
   * Run full preprocessing pipeline on a batch of images.
   * @param {cv.Mat[]} imgList
   * @returns {{ data: Float32Array, dims: number[] }}
   */
  run(imgList) {
    // For batch size > 1, we'd need to handle variable sizes.
    // Current implementation processes one at a time and stacks.
    // Python also processes one at a time via list comprehension.

    if (imgList.length === 0) {
      return { data: new Float32Array(0), dims: [0, 1, this.targetH, this.targetW] };
    }

    // Process each image through 3 stages
    const results = [];
    for (const oriImg of imgList) {
      // Stage 1: Decode (crop, resize, pad)
      const decoded = this._imgDecode(oriImg);
      if (!decoded) {
        // Failed to decode — create blank white image
        const blank = new Float32Array(this.targetH * this.targetW);
        blank.fill(1.0);
        const divH = Math.ceil(this.targetH / 16) * 16;
        const divW = Math.ceil(this.targetW / 16) * 16;
        results.push({ data: blank, dims: [1, 1, divH, divW] });
        continue;
      }

      try {
        const h = decoded.rows;
        const w = decoded.cols;

        // Stage 2: Normalize (mean/std)
        const normalized = this._testTransform(decoded);

        // Stage 3: Format (pad to 16x, take ch0)
        results.push(this._latexImageFormat(normalized, h, w));
      } finally {
        decoded.delete();
      }
    }

    // For single image, return directly
    if (results.length === 1) {
      return results[0];
    }

    // For batch: all should have same dims after padding to 16x
    // Find max dims and stack
    let maxH = 0, maxW = 0;
    for (const r of results) {
      maxH = Math.max(maxH, r.dims[2]);
      maxW = Math.max(maxW, r.dims[3]);
    }

    const N = results.length;
    const batchData = new Float32Array(N * maxH * maxW);
    batchData.fill(1.0); // pad with normalized white

    for (let n = 0; n < N; n++) {
      const { data: rData, dims: rDims } = results[n];
      const rH = rDims[2], rW = rDims[3];
      for (let row = 0; row < rH; row++) {
        for (let col = 0; col < rW; col++) {
          batchData[n * maxH * maxW + row * maxW + col] = rData[row * rW + col];
        }
      }
    }

    return { data: batchData, dims: [N, 1, maxH, maxW] };
  }
}

export default PPPreProcess;
