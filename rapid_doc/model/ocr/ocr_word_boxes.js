/**
 * Word-level bounding box calculation from OCR recognition results.
 *
 * Maps character positions from the recognition crop coordinate space
 * back to the original image coordinate space using inverse perspective transform.
 */

/* global cv */
import { deleteMat } from '../../utils/resource_utils.js';
import { AbortException } from '../../utils/exceptions.js';
import { formatPipelineError } from '../../utils/browser_utils.js';

/**
 * Calculate word-level bounding boxes from recognition results.
 * @param {cv.Mat[]} crops - Recognition image crops
 * @param {Array} dtBoxes - Detection boxes (4-point polygons)
 * @param {object} recRes - Recognition results with wordResults
 * @returns {Array} Word results [[text, score, bbox], ...]
 */
export function calRecBoxes(crops, dtBoxes, recRes) {
  const wordResults = [];

  for (let idx = 0; idx < crops.length; idx++) {
    const img = crops[idx];
    const box = dtBoxes[idx];
    const wordInfo = recRes.wordResults?.[idx];

    if (!wordInfo || !img || img.rows === 0 || img.cols === 0) {
      wordResults.push([]);
      continue;
    }

    try {
      const h = img.rows;
      const w = img.cols;
      const imgBox = [[0, 0], [w, 0], [w, h], [0, h]];

      const wordBoxList = calOcrWordBox(recRes.txts[idx], imgBox, wordInfo);
      const finalWordBoxList = reverseRotateCropImage(box, wordBoxList);

      const wordResult = [];
      for (let i = 0; i < wordInfo.words.length; i++) {
        const text = wordInfo.words[i].join('');
        const score = recRes.scores[idx];
        const bbox = finalWordBoxList[i];
        wordResult.push([text, score, bbox]);
      }
      wordResults.push(wordResult);
    } catch (err) {
      if (err instanceof AbortException) throw err;
      console.warn(formatPipelineError({
        stage: 'ocr', module: 'calRecBoxes', message: `word box calc failed at idx=${idx}: ${err?.message ?? err}`, recoverable: true,
      }));
      wordResults.push([]);
    }
  }

  return wordResults;
}

/**
 * Calculate word bounding boxes within a single crop's coordinate space.
 * @param {string} recTxt - Recognized text
 * @param {Array} bbox - Crop bounding box [[x0,y0], [x1,y1], [x2,y2], [x3,y3]]
 * @param {object} wordInfo - Word grouping info from getWordInfo
 * @returns {Array} List of 4-point word boxes in crop coordinates
 */
function calOcrWordBox(recTxt, bbox, wordInfo) {
  if (!recTxt || wordInfo.lineTxtLen === 0) return [];

  const bboxRect = [
    Math.min(bbox[0][0], bbox[1][0], bbox[2][0], bbox[3][0]),
    Math.min(bbox[0][1], bbox[1][1], bbox[2][1], bbox[3][1]),
    Math.max(bbox[0][0], bbox[1][0], bbox[2][0], bbox[3][0]),
    Math.max(bbox[0][1], bbox[1][1], bbox[2][1], bbox[3][1]),
  ];

  const avgColWidth = (bboxRect[2] - bboxRect[0]) / wordInfo.lineTxtLen;
  const isAllEnNum = wordInfo.wordTypes.every(t => t === 'EN_NUM');

  const lineBoxes = [];
  for (let i = 0; i < wordInfo.words.length; i++) {
    const wordCol = wordInfo.wordCols[i];

    if (isAllEnNum) {
      const wordBoxes = calcCharBoxes(wordCol, avgColWidth, avgColWidth, bboxRect);
      const x0 = Math.min(...wordBoxes.map(b => b[0][0]));
      const y0 = Math.min(...wordBoxes.map(b => b[0][1]));
      const x1 = Math.max(...wordBoxes.map(b => b[1][0]));
      const y1 = Math.max(...wordBoxes.map(b => b[2][1]));
      lineBoxes.push([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    } else {
      const charBoxes = calcCharBoxes(wordCol, avgColWidth, avgColWidth, bboxRect);
      lineBoxes.push(...charBoxes);
    }
  }

  return lineBoxes;
}

/**
 * Calculate individual character bounding boxes from column indices.
 * @param {number[]} lineCols - Column indices for characters
 * @param {number} avgCharWidth - Average character width
 * @param {number} avgColWidth - Average column width
 * @param {number[]} bboxPoints - [x0, y0, x1, y1] bounding rect
 * @returns {Array} Sorted list of 4-point character boxes
 */
function calcCharBoxes(lineCols, avgCharWidth, avgColWidth, bboxPoints) {
  const [x0, y0, x1, y1] = bboxPoints;
  const results = [];

  for (const colIdx of lineCols) {
    const centerX = (colIdx + 0.5) * avgColWidth;
    const charX0 = Math.max(Math.floor(centerX - avgCharWidth / 2), 0) + x0;
    const charX1 = Math.min(Math.floor(centerX + avgCharWidth / 2), x1 - x0) + x0;
    results.push([
      [charX0, y0],
      [charX1, y0],
      [charX1, y1],
      [charX0, y1],
    ]);
  }

  return results.sort((a, b) => a[0][0] - b[0][0]);
}

/**
 * Inverse perspective transform: map word boxes from crop coords to original image coords.
 * @param {Array} bboxPoints - Detection box (4-point polygon or flat array)
 * @param {Array} wordPointsList - List of word boxes in crop coordinates
 * @returns {Array} Word boxes in original image coordinates
 */
function reverseRotateCropImage(bboxPoints, wordPointsList) {
  const bbox = normalizeBboxPoints(bboxPoints);

  const left = Math.min(...bbox.map(p => p[0]));
  const top = Math.min(...bbox.map(p => p[1]));

  const bboxShifted = bbox.map(([x, y]) => [x - left, y - top]);

  const dx01 = bboxShifted[1][0] - bboxShifted[0][0];
  const dy01 = bboxShifted[1][1] - bboxShifted[0][1];
  const dx03 = bboxShifted[3][0] - bboxShifted[0][0];
  const dy03 = bboxShifted[3][1] - bboxShifted[0][1];

  const imgCropWidth = Math.round(Math.sqrt(dx01 * dx01 + dy01 * dy01));
  const imgCropHeight = Math.round(Math.sqrt(dx03 * dx03 + dy03 * dy03));

  const ptsStd = [
    [0, 0],
    [imgCropWidth, 0],
    [imgCropWidth, imgCropHeight],
    [0, imgCropHeight],
  ];

  if (typeof cv === 'undefined' || !cv.getPerspectiveTransform) {
    return applySimpleTranslation(wordPointsList, left, top);
  }

  return applyInversePerspective(bboxShifted, ptsStd, wordPointsList, left, top);
}

/**
 * Normalize bbox points to [[x,y], ...] format from either nested or flat array.
 * @private
 */
function normalizeBboxPoints(bboxPoints) {
  if (Array.isArray(bboxPoints[0])) return bboxPoints;
  return [
    [bboxPoints[0], bboxPoints[1]],
    [bboxPoints[2], bboxPoints[3]],
    [bboxPoints[4], bboxPoints[5]],
    [bboxPoints[6], bboxPoints[7]],
  ];
}

/**
 * Fallback: simple translation without rotation/skew correction.
 * @private
 */
function applySimpleTranslation(wordPointsList, left, top) {
  return wordPointsList.map(wordPoints =>
    wordPoints.map(([x, y]) => [Math.round(x + left), Math.round(y + top)])
  );
}

/**
 * Full inverse perspective transform using OpenCV.
 * @private
 */
function applyInversePerspective(bboxShifted, ptsStd, wordPointsList, left, top) {
  let M = null;
  let IM = null;
  let srcMat = null;
  let dstMat = null;

  try {
    srcMat = cv.matFromArray(4, 1, cv.CV_32FC2, bboxShifted.flat());
    dstMat = cv.matFromArray(4, 1, cv.CV_32FC2, ptsStd.flat());
    M = cv.getPerspectiveTransform(srcMat, dstMat);
    IM = new cv.Mat();
    cv.invert(M, IM, cv.DECOMP_LU);

    const newWordPointsList = [];
    for (const wordPoints of wordPointsList) {
      const newWordPoints = [];
      const m = IM.data64F;
      for (let [x, y] of wordPoints) {
        const px = m[0] * x + m[1] * y + m[2];
        const py = m[3] * x + m[4] * y + m[5];
        const pz = m[6] * x + m[7] * y + m[8];
        newWordPoints.push([Math.round(px / pz + left), Math.round(py / pz + top)]);
      }
      newWordPointsList.push(newWordPoints);
    }
    return newWordPointsList;
  } finally {
    deleteMat(srcMat);
    deleteMat(dstMat);
    deleteMat(M);
    deleteMat(IM);
  }
}
