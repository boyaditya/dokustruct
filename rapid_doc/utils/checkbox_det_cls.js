// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: checkbox_det_cls.py → checkbox_det_cls.js
 *
 * WORKAROUND: cv2 / numpy → OpenCV.js (cv global)
 * REASON: Python cv2/numpy not available in browser
 * SOLUTION: Equivalent cv operations using cv.Mat
 *   - cv2.cvtColor → cv.cvtColor
 *   - cv2.threshold / THRESH_BINARY → cv.threshold
 *   - cv2.morphologyEx → cv.morphologyEx
 *   - cv2.connectedComponentsWithStats → cv.connectedComponentsWithStats
 *   - cv2.findContours → cv.findContours
 *   - cv2.GaussianBlur → cv.GaussianBlur
 *   - cv2.adaptiveThreshold → cv.adaptiveThreshold
 *   - cv2.countNonZero → cv.countNonZero
 *
 * WORKAROUND: matplotlib.pyplot (debug display)
 * REASON: Not available in browser
 * SOLUTION: Omitted — debug display not needed
 *
 * WORKAROUND: Counter (collections)
 * SOLUTION: Use Map with frequency counting
 */

/**
 * Detect checkbox candidates from a BGR cv.Mat image.
 * PORTING NOTE: detect_checkboxes → detectCheckboxes
 *
 * @param {cv.Mat} image - BGR cv.Mat
 * @param {number} [lineMinWidth=15]
 * @param {number} [lineMaxWidth=15]
 * @returns {{ stats: cv.Mat, labels: cv.Mat, imgBinFinal: cv.Mat }}
 */
export function detectCheckboxes(image, lineMinWidth = 15, lineMaxWidth = 15) {
  const gray = new cv.Mat();
  cv.cvtColor(image, gray, cv.COLOR_BGR2GRAY);

  let imgBin = new cv.Mat();
  cv.threshold(gray, imgBin, 150, 255, cv.THRESH_BINARY);
  gray.delete();

  // Invert
  cv.bitwise_not(imgBin, imgBin);

  // Morphological kernels
  const kHMin = cv.Mat.ones(1, lineMinWidth, cv.CV_8U);
  const kVMin = cv.Mat.ones(lineMinWidth, 1, cv.CV_8U);
  const kHMax = cv.Mat.ones(1, lineMaxWidth, cv.CV_8U);
  const kVMax = cv.Mat.ones(lineMaxWidth, 1, cv.CV_8U);

  const anchor = new cv.Point(-1, -1);
  const imgBinHMin = new cv.Mat(); cv.morphologyEx(imgBin, imgBinHMin, cv.MORPH_OPEN,  kHMin, anchor, 1);
  const imgBinVMin = new cv.Mat(); cv.morphologyEx(imgBin, imgBinVMin, cv.MORPH_OPEN,  kVMin, anchor, 1);
  const imgBinHMax = new cv.Mat(); cv.morphologyEx(imgBin, imgBinHMax, cv.MORPH_CLOSE, kHMax, anchor, 1);
  const imgBinVMax = new cv.Mat(); cv.morphologyEx(imgBin, imgBinVMax, cv.MORPH_CLOSE, kVMax, anchor, 1);
  imgBin.delete(); kHMin.delete(); kVMin.delete(); kHMax.delete(); kVMax.delete();

  // (h_min & h_max) | (v_min & v_max)
  const hCombined = new cv.Mat(); cv.bitwise_and(imgBinHMin, imgBinHMax, hCombined);
  const vCombined = new cv.Mat(); cv.bitwise_and(imgBinVMin, imgBinVMax, vCombined);
  imgBinHMin.delete(); imgBinVMin.delete(); imgBinHMax.delete(); imgBinVMax.delete();

  const imgBinFinal = new cv.Mat(); cv.bitwise_or(hCombined, vCombined, imgBinFinal);
  hCombined.delete(); vCombined.delete();

  // Dilate
  const finalKernel = cv.Mat.ones(3, 3, cv.CV_8U);
  cv.dilate(imgBinFinal, imgBinFinal, finalKernel, anchor, 1);
  finalKernel.delete();

  // connectedComponentsWithStats on inverted
  const invFinal = new cv.Mat(); cv.bitwise_not(imgBinFinal, invFinal);
  const labels = new cv.Mat(); const stats = new cv.Mat(); const centroids = new cv.Mat();
  cv.connectedComponentsWithStats(invFinal, labels, stats, centroids, 8, cv.CV_32S);
  invFinal.delete(); centroids.delete();

  return { stats, labels, imgBinFinal };
}

/**
 * Classify detected checkboxes as Ticked or Unticked.
 * PORTING NOTE: classify_checkboxes → classifyCheckboxes
 *
 * @param {cv.Mat} image - BGR
 * @param {cv.Mat} stats
 * @param {cv.Mat} imgBinFinal
 * @param {number} [minWidth=12]
 * @param {number} [maxWidth=50]
 * @param {number} [tickThreshold=0.2]
 * @returns {Array<[number, number, number, number, string, string]>}
 */
export function classifyCheckboxes(image, stats, imgBinFinal, minWidth = 12, maxWidth = 50, tickThreshold = 0.2) {
  const checkboxes = [];
  const hImg = imgBinFinal.rows;
  const wImg = imgBinFinal.cols;

  // Row 0 = background, Row 1 = whole image; skip both. stats has shape (N, 5): x,y,w,h,area
  const numComponents = stats.rows;
  for (let i = 2; i < numComponents; i++) {
    const x    = stats.intAt(i, cv.CC_STAT_LEFT);
    const y    = stats.intAt(i, cv.CC_STAT_TOP);
    const w    = stats.intAt(i, cv.CC_STAT_WIDTH);
    const h    = stats.intAt(i, cv.CC_STAT_HEIGHT);
    const aspectRatio = w / h;

    if (!(minWidth <= w && w <= maxWidth && minWidth <= h && h <= maxWidth && 0.9 <= aspectRatio && aspectRatio <= 1.1)) {
      continue;
    }

    // Expand bounding box
    const expandL = 0.1, expandR = 0.1, expandT = 0.1, expandB = 0.3;
    const newX = Math.max(Math.trunc(x - w * expandL), 0);
    const newY = Math.max(Math.trunc(y - h * expandT), 0);
    const newW = Math.min(Math.trunc(w * (1 + expandL + expandR)), wImg - newX);
    const newH = Math.min(Math.trunc(h * (1 + expandT + expandB)), hImg - newY);

    // Find contours in expanded ROI of imgBinFinal
    const roi = imgBinFinal.roi(new cv.Rect(newX, newY, newW, newH));
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(roi, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    roi.delete(); hierarchy.delete();

    // Collect all y-coordinates in contours (global)
    const allYs = [];
    for (let ci = 0; ci < contours.size(); ci++) {
      const pts = contours.get(ci);
      for (let pi = 0; pi < pts.rows; pi++) {
        allYs.push(pts.intAt(pi, 0, 1) + newY);
      }
      pts.delete();
    }
    contours.delete();

    if (!allYs.length) continue;

    // Count y frequency
    const yCounts = new Map();
    for (const yv of allYs) yCounts.set(yv, (yCounts.get(yv) || 0) + 1);
    const sortedYs = [...yCounts.entries()].sort((a, b) => b[1] - a[1]);
    const topYs = sortedYs.slice(0, 2).map(e => e[0]);
    const bottomY = Math.max(...topYs);
    const yMax = Math.max(...allYs);
    const diff = yMax - bottomY;
    if (diff >= 0.9) continue;

    // Classify tick percentage using adaptive threshold on BGR ROI
    const roiImg = image.roi(new cv.Rect(x, y, w, h));
    const grayRoi = new cv.Mat(); cv.cvtColor(roiImg, grayRoi, cv.COLOR_BGR2GRAY);
    const blurred = new cv.Mat(); cv.GaussianBlur(grayRoi, blurred, new cv.Size(5, 5), 0);
    grayRoi.delete();

    const binaryRoi = new cv.Mat();
    cv.adaptiveThreshold(blurred, binaryRoi, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 11, 2);
    blurred.delete();

    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.morphologyEx(binaryRoi, binaryRoi, cv.MORPH_OPEN, kernel);
    kernel.delete();

    const nonWhite = cv.countNonZero(binaryRoi);
    binaryRoi.delete(); roiImg.delete();

    const totalPixels = w * h;
    const tickPercentage = nonWhite / totalPixels;

    if (tickPercentage > tickThreshold) {
      checkboxes.push([x, y, w, h, 'Ticked', '☑']);
    } else {
      checkboxes.push([x, y, w, h, 'Unticked', '☐']);
    }
  }
  return checkboxes;
}

/**
 * Predict checkboxes in a BGR cv.Mat image.
 * PORTING NOTE: checkbox_predict(image: np.ndarray) → checkboxPredict(image: cv.Mat)
 *
 * @param {cv.Mat} image - BGR cv.Mat
 * @returns {Array<{bbox: number[], label: string, text: string}>}
 */
export function checkboxPredict(image) {
  const { stats, labels, imgBinFinal } = detectCheckboxes(image);
  const checkboxResults = classifyCheckboxes(image, stats, imgBinFinal);
  stats.delete(); labels.delete(); imgBinFinal.delete();

  return checkboxResults.map(([x, y, w, h, label, text]) => ({
    bbox: [x, y, x + w, y + h],
    label,
    text,
  }));
}
