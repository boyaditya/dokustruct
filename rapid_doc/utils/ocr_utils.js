/**
 * Utility functions used by RapidOcrModel.
 *
 * Provides OCR text-box manipulation: sorting, merging, coordinate remapping,
 * perspective cropping, and angle detection.
 */

/* global cv */

// ─── Constants ─────────────────────────────────────────────────────────────────

export const OcrConfidence = Object.freeze({
  minConfidence: 0.5,
  minWidth: 3,
});

/** Line width:height ratio above which horizontal merging is applied. */
const LINE_WIDTH_TO_HEIGHT_RATIO_THRESHOLD = 4;

/** Height-to-width ratio above which a cropped image is rotated 90°. */
const ROTATE_ASPECT_RATIO = 2;

// ─── Overlap helpers ──────────────────────────────────────────────────────────

function _isOverlapsYExceedsThreshold(bbox1, bbox2, threshold = 0.8) {
  if (!bbox1 || !bbox2) return false;
  const [, y0_1, , y1_1] = bbox1;
  const [, y0_2, , y1_2] = bbox2;
  const overlap = Math.max(0, Math.min(y1_1, y1_2) - Math.max(y0_1, y0_2));
  const minH = Math.min(y1_1 - y0_1, y1_2 - y0_2);
  return minH > 0 ? (overlap / minH) > threshold : false;
}

function _isOverlapsXExceedsThreshold(bbox1, bbox2, threshold = 0.8) {
  if (!bbox1 || !bbox2) return false;
  const [x0_1, , x1_1] = bbox1;
  const [x0_2, , x1_2] = bbox2;
  const overlap = Math.max(0, Math.min(x1_1, x1_2) - Math.max(x0_1, x0_2));
  const minW = Math.min(x1_1 - x0_1, x1_2 - x0_2);
  return minW > 0 ? (overlap / minW) > threshold : false;
}

// Public aliases (used by span_block_fix.js)
export { _isOverlapsYExceedsThreshold as isOverlapsYExceedsThreshold };
export { _isOverlapsXExceedsThreshold as isOverlapsXExceedsThreshold };

// ─── mergeSpansToLine ─────────────────────────────────────────────────────────

/**
 * Group spans into text lines based on Y-axis overlap.
 *
 * @param {Array<{bbox:[number,number,number,number]}>} spans
 * @param {number} [threshold=0.6]
 * @returns {Array<Array<{bbox:[number,number,number,number]}>>}
 */
export function mergeSpansToLine(spans, threshold = 0.6) {
  if (!Array.isArray(spans) || spans.length === 0) return [];

  const sorted = [...spans].sort((a, b) => a.bbox[1] - b.bbox[1]);
  const lines = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const span = sorted[i];
    const currentLine = lines[lines.length - 1];
    if (_isOverlapsYExceedsThreshold(span.bbox, currentLine[currentLine.length - 1].bbox, threshold)) {
      currentLine.push(span);
    } else {
      lines.push([span]);
    }
  }
  return lines;
}

// ─── imgDecode / checkImg ─────────────────────────────────────────────────────

/**
 * Decode bytes to a BGR cv.Mat.
 *
 * @param {Uint8Array|ArrayBuffer} content
 * @returns {cv.Mat} caller must delete
 */
export function imgDecode(content) {
  if (!content) {
    throw new Error('imgDecode: content is null or undefined');
  }
  const arr = content instanceof ArrayBuffer ? new Uint8Array(content) : content;

  if (typeof cv.imdecode === 'function') {
    const buf = cv.matFromArray(arr.length, 1, cv.CV_8UC1, arr);
    const decoded = cv.imdecode(buf, cv.IMREAD_UNCHANGED);
    buf.delete();
    return decoded;
  }

  throw new Error(
    'imgDecode: cv.imdecode is not available in this OpenCV.js build. ' +
    'Please pass a cv.Mat (or OffscreenCanvas/ImageBitmap) instead of raw bytes.'
  );
}

/**
 * Ensure the image is a BGR 3-channel cv.Mat.
 *
 * @param {Uint8Array|ArrayBuffer|cv.Mat} img
 * @returns {cv.Mat} caller must delete
 */
export function checkImg(img) {
  if (!img) {
    throw new Error('checkImg: img is null or undefined');
  }
  if (!(img instanceof cv.Mat)) {
    img = imgDecode(img);
  }
  if (img.channels() === 1) {
    const out = new cv.Mat();
    cv.cvtColor(img, out, cv.COLOR_GRAY2BGR);
    img.delete();
    return out;
  }
  return img;
}

// ─── alphaToColor / preprocessImage ──────────────────────────────────────────

/**
 * Flatten alpha channel against a solid colour background.
 *
 * @param {cv.Mat} img
 * @param {[number,number,number]} [alphaColor=[255,255,255]]
 * @returns {cv.Mat} new Mat if input had alpha; same Mat otherwise
 */
export function alphaToColor(img, alphaColor = [255, 255, 255]) {
  if (!img) return img;
  if (img.channels() !== 4) return img;

  const channels = new cv.MatVector();
  cv.split(img, channels);
  const A = channels.get(3);

  const [ar, ag, ab] = alphaColor;
  const result = new cv.Mat(img.rows, img.cols, cv.CV_8UC3);

  const bData = channels.get(0).data;
  const gData = channels.get(1).data;
  const rData = channels.get(2).data;
  const aData = A.data;
  const outData = result.data;
  const pixelCount = img.rows * img.cols;

  for (let i = 0; i < pixelCount; i++) {
    const a = aData[i] / 255;
    outData[i * 3] = Math.round(ab * (1 - a) + bData[i] * a);
    outData[i * 3 + 1] = Math.round(ag * (1 - a) + gData[i] * a);
    outData[i * 3 + 2] = Math.round(ar * (1 - a) + rData[i] * a);
  }

  for (let i = 0; i < 4; i++) channels.get(i).delete();
  channels.delete();
  A.delete();
  return result;
}

/**
 * Apply alpha-to-white compositing.
 *
 * @param {cv.Mat} image
 * @returns {cv.Mat} caller must delete
 */
export function preprocessImage(image) {
  return alphaToColor(image, [255, 255, 255]);
}

// ─── sortedBoxes ──────────────────────────────────────────────────────────────

/**
 * Sort detected text quads top-to-bottom, left-to-right.
 *
 * @param {Array<Array<[number,number]>>} dtBoxes
 * @returns {Array<Array<[number,number]>>}
 */
export function sortedBoxes(dtBoxes) {
  if (!Array.isArray(dtBoxes) || dtBoxes.length === 0) return [];

  const boxes = [...dtBoxes].sort((a, b) =>
    a[0][1] !== b[0][1] ? a[0][1] - b[0][1] : a[0][0] - b[0][0]
  );

  for (let i = 0; i < boxes.length - 1; i++) {
    for (let j = i; j >= 0; j--) {
      if (Math.abs(boxes[j + 1][0][1] - boxes[j][0][1]) < 10 &&
          boxes[j + 1][0][0] < boxes[j][0][0]) {
        [boxes[j], boxes[j + 1]] = [boxes[j + 1], boxes[j]];
      } else {
        break;
      }
    }
  }
  return boxes;
}

// ─── bbox / points conversion ─────────────────────────────────────────────────

/**
 * [x0,y0,x1,y1] → [[x0,y0],[x1,y0],[x1,y1],[x0,y1]]
 * @param {[number,number,number,number]} bbox
 * @returns {Array<[number,number]>}
 */
export function bboxToPoints(bbox) {
  if (!bbox) return null;
  const [x0, y0, x1, y1] = bbox;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/**
 * [[x0,y0],[x1,y0],[x1,y1],[x0,y1]] → [x0,y0,x1,y1]
 * @param {Array<[number,number]>} points
 * @returns {[number,number,number,number]}
 */
export function pointsToBbox(points) {
  if (!points || points.length < 3) return null;
  return [points[0][0], points[0][1], points[1][0], points[2][1]];
}

// ─── calculateIsAngle ─────────────────────────────────────────────────────────

/**
 * Detect if a text quad is significantly tilted.
 *
 * @param {Array<[number,number]>} poly - 4 vertices
 * @returns {boolean}
 */
export function calculateIsAngle(poly) {
  if (!poly || poly.length < 4) return false;
  const [p1, p2, p3, p4] = poly;
  const height = ((p4[1] - p1[1]) + (p3[1] - p2[1])) / 2;
  const vertDiff = p3[1] - p1[1];
  return !(0.8 * height <= vertDiff && vertDiff <= 1.2 * height);
}

// ─── Angle correction (shared helper) ─────────────────────────────────────────

/**
 * Correct tilted polygon vertices to an axis-aligned rectangle
 * centered on the polygon's geometric center.
 *
 * @param {Array<[number,number]>} poly - [p1, p2, p3, p4]
 * @returns {Array<[number,number]>} corrected [p1, p2, p3, p4]
 */
function correctAngledPoly(poly) {
  const [p1, p2, p3, p4] = poly;
  const xCenter = (p1[0] + p2[0] + p3[0] + p4[0]) / 4;
  const yCenter = (p1[1] + p2[1] + p3[1] + p4[1]) / 4;
  const nh = ((p4[1] - p1[1]) + (p3[1] - p2[1])) / 2;
  const nw = p3[0] - p1[0];
  return [
    [xCenter - nw / 2, yCenter - nh / 2],
    [xCenter + nw / 2, yCenter - nh / 2],
    [xCenter + nw / 2, yCenter + nh / 2],
    [xCenter - nw / 2, yCenter + nh / 2],
  ];
}

// ─── mergeIntervals / removeIntervals ─────────────────────────────────────────

/**
 * @param {[number,number][]} intervals
 * @returns {[number,number][]}
 */
export function mergeIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of sorted) {
    if (!merged.length || merged[merged.length - 1][1] < interval[0]) {
      merged.push([...interval]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], interval[1]);
    }
  }
  return merged;
}

/**
 * @param {[number,number]} original
 * @param {[number,number][]} masks
 * @returns {[number,number][]}
 */
export function removeIntervals(original, masks) {
  if (!original) return [];
  if (!Array.isArray(masks) || masks.length === 0) return [[original[0], original[1]]];

  const mergedMasks = mergeIntervals(masks);
  const result = [];
  let start = original[0];
  const end = original[1];

  for (const [mStart, mEnd] of mergedMasks) {
    if (mStart > end) continue;
    if (mEnd < start) continue;
    if (start < mStart) result.push([start, mStart - 1]);
    start = Math.max(mEnd + 1, start);
  }
  if (start <= end) result.push([start, end]);
  return result;
}

// ─── updateDetBoxes ───────────────────────────────────────────────────────────

/**
 * Remove portions of text boxes that overlap with math formula regions.
 *
 * @param {Array<Array<[number,number]>>} dtBoxes
 * @param {Array<{bbox:[number,number,number,number]}>} mfdRes
 * @returns {Array<Array<[number,number]>>}
 */
export function updateDetBoxes(dtBoxes, mfdRes) {
  if (!Array.isArray(dtBoxes) || dtBoxes.length === 0) return [];
  if (!Array.isArray(mfdRes) || mfdRes.length === 0) return dtBoxes;

  const newDtBoxes = [];
  const angleBoxesList = [];

  for (const textBox of dtBoxes) {
    if (calculateIsAngle(textBox)) {
      angleBoxesList.push(textBox);
      continue;
    }

    const textBbox = pointsToBbox(textBox);
    const masksList = [];
    for (const mfBox of mfdRes) {
      const mfBbox = mfBox.bbox;
      if (_isOverlapsYExceedsThreshold(textBbox, mfBbox)) {
        masksList.push([mfBbox[0], mfBbox[2]]);
      }
    }

    const textXRange = [textBbox[0], textBbox[2]];
    const textRemoveMaskRange = removeIntervals(textXRange, masksList);
    for (const range of textRemoveMaskRange) {
      newDtBoxes.push(bboxToPoints([range[0], textBbox[1], range[1], textBbox[3]]));
    }
  }

  return [...newDtBoxes, ...angleBoxesList];
}

// ─── mergeOverlappingSpans / mergeDetBoxes ────────────────────────────────────

/**
 * Merge horizontally overlapping bboxes within the same line.
 *
 * @param {[number,number,number,number][]} spans
 * @returns {[number,number,number,number][]}
 */
export function mergeOverlappingSpans(spans) {
  if (!Array.isArray(spans) || spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const span of sorted) {
    const [x1, y1, x2, y2] = span;
    if (!merged.length || merged[merged.length - 1][2] < x1) {
      merged.push([x1, y1, x2, y2]);
    } else {
      const last = merged.pop();
      merged.push([
        Math.min(last[0], x1),
        Math.min(last[1], y1),
        Math.max(last[2], x2),
        Math.max(last[3], y2),
      ]);
    }
  }
  return merged;
}

/**
 * Merge adjacent text quads into longer horizontal text regions.
 *
 * @param {Array<Array<[number,number]>>} dtBoxes
 * @returns {Array<Array<[number,number]>>}
 */
export function mergeDetBoxes(dtBoxes) {
  if (!Array.isArray(dtBoxes) || dtBoxes.length === 0) return [];

  const dtBoxesDictList = [];
  const angleBoxesList = [];

  for (const textBox of dtBoxes) {
    if (calculateIsAngle(textBox)) {
      angleBoxesList.push(textBox);
      continue;
    }
    dtBoxesDictList.push({ bbox: pointsToBbox(textBox) });
  }

  const lines = mergeSpansToLine(dtBoxesDictList);
  const newDtBoxes = [];

  for (const line of lines) {
    const lineBboxList = line.map(s => s.bbox);
    const minX = Math.min(...lineBboxList.map(b => b[0]));
    const maxX = Math.max(...lineBboxList.map(b => b[2]));
    const minY = Math.min(...lineBboxList.map(b => b[1]));
    const maxY = Math.max(...lineBboxList.map(b => b[3]));
    const lineWidth = maxX - minX;
    const lineHeight = maxY - minY;

    if (lineWidth > lineHeight * LINE_WIDTH_TO_HEIGHT_RATIO_THRESHOLD) {
      const merged = mergeOverlappingSpans(lineBboxList);
      for (const span of merged) newDtBoxes.push(bboxToPoints(span));
    } else {
      for (const bbox of lineBboxList) newDtBoxes.push(bboxToPoints(bbox));
    }
  }

  return [...newDtBoxes, ...angleBoxesList];
}

// ─── getRotateCropImage ───────────────────────────────────────────────────────

/**
 * Perspective-correct crop of a text region.
 *
 * @param {cv.Mat} img - BGR source image (not modified)
 * @param {Array<[number,number]>} points - 4 vertices [[x,y],...]
 * @returns {cv.Mat} Cropped, perspective-corrected Mat. Caller must delete.
 */
export function getRotateCropImage(img, points) {
  if (!img || !points || points.length !== 4) {
    throw new Error('getRotateCropImage: requires a valid img and exactly 4 points');
  }

  const cropW = Math.max(1, Math.trunc(Math.max(
    _euclideanDist(points[0], points[1]),
    _euclideanDist(points[2], points[3])
  )));
  const cropH = Math.max(1, Math.trunc(Math.max(
    _euclideanDist(points[0], points[3]),
    _euclideanDist(points[1], points[2])
  )));

  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2,
    points.flatMap(([x, y]) => [x, y]));
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2,
    [0, 0, cropW, 0, cropW, cropH, 0, cropH]);

  const M = cv.getPerspectiveTransform(srcPts, dstPts);
  const dst = new cv.Mat();
  cv.warpPerspective(
    img, dst, M,
    new cv.Size(cropW, cropH),
    cv.INTER_CUBIC,
    cv.BORDER_REPLICATE,
  );

  srcPts.delete();
  dstPts.delete();
  M.delete();

  if (dst.rows / dst.cols >= ROTATE_ASPECT_RATIO) {
    const rotated = new cv.Mat();
    cv.rotate(dst, rotated, cv.ROTATE_90_COUNTERCLOCKWISE);
    dst.delete();
    return rotated;
  }

  return dst;
}

/**
 * Euclidean distance between two 2D points.
 * @param {[number,number]} a
 * @param {[number,number]} b
 * @returns {number}
 */
function _euclideanDist(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// ─── getAdjustedMfdetrec ──────────────────────────────────────────────────────

/**
 * Adjust math formula detection results to the crop coordinate system.
 *
 * @param {Array<Object>} mfdetrecRes
 * @param {number[]} usefulList [pasteX,pasteY,xmin,ymin,xmax,ymax,newW,newH]
 * @param {boolean} [returnText=false]
 * @returns {Array<Object>}
 */
export { getAdjustedMfdetrec as getAdjustedMfdetrecRes };
export function getAdjustedMfdetrec(mfdetrecRes, usefulList, returnText = false) {
  if (!Array.isArray(mfdetrecRes) || mfdetrecRes.length === 0) return [];
  if (!Array.isArray(usefulList)) return [];

  const [pasteX, pasteY, xmin, ymin, , , newWidth, newHeight] = usefulList;
  const adjusted = [];

  for (const mfRes of mfdetrecRes) {
    const [mfXmin, mfYmin, mfXmax, mfYmax] = mfRes.bbox;
    const x0 = mfXmin - xmin + pasteX;
    const y0 = mfYmin - ymin + pasteY;
    const x1 = mfXmax - xmin + pasteX;
    const y1 = mfYmax - ymin + pasteY;

    if (x1 < 0 || y1 < 0 || x0 > newWidth || y0 > newHeight) continue;

    const r = { bbox: [x0, y0, x1, y1] };
    if (returnText) {
      if (mfRes.latex) r.latex = mfRes.latex;
      if (mfRes.checkbox) r.checkbox = mfRes.checkbox;
    }
    adjusted.push(r);
  }
  return adjusted;
}

// ─── isMostlyTilted ───────────────────────────────────────────────────────────

/**
 * Check if the majority of OCR result polygons are tilted.
 *
 * @param {Array<Array<[number,number]>>} ocrRes - array of 4-point polys
 * @param {number} [threshold=1.0]
 * @returns {boolean}
 */
export function isMostlyTilted(ocrRes, threshold = 1.0) {
  if (!Array.isArray(ocrRes) || ocrRes.length === 0) return false;

  let angleSum = 0;
  for (const poly of ocrRes) {
    const [p0, p1] = [poly[0], poly[1]];
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    let deg = Math.abs(Math.atan2(dy, dx) * (180 / Math.PI)) % 180;
    deg = Math.round(deg * 100) / 100;
    angleSum += deg;
  }
  const avg = Math.round((angleSum / ocrRes.length) * 100) / 100;
  return Math.abs(avg) > threshold && Math.abs(avg - 180) > threshold;
}

// ─── getOcrResultList ─────────────────────────────────────────────────────────

/**
 * Convert raw OCR results to the internal dict format, remapping to
 * original image coordinates.
 *
 * @param {Array} ocrRes
 * @param {number[]} usefulList [pasteX,pasteY,xmin,ymin,xmax,ymax,newW,newH]
 * @param {boolean} ocrEnable
 * @param {cv.Mat} bgrImage
 * @param {string} lang
 * @param {string} originalLabel
 * @param {number} [originalOrder=-1]
 * @returns {Array<Object>}
 */
export function getOcrResultList(ocrRes, usefulList, ocrEnable, bgrImage, lang, originalLabel, originalOrder = -1) {
  if (!Array.isArray(ocrRes) || ocrRes.length === 0) return [];

  if (!ocrEnable && isMostlyTilted(ocrRes.map(r => Array.isArray(r[0]) ? r[0] : r))) {
    ocrEnable = true;
  }

  const [pasteX, pasteY, xmin, ymin] = usefulList;
  const results = [];

  for (const boxOcrRes of ocrRes) {
    const parsed = _parseBoxOcrEntry(boxOcrRes, ocrEnable, bgrImage);
    if (!parsed) continue;

    const { poly, text, score, imgCrop } = parsed;
    if ((poly[2][0] - poly[0][0]) < OcrConfidence.minWidth) continue;

    const finalPoly = calculateIsAngle(poly) ? correctAngledPoly(poly) : poly;
    const remappedPoly = _remapPoly(finalPoly, pasteX, pasteY, xmin, ymin);

    const entry = {
      category_id: 15,
      original_label: originalLabel,
      original_order: originalOrder,
      poly: remappedPoly.flat().map(v => parseFloat(v)),
      score: parseFloat(score.toFixed(2)),
      text,
      lang,
    };
    if (imgCrop) entry.np_img = imgCrop;
    results.push(entry);
  }

  return results;
}

/**
 * Parse a single OCR box entry into its components.
 * @returns {{ poly, text, score, imgCrop }|null}
 */
function _parseBoxOcrEntry(boxOcrRes, ocrEnable, bgrImage) {
  let p1, p2, p3, p4, text, score, imgCrop;

  if (Array.isArray(boxOcrRes[0]) && boxOcrRes[0].length === 4) {
    [p1, p2, p3, p4] = boxOcrRes[0];
    [text, score] = boxOcrRes[1];
    if (score < OcrConfidence.minConfidence) return null;
  } else {
    [p1, p2, p3, p4] = boxOcrRes;
    text = '';
    score = 1;
    if (ocrEnable) {
      const pts = [[...p1], [...p2], [...p3], [...p4]].map(p => p.map(Number));
      imgCrop = getRotateCropImage(bgrImage, pts);
    }
  }

  return { poly: [p1, p2, p3, p4], text, score, imgCrop };
}

/**
 * Remap polygon vertices from crop coordinates to original image coordinates.
 * @param {Array<[number,number]>} poly
 * @param {number} pasteX
 * @param {number} pasteY
 * @param {number} xmin
 * @param {number} ymin
 * @returns {Array<[number,number]>}
 */
function _remapPoly(poly, pasteX, pasteY, xmin, ymin) {
  return poly.map(([px, py]) => [px - pasteX + xmin, py - pasteY + ymin]);
}

// ─── Seal OCR helpers ─────────────────────────────────────────────────────────

/**
 * Sort polygon boxes by min-y then min-x, matching Python SortPolyBoxes.
 * FIX O1/O2: used in _ocrSeal path for poly-type boxes.
 * @param {Array<Array<[number,number]>>} polys  - each poly is an array of [x,y] points
 * @returns {Array<Array<[number,number]>>}
 */
export function sortPolyBoxes(polys) {
  if (!Array.isArray(polys) || polys.length === 0) return [];
  return [...polys].sort((a, b) => {
    const aMinY = Math.min(...a.map(p => p[1]));
    const bMinY = Math.min(...b.map(p => p[1]));
    if (aMinY !== bMinY) return aMinY - bMinY;
    const aMinX = Math.min(...a.map(p => p[0]));
    const bMinX = Math.min(...b.map(p => p[0]));
    return aMinX - bMinX;
  });
}

/**
 * Crop image regions defined by polygons using bounding-rectangle perspective warp.
 * Matches Python CropByPolys(det_box_type='poly') get_poly_rect_crop simplified path:
 * for curved text the full AutoRectifier is used in Python; here we use minAreaRect
 * perspective warp which is equivalent for circular-seal text (4-point approximation).
 *
 * FIX O2: poly path — perspective crop per polygon.
 * @param {cv.Mat} image
 * @param {Array<Array<[number,number]>>} polys
 * @returns {cv.Mat[]} Caller must delete each returned Mat.
 */
export function cropByPolys(image, polys) {
  return polys.map(poly => _warpPolyRectCrop(image, poly));
}

/**
 * Crop a polygon region via minAreaRect perspective warp.
 * Equivalent to Python get_poly_rect_crop when IoU >= 0.7 (the typical seal case).
 * @private
 * @param {cv.Mat} img
 * @param {Array<[number,number]>} points - N × [x,y]
 * @returns {cv.Mat} caller must delete
 */
function _warpPolyRectCrop(img, points) {
  // Build a cv.Mat from all polygon points for minAreaRect
  const flatPts = points.flat();
  const ptsMat = cv.matFromArray(points.length, 1, cv.CV_32FC2, flatPts);
  let rect, box;
  try {
    rect = cv.minAreaRect(ptsMat);
  } finally {
    ptsMat.delete();
  }

  // cv.boxPoints returns a 4×2 float32 mat
  const bpMat = cv.boxPoints(rect);
  try {
    const d = bpMat.data32F;
    box = [[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]];
  } finally {
    bpMat.delete();
  }

  // Sort ascending by x to determine left/right pairs
  const sortedByX = [...box].sort((a, b) => a[0] - b[0]);
  let ia, ib, ic, id;
  if (sortedByX[1][1] > sortedByX[0][1]) { ia = 0; id = 1; }
  else { ia = 1; id = 0; }
  if (sortedByX[3][1] > sortedByX[2][1]) { ib = 2; ic = 3; }
  else { ib = 3; ic = 2; }

  const orderedBox = [sortedByX[ia], sortedByX[ib], sortedByX[ic], sortedByX[id]];
  return getRotateCropImage(img, orderedBox);
}

// ─── getOcrResultListTable ────────────────────────────────────────────────────

/**
 * Convert raw OCR results for table cells to the internal dict format.
 *
 * @param {Array<Array<[number,number]>>} ocrRes - raw 4-vertex boxes
 * @param {number[]} usefulList
 * @param {number} scale
 * @returns {Array<Object>}
 */
export function getOcrResultListTable(ocrRes, usefulList, scale) {
  if (!Array.isArray(ocrRes) || ocrRes.length === 0) return [];
  if (!usefulList) return [];

  const [pasteX, pasteY, xmin, ymin] = usefulList;
  const results = [];

  for (const boxOcrRes of ocrRes) {
    const [p1, p2, p3, p4] = boxOcrRes;
    const poly = [p1, p2, p3, p4];

    if ((p3[0] - p1[0]) < OcrConfidence.minWidth) continue;

    const finalPoly = calculateIsAngle(poly) ? correctAngledPoly(poly) : poly;
    const [rp1, , rp3] = _remapPoly(finalPoly, pasteX, pasteY, xmin, ymin);

    results.push({
      ori_bbox: boxOcrRes,
      bbox: [
        Math.round(rp1[0] / scale),
        Math.round(rp1[1] / scale),
        Math.round(rp3[0] / scale),
        Math.round(rp3[1] / scale),
      ],
      score: 1,
      content: '',
      type: 'text',
    });
  }

  return results;
}
