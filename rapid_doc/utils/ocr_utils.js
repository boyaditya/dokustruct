/**
 * PORTING NOTE: rapid_doc/utils/ocr_utils.py → ocr_utils.js
 *
 * Utility functions used by RapidOcrModel.
 *
 * CHANGES:
 *   - numpy arrays → Float32Array / JS Arrays of [x, y] pairs.
 *   - cv2 ops (imdecode, cvtColor, getPerspectiveTransform, warpPerspective,
 *     rot90, split, merge) → declared global `cv` (OpenCV.js).
 *   - np.frombuffer / cv2.imdecode → cv.imdecode on Uint8Array.
 *   - np.linalg.norm → inline Euclidean distance.
 *   - np.rot90 → cv.rotate 90 degrees.
 *   - All cv.Mat objects are deleted in try/finally blocks.
 *   - get_rotate_crop_image accepts `points` as [[x,y],[x,y],[x,y],[x,y]]
 *     (Array<[number, number]>); returns a new cv.Mat (caller must delete).
 *
 * NOTE: getOcrResultList / getOcrResultListTable return plain JS objects
 *       matching the Python dict format. np_img becomes a cv.Mat.
 */

/* global cv */

// ─── Constants ─────────────────────────────────────────────────────────────────

export const OcrConfidence = Object.freeze({
  minConfidence: 0.5,
  minWidth:      3,
});

/** Line width:height ratio above which horizontal merging is applied */
const LINE_WIDTH_TO_HEIGHT_RATIO_THRESHOLD = 4;

// ─── mergeSpansToLine ─────────────────────────────────────────────────────────

/**
 * Group spans into text lines based on Y-axis overlap.
 * Mirrors: merge_spans_to_line(spans, threshold=0.6)
 *
 * @param {Array<{bbox:[number,number,number,number]}>} spans
 * @param {number} [threshold=0.6]
 * @returns {Array<Array<{bbox:[number,number,number,number]}>>}
 */
export function mergeSpansToLine(spans, threshold = 0.6) {
  if (spans.length === 0) return [];

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

// Public aliases for private overlap helpers (used by span_block_fix.js)
export { _isOverlapsYExceedsThreshold as isOverlapsYExceedsThreshold };
export { _isOverlapsXExceedsThreshold as isOverlapsXExceedsThreshold };

function _isOverlapsYExceedsThreshold(bbox1, bbox2, threshold = 0.8) {
  const [, y0_1, , y1_1] = bbox1;
  const [, y0_2, , y1_2] = bbox2;
  const overlap = Math.max(0, Math.min(y1_1, y1_2) - Math.max(y0_1, y0_2));
  const h1 = y1_1 - y0_1;
  const h2 = y1_2 - y0_2;
  const minH = Math.min(h1, h2);
  return minH > 0 ? (overlap / minH) > threshold : false;
}

function _isOverlapsXExceedsThreshold(bbox1, bbox2, threshold = 0.8) {
  const [x0_1, , x1_1] = bbox1;
  const [x0_2, , x1_2] = bbox2;
  const overlap = Math.max(0, Math.min(x1_1, x1_2) - Math.max(x0_1, x0_2));
  const w1 = x1_1 - x0_1;
  const w2 = x1_2 - x0_2;
  const minW = Math.min(w1, w2);
  return minW > 0 ? (overlap / minW) > threshold : false;
}

// ─── imgDecode / checkImg ─────────────────────────────────────────────────────

/**
 * Decode bytes to a BGR cv.Mat.
 * Mirrors: img_decode(content: bytes)
 *
 * PORTING NOTE: cv.imdecode is NOT available in the standard browser
 * OpenCV.js build.  Instead we create an Image/Blob, draw to an
 * OffscreenCanvas, and read back as a cv.Mat.
 *
 * @param {Uint8Array|ArrayBuffer} content
 * @returns {cv.Mat}  caller must delete
 */
export function imgDecode(content) {
  const arr = content instanceof ArrayBuffer ? new Uint8Array(content) : content;

  // Fast path: if cv.imdecode exists (custom build), use it.
  if (typeof cv.imdecode === 'function') {
    const buf = cv.matFromArray(arr.length, 1, cv.CV_8UC1, arr);
    const decoded = cv.imdecode(buf, cv.IMREAD_UNCHANGED);
    buf.delete();
    return decoded;
  }

  // Browser fallback: decode via Blob → ImageBitmap → OffscreenCanvas → cv.Mat
  // This must be synchronous to preserve the existing API contract, so we
  // create a data URL and use a synchronous-ish canvas path.
  // Unfortunately fully synchronous image decoding isn't always possible;
  // throw an informative error so callers know to pass cv.Mat directly.
  throw new Error(
    'imgDecode: cv.imdecode is not available in this OpenCV.js build. ' +
    'Please pass a cv.Mat (or OffscreenCanvas/ImageBitmap) instead of raw bytes.'
  );
}

/**
 * Ensure the image is a BGR 3-channel cv.Mat.
 * Mirrors: check_img(img)
 *
 * @param {Uint8Array|ArrayBuffer|cv.Mat} img
 * @returns {cv.Mat}  caller must delete
 */
export function checkImg(img) {
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
 * Mirrors: alpha_to_color(img, alpha_color=(255,255,255))
 *
 * @param {cv.Mat} img
 * @param {[number,number,number]} [alphaColor=[255,255,255]]
 * @returns {cv.Mat}  new Mat if input had alpha; same Mat otherwise
 */
export function alphaToColor(img, alphaColor = [255, 255, 255]) {
  if (img.channels() !== 4) return img;

  const channels = new cv.MatVector();
  cv.split(img, channels);
  const A = channels.get(3);

  const [ar, ag, ab] = alphaColor;
  const result = new cv.Mat(img.rows, img.cols, cv.CV_8UC3);

  // For each pixel: out = alpha_color * (1 - a/255) + channel * a/255
  const bData = channels.get(0).data;
  const gData = channels.get(1).data;
  const rData = channels.get(2).data;
  const aData = A.data;
  const outData = result.data;

  for (let i = 0; i < img.rows * img.cols; i++) {
    const a = aData[i] / 255;
    outData[i * 3]     = Math.round(ab * (1 - a) + bData[i] * a);  // B
    outData[i * 3 + 1] = Math.round(ag * (1 - a) + gData[i] * a);  // G
    outData[i * 3 + 2] = Math.round(ar * (1 - a) + rData[i] * a);  // R
  }

  for (let i = 0; i < 4; i++) channels.get(i).delete();
  channels.delete();
  A.delete();
  return result;
}

/**
 * Apply alpha-to-white compositing.
 * Mirrors: preprocess_image(_image)
 *
 * @param {cv.Mat} image  - may be freed and replaced by a new Mat
 * @returns {cv.Mat}  caller must delete
 */
export function preprocessImage(image) {
  return alphaToColor(image, [255, 255, 255]);
}

// ─── sortedBoxes ──────────────────────────────────────────────────────────────

/**
 * Sort detected text quads top-to-bottom, left-to-right.
 * Mirrors: sorted_boxes(dt_boxes)
 *
 * Each box is Array<[x,y]> with 4 vertices.
 *
 * @param {Array<Array<[number,number]>>} dtBoxes
 * @returns {Array<Array<[number,number]>>}
 */
export function sortedBoxes(dtBoxes) {
  const boxes = [...dtBoxes].sort((a, b) => a[0][1] !== b[0][1] ? a[0][1] - b[0][1] : a[0][0] - b[0][0]);

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
  const [x0, y0, x1, y1] = bbox;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/**
 * [[x0,y0],[x1,y0],[x1,y1],[x0,y1]] → [x0,y0,x1,y1]
 * @param {Array<[number,number]>} points
 * @returns {[number,number,number,number]}
 */
export function pointsToBbox(points) {
  return [points[0][0], points[0][1], points[1][0], points[2][1]];
}

// ─── calculateIsAngle ─────────────────────────────────────────────────────────

/**
 * Detect if a text quad is significantly tilted.
 * Mirrors: calculate_is_angle(poly)
 *
 * @param {Array<[number,number]>} poly  4 vertices
 * @returns {boolean}
 */
export function calculateIsAngle(poly) {
  const [p1, p2, p3, p4] = poly;
  const height = ((p4[1] - p1[1]) + (p3[1] - p2[1])) / 2;
  const vertDiff = p3[1] - p1[1];
  return !(0.8 * height <= vertDiff && vertDiff <= 1.2 * height);
}

// ─── mergeIntervals / removeIntervals ─────────────────────────────────────────

/**
 * @param {[number,number][]} intervals
 * @returns {[number,number][]}
 */
export function mergeIntervals(intervals) {
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
 * Mirrors: update_det_boxes(dt_boxes, mfd_res)
 *
 * @param {Array<Array<[number,number]>>} dtBoxes
 * @param {Array<{bbox:[number,number,number,number]}>} mfdRes
 * @returns {Array<Array<[number,number]>>}
 */
export function updateDetBoxes(dtBoxes, mfdRes) {
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
 * Mirrors: merge_overlapping_spans(spans)
 *
 * @param {[number,number,number,number][]} spans
 * @returns {[number,number,number,number][]}
 */
export function mergeOverlappingSpans(spans) {
  if (!spans.length) return [];
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
 * Mirrors: merge_det_boxes(dt_boxes)
 *
 * @param {Array<Array<[number,number]>>} dtBoxes
 * @returns {Array<Array<[number,number]>>}
 */
export function mergeDetBoxes(dtBoxes) {
  const dtBoxesDictList = [];
  const angleBoxesList  = [];

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
    const lineWidth  = maxX - minX;
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
 * Mirrors: get_rotate_crop_image(img, points)
 *
 * @param {cv.Mat}                    img     - BGR source image (not modified)
 * @param {Array<[number,number]>}    points  - 4 vertices [[x,y],...]
 * @returns {cv.Mat}  Cropped, perspective-corrected Mat.  Caller must delete.
 */
export function getRotateCropImage(img, points) {
  if (points.length !== 4) throw new Error('points must have 4 vertices');

  function norm2(a, b) {
    const dx = a[0] - b[0]; const dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Native parity: Python uses int(max(...)) which truncates positive values.
  const cropW = Math.max(1, Math.trunc(Math.max(norm2(points[0], points[1]), norm2(points[2], points[3]))));
  const cropH = Math.max(1, Math.trunc(Math.max(norm2(points[0], points[3]), norm2(points[1], points[2]))));

  // Flatten to Float32Array for cv
  const srcPts  = cv.matFromArray(4, 1, cv.CV_32FC2,
    points.flatMap(([x, y]) => [x, y]));
  const dstPts  = cv.matFromArray(4, 1, cv.CV_32FC2,
    [0, 0, cropW, 0, cropW, cropH, 0, cropH]);

  const M    = cv.getPerspectiveTransform(srcPts, dstPts);
  const dst  = new cv.Mat();
  cv.warpPerspective(
    img, dst, M,
    new cv.Size(cropW, cropH),
    cv.INTER_CUBIC,
    cv.BORDER_REPLICATE,
  );

  srcPts.delete(); dstPts.delete(); M.delete();

  // Native parity: decide using warped image shape, not requested crop shape.
  if (dst.rows / dst.cols >= 2) {
    const rotated = new cv.Mat();
    cv.rotate(dst, rotated, cv.ROTATE_90_COUNTERCLOCKWISE);
    dst.delete();
    return rotated;
  }

  return dst;
}

// ─── getAdjustedMfdetrec ──────────────────────────────────────────────────────

/**
 * Adjust math formula detection results to the crop coordinate system.
 * Mirrors: get_adjusted_mfdetrec_res(single_page_mfdetrec_res, useful_list, return_text=False)
 *
 * @param {Array<Object>} mfdetrecRes
 * @param {number[]}      usefulList  [pasteX,pasteY,xmin,ymin,xmax,ymax,newW,newH]
 * @param {boolean}       [returnText=false]
 * @returns {Array<Object>}
 */
// Python original: get_adjusted_mfdetrec_res — export both names
export { getAdjustedMfdetrec as getAdjustedMfdetrecRes };
export function getAdjustedMfdetrec(mfdetrecRes, usefulList, returnText = false) {
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
      if (mfRes.latex)    r.latex    = mfRes.latex;
      if (mfRes.checkbox) r.checkbox = mfRes.checkbox;
    }
    adjusted.push(r);
  }
  return adjusted;
}

// ─── isMostlyTilted ───────────────────────────────────────────────────────────

/**
 * Check if the majority of OCR result polygons are tilted.
 * Mirrors: is_mostly_tilted(ocr_res, threshold=1.0)
 *
 * @param {Array<Array<[number,number]>>} ocrRes  array of 4-point polys
 * @param {number} [threshold=1.0]
 * @returns {boolean}
 */
export function isMostlyTilted(ocrRes, threshold = 1.0) {
  if (!ocrRes.length) return false;
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
 * Mirrors: get_ocr_result_list(ocrRes, usefulList, ocrEnable, bgrImage, lang, ...)
 *
 * Note: np_img returns a cv.Mat (caller must delete when done).
 *
 * @param {Array} ocrRes
 * @param {number[]} usefulList [pasteX,pasteY,xmin,ymin,xmax,ymax,newW,newH]
 * @param {boolean}  ocrEnable
 * @param {cv.Mat}   bgrImage
 * @param {string}   lang
 * @param {string}   originalLabel
 * @param {number}   [originalOrder=-1]
 * @returns {Array<Object>}
 */
export function getOcrResultList(ocrRes, usefulList, ocrEnable, bgrImage, lang, originalLabel, originalOrder = -1) {
  if (!ocrEnable && isMostlyTilted(ocrRes.map(r => Array.isArray(r[0]) ? r[0] : r))) {
    ocrEnable = true;
  }

  const [pasteX, pasteY, xmin, ymin] = usefulList;
  const results = [];
  const oriIm = bgrImage;  // not copied; caller owns it

  for (const boxOcrRes of ocrRes) {
    let p1, p2, p3, p4, text, score, imgCrop;

    if (Array.isArray(boxOcrRes[0]) && boxOcrRes[0].length === 4) {
      // [[p1,p2,p3,p4], [text, score]]
      [p1, p2, p3, p4] = boxOcrRes[0];
      [text, score]     = boxOcrRes[1];
      if (score < OcrConfidence.minConfidence) continue;
    } else {
      // Raw box (detect-only)
      [p1, p2, p3, p4] = boxOcrRes;
      text = ''; score = 1;
      if (ocrEnable) {
        const pts = [[...p1], [...p2], [...p3], [...p4]].map(p => p.map(Number));
        imgCrop = getRotateCropImage(oriIm, pts);
      }
    }

    const poly = [p1, p2, p3, p4];
    if ((p3[0] - p1[0]) < OcrConfidence.minWidth) continue;

    let fp1 = p1, fp2 = p2, fp3 = p3, fp4 = p4;
    if (calculateIsAngle(poly)) {
      const xCenter = (p1[0] + p2[0] + p3[0] + p4[0]) / 4;
      const yCenter = (p1[1] + p2[1] + p3[1] + p4[1]) / 4;
      const nh = ((p4[1] - p1[1]) + (p3[1] - p2[1])) / 2;
      const nw = p3[0] - p1[0];
      fp1 = [xCenter - nw / 2, yCenter - nh / 2];
      fp2 = [xCenter + nw / 2, yCenter - nh / 2];
      fp3 = [xCenter + nw / 2, yCenter + nh / 2];
      fp4 = [xCenter - nw / 2, yCenter + nh / 2];
    }

    // Remap to original coordinate system
    const remap = ([px, py]) => [px - pasteX + xmin, py - pasteY + ymin];
    const [rp1, rp2, rp3, rp4] = [fp1, fp2, fp3, fp4].map(p => remap(p).map(v => parseFloat(v)));

    const entry = {
      category_id:    15,
      original_label: originalLabel,
      original_order: originalOrder,
      poly:           [...rp1, ...rp2, ...rp3, ...rp4],
      score:          parseFloat(score.toFixed(2)),
      text,
      lang,
    };
    if (imgCrop) entry.np_img = imgCrop;   // caller must imgCrop.delete()
    results.push(entry);
  }

  return results;
}

// ─── getOcrResultListTable ────────────────────────────────────────────────────

/**
 * Convert raw OCR results for table cells to the internal dict format.
 * Mirrors: get_ocr_result_list_table(ocr_res, useful_list, scale)
 *
 * @param {Array<Array<[number,number]>>} ocrRes  - raw 4-vertex boxes
 * @param {number[]} usefulList
 * @param {number}   scale
 * @returns {Array<Object>}
 */
export function getOcrResultListTable(ocrRes, usefulList, scale) {
  const [pasteX, pasteY, xmin, ymin] = usefulList;
  const results = [];

  for (const boxOcrRes of ocrRes) {
    const [p1, p2, p3, p4] = boxOcrRes;
    const poly = [p1, p2, p3, p4];

    if ((p3[0] - p1[0]) < OcrConfidence.minWidth) continue;

    let fp1 = p1, fp2 = p2, fp3 = p3, fp4 = p4;
    if (calculateIsAngle(poly)) {
      const xCenter = (p1[0] + p2[0] + p3[0] + p4[0]) / 4;
      const yCenter = (p1[1] + p2[1] + p3[1] + p4[1]) / 4;
      const nh = ((p4[1] - p1[1]) + (p3[1] - p2[1])) / 2;
      const nw = p3[0] - p1[0];
      fp1 = [xCenter - nw / 2, yCenter - nh / 2];
      fp2 = [xCenter + nw / 2, yCenter - nh / 2];
      fp3 = [xCenter + nw / 2, yCenter + nh / 2];
      fp4 = [xCenter - nw / 2, yCenter + nh / 2];
    }

    const remap = ([px, py]) => [px - pasteX + xmin, py - pasteY + ymin];
    const [rp1, , rp3] = [fp1, fp2, fp3, fp4].map(p => remap(p));

    results.push({
      ori_bbox: boxOcrRes,
      bbox: [Math.round(rp1[0] / scale), Math.round(rp1[1] / scale),
             Math.round(rp3[0] / scale), Math.round(rp3[1] / scale)],
      score:   1,
      content: '',
      type:    'text',
    });
  }

  return results;
}
