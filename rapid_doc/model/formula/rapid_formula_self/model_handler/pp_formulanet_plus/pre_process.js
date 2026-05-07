// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: model_handler/pp_formulanet_plus/pre_process.py → pre_process.js
// W2: All cv.Mat objects must be freed in try/finally blocks.
// Python numpy ops → Float32Array with manual math.

/**
 * Crop whitespace margins from a grayscale/BGR image.
 * @param {cv.Mat} img - BGR or grayscale cv.Mat
 * @returns {cv.Mat} Cropped image
 */
function cropMargin(img) {
  let gray = new cv.Mat();
  let inverted = new cv.Mat();
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  try {
    if (img.channels() === 3) {
      cv.cvtColor(img, gray, cv.COLOR_BGR2GRAY);
    } else {
      img.copyTo(gray);
    }
    cv.bitwise_not(gray, inverted);
    cv.findContours(inverted, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    if (contours.size() === 0) return img.clone();

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < contours.size(); i++) {
      const rect = cv.boundingRect(contours.get(i));
      minX = Math.min(minX, rect.x);
      minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + rect.width);
      maxY = Math.max(maxY, rect.y + rect.height);
    }

    const finalRect = new cv.Rect(minX, minY, maxX - minX, maxY - minY);
    const roi = img.roi(finalRect);
    const result = roi.clone();
    roi.delete();
    return result;
  } finally {
    gray.delete();
    inverted.delete();
    contours.delete();
    hierarchy.delete();
  }
}

/**
 * Pre-processing pipeline for PPFormulaNetPlus model (Grayscale version).
 */
export class PPPreProcess {
  constructor(inputSize = [384, 384]) {
    this.targetSize = inputSize; // [width, height]
  }

  /**
   * Preprocess a batch of images into a single Float32Array NCHW tensor.
   * @param {cv.Mat[]} imgList
   * @returns {{ data: Float32Array, dims: number[] }}
   */
  run(imgList) {
    const N = imgList.length;
    const [targetW, targetH] = this.targetSize;
    const data = new Float32Array(N * 1 * targetH * targetW);

    for (let n = 0; n < N; n++) {
      const oriImg = imgList[n];
      let cropped = null, resized = null, gray = null;
      try {
        cropped = cropMargin(oriImg);
        
        // Resize to target size preserving aspect ratio, then pad white
        const scale = Math.min(targetW / cropped.cols, targetH / cropped.rows);
        const newW = Math.round(cropped.cols * scale);
        const newH = Math.round(cropped.rows * scale);

        resized = new cv.Mat();
        cv.resize(cropped, resized, new cv.Size(newW, newH), 0, 0, cv.INTER_LINEAR);

        gray = new cv.Mat(targetH, targetW, cv.CV_8UC1, new cv.Scalar(255));
        const roi = gray.roi(new cv.Rect(0, 0, newW, newH));
        
        let tempGray = new cv.Mat();
        if (resized.channels() === 3) {
          cv.cvtColor(resized, tempGray, cv.COLOR_BGR2GRAY);
        } else {
          resized.copyTo(tempGray);
        }
        tempGray.copyTo(roi);
        roi.delete();
        tempGray.delete();

        const raw = gray.data;
        for (let i = 0; i < targetH * targetW; i++) {
          data[n * targetH * targetW + i] = raw[i] / 255.0;
        }
      } finally {
        if (cropped) cropped.delete();
        if (resized) resized.delete();
        if (gray) gray.delete();
      }
    }

    return { data, dims: [N, 1, targetH, targetW] };
  }
}

export default PPPreProcess;
