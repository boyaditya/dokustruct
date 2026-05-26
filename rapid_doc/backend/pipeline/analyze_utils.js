// Copyright (c) RapidAI. All rights reserved.

import { AtomModelSingleton } from "./model_init.js";
import { AtomicModel } from "./model_list.js";
import { normalizeToIntBbox } from "../../utils/bbox_utils.js";
import { CategoryId } from "../../utils/enum_class.js";
import { cropImg } from "../../utils/model_utils.js";
import {
  mergeDetBoxes, updateDetBoxes, sortedBoxes, getRotateCropImage,
  getAdjustedMfdetrecRes, getOcrResultList, OcrConfidence, getOcrResultListTable,
} from "../../utils/ocr_utils.js";
import {
  txtSpansBboxExtract, txtMostAngleExtractTable, extractTableFillImage,
  txtSpansExtract,
} from "../../utils/span_pre_proc.js";
import { rotateImage } from "../../utils/boxbase.js";
import { deleteMat, deleteMatList, clearLayoutImageList } from "../../utils/resource_utils.js";
import { yieldToBrowser, formatPipelineError } from "../../utils/browser_utils.js";
import { AbortException } from "../../utils/exceptions.js";

const RESOLUTION_GROUP_STRIDE = 64;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Combines formula and checkbox results into a single array for mask adjustment.
 */
function combineMfdetrecAndCheckbox(ocrResDict) {
  const mfdetrec = Array.isArray(ocrResDict.single_page_mfdetrec_res)
    ? ocrResDict.single_page_mfdetrec_res : [];
  const checkbox = Array.isArray(ocrResDict.checkbox_res)
    ? ocrResDict.checkbox_res : [];
  return [...mfdetrec, ...checkbox];
}

/**
 * Pad a cv.Mat to targetH × targetW with white (255).
 * Returns the padded Mat (caller must delete) or the original if padding fails.
 */
function padImageTo(img, targetH, targetW) {
  if (typeof cv !== 'undefined' && img instanceof cv.Mat) {
    let padded = new cv.Mat();
    try {
      cv.copyMakeBorder(
        img, padded,
        0, targetH - img.rows,
        0, targetW - img.cols,
        cv.BORDER_CONSTANT,
        new cv.Scalar(255, 255, 255, 255)
      );
      return padded;
    } catch {
      padded.delete();
      return img;
    }
  }
  return img;
}


// ---------------------------------------------------------------------------
// Mask application
// ---------------------------------------------------------------------------

/**
 * Mask regions (e.g., formulas) by filling with white (255).
 * Prevents OCR from detecting text inside masked regions.
 *
 * @param {cv.Mat} bgrMat - Input BGR image
 * @param {object[]|null} maskBoxes - List of boxes to mask (with bbox property)
 * @returns {cv.Mat} Masked image (new Mat if masks applied, original if no masks)
 */
export function applyMaskBoxesToImage(bgrMat, maskBoxes) {
  if (!maskBoxes || maskBoxes.length === 0) {
    return bgrMat;
  }

  const maskedMat = bgrMat.clone();
  const imageH = maskedMat.rows;
  const imageW = maskedMat.cols;

  for (const maskBox of maskBoxes) {
    const bbox = maskBox.bbox;
    if (!bbox) continue;

    const intBbox = normalizeToIntBbox(bbox, [imageH, imageW]);
    if (!intBbox) continue;

    const [x0, y0, x1, y1] = intBbox;
    const width = x1 - x0;
    const height = y1 - y0;
    if (width <= 0 || height <= 0) continue;

    try {
      const roi = maskedMat.roi(new cv.Rect(x0, y0, width, height));
      roi.setTo(new cv.Scalar(255, 255, 255, 255));
      roi.delete();
    } catch (err) {
      if (err instanceof AbortException) throw err;
      console.warn(formatPipelineError({
        stage: 'ocr', module: 'applyMaskBoxesToImage',
        message: `Failed to mask region [${x0},${y0},${x1},${y1}]: ${err.message}`,
        recoverable: true,
      }));
    }
  }

  return maskedMat;
}


// ---------------------------------------------------------------------------
// OCR-det: PDF text extraction
// ---------------------------------------------------------------------------

/**
 * Extract text from PDF for OCR results where ocr_enable is false.
 * @param {object[]} ocrResAllPage
 * @param {object[]} pdfDictList
 * @param {number[]} scaleList
 */
export async function extractTextFromPdf(ocrResAllPage, pdfDictList, scaleList) {
  const ocrResGrouped = {};
  for (const x of ocrResAllPage) {
    (ocrResGrouped[x.page_idx] = ocrResGrouped[x.page_idx] || []).push(x);
  }

  for (const [pageIdxStr, textList] of Object.entries(ocrResGrouped)) {
    const pageIdx = Number(pageIdxStr);
    const pageDict = textList.length ? (pdfDictList[pageIdx] || {}) : {};
    const scale = textList.length ? (scaleList[pageIdx] || 1.0) : 1.0;

    for (const ocrResDict of textList) {
      if (ocrResDict.ocr_enable) continue;

      const rotateLabel = pageDict?.rotate_label;
      if (rotateLabel === "90" || rotateLabel === "180" || rotateLabel === "270") {
        ocrResDict.ocr_enable = true;
        continue;
      }

      for (const res of ocrResDict.ocr_res_list) {
        const { newImage, usefulList } = cropImg(res, ocrResDict.np_img, 50, 50);
        try {
          const adjustedMfdetrecRes = getAdjustedMfdetrecRes(
            combineMfdetrecAndCheckbox(ocrResDict), usefulList
          );

          const ocrRes = txtSpansBboxExtract(
            pageDict, res, adjustedMfdetrecRes, scale, usefulList
          );

          if (ocrRes) {
            const ocrResultList = getOcrResultList(
              ocrRes, usefulList, ocrResDict.ocr_enable,
              newImage, ocrResDict.lang,
              res.original_label, res.original_order
            );
            ocrResDict.layout_res.push(...ocrResultList);
          }
        } catch (err) {
          if (err instanceof AbortException) throw err;
          console.warn(formatPipelineError({
            stage: 'ocr', module: 'extractTextFromPdf',
            message: `PDF text extraction failed for page ${pageIdx}: ${err.message}`,
            pageIndex: pageIdx, recoverable: true,
          }));
        } finally {
          deleteMat(newImage);
        }
      }
      await yieldToBrowser();
    }
  }
}


// ---------------------------------------------------------------------------
// OCR-det: Batch detection
// ---------------------------------------------------------------------------

/**
 * Collect cropped image info for all pages that need OCR detection.
 */
function collectOcrDetCrops(ocrResAllPage, ocrConfig) {
  const useDetMode = (ocrConfig || {}).use_det_mode || "auto";
  const allCroppedInfo = [];

  for (const ocrResDict of ocrResAllPage) {
    for (const res of ocrResDict.ocr_res_list) {
      let ocrEnable = ocrResDict.ocr_enable;

      if (!ocrResDict.ocr_enable) {
        if (res.need_ocr_det) {
          ocrEnable = true;
        } else if (useDetMode === 'txt' || (useDetMode !== 'ocr' && !res.need_ocr_det)) {
          continue;
        }
      }

      delete res.need_ocr_det;

      const { newImage: bgrImage, usefulList } = cropImg(res, ocrResDict.np_img, 50, 50);
      const adjustedMfdetrecRes = getAdjustedMfdetrecRes(
        combineMfdetrecAndCheckbox(ocrResDict), usefulList
      );

      const detImage = applyMaskBoxesToImage(bgrImage, adjustedMfdetrecRes);

      allCroppedInfo.push([
        bgrImage, detImage, usefulList, ocrResDict,
        adjustedMfdetrecRes, ocrResDict.lang, res, ocrEnable,
      ]);
    }
  }

  return allCroppedInfo;
}

/**
 * Group cropped images by resolution (padded to stride multiples).
 */
function groupByResolution(langCropList) {
  const resolutionGroups = {};
  for (const info of langCropList) {
    const croppedImg = info[1];
    const { rows: h, cols: w } = croppedImg;
    const imgH = h || (croppedImg.height || 0);
    const imgW = w || (croppedImg.width || 0);
    const targetH = Math.ceil(imgH / RESOLUTION_GROUP_STRIDE) * RESOLUTION_GROUP_STRIDE;
    const targetW = Math.ceil(imgW / RESOLUTION_GROUP_STRIDE) * RESOLUTION_GROUP_STRIDE;
    const key = `${targetH},${targetW}`;
    (resolutionGroups[key] = resolutionGroups[key] || []).push(info);
  }
  return resolutionGroups;
}

/**
 * Process detection results for a single resolution group.
 */
function processDetGroupResults(groupCrops, batchResults) {
  for (let i = 0; i < groupCrops.length; i++) {
    const info = groupCrops[i];
    const [bgrImage, detImage, usefulList, ocrResDict, adjustedMfdetrecRes, lang, res, ocrEnable] = info;
    const { boxes: dtBoxes } = batchResults[i];

    if (dtBoxes && dtBoxes.length > 0) {
      const dtBoxesSorted = sortedBoxes(dtBoxes);
      const dtBoxesMerged = dtBoxesSorted.length ? mergeDetBoxes(dtBoxesSorted) : [];
      const dtBoxesFinal = (dtBoxesMerged.length && adjustedMfdetrecRes?.length)
        ? updateDetBoxes(dtBoxesMerged, adjustedMfdetrecRes)
        : dtBoxesMerged;

      if (dtBoxesFinal.length) {
        const ocrRes = dtBoxesFinal.map(box => Array.isArray(box.tolist?.()) ? box.tolist() : box);
        const ocrResultList = getOcrResultList(
          ocrRes, usefulList, ocrEnable, bgrImage, lang,
          res.original_label, res.original_order
        );
        ocrResDict.layout_res.push(...ocrResultList);
      }
    }

    if (detImage !== bgrImage) deleteMat(detImage);
    deleteMat(bgrImage);
  }
}

/**
 * Batch OCR detection across pages.
 * @param {object[]} ocrResAllPage
 * @param {AtomModelSingleton} atomModelManager
 * @param {object} ocrConfig
 */
export async function runOcrDetBatch(ocrResAllPage, atomModelManager, ocrConfig) {
  const ocrDetBaseBatchSize = (ocrConfig || {})["Det.rec_batch_num"] || 1;
  const allCroppedInfo = collectOcrDetCrops(ocrResAllPage, ocrConfig);

  if (!allCroppedInfo.length) return;

  // Group by language
  const langGroups = {};
  for (const info of allCroppedInfo) {
    const lang = info[5];
    (langGroups[lang] = langGroups[lang] || []).push(info);
  }

  for (const [lang, langCropList] of Object.entries(langGroups)) {
    if (!langCropList.length) continue;

    const ocrModel = await atomModelManager.getAtomModel(AtomicModel.OCR, {
      det_db_thresh: ocrConfig?.["Det.det_db_thresh"] ?? ocrConfig?.det_db_thresh ?? 0.3,
      det_db_box_thresh: 0.3,
      lang,
      ocr_config: ocrConfig,
    });

    const resolutionGroups = groupByResolution(langCropList);

    for (const [key, groupCrops] of Object.entries(resolutionGroups)) {
      const [targetH, targetW] = key.split(',').map(Number);

      const batchImages = groupCrops.map(info => padImageTo(info[1], targetH, targetW));
      const detBatchSize = Math.min(batchImages.length, ocrDetBaseBatchSize);

      try {
        const batchResults = await ocrModel.detBatchPredict(batchImages, detBatchSize);
        processDetGroupResults(groupCrops, batchResults);
      } catch (err) {
        if (err instanceof AbortException) throw err;
        console.warn(formatPipelineError({
          stage: 'ocr', module: 'runOcrDetBatch',
          message: `Batch detection failed for resolution ${key}: ${err.message}`,
          recoverable: true,
        }));
        // Cleanup bgrImage/detImage on error
        for (const info of groupCrops) {
          const [bgrImage, detImage] = info;
          if (detImage !== bgrImage) deleteMat(detImage);
          deleteMat(bgrImage);
        }
      } finally {
        deleteMatList(batchImages.filter(
          p => p && typeof cv !== 'undefined' && p instanceof cv.Mat
        ));
      }
      await yieldToBrowser();
    }
  }
}


// ---------------------------------------------------------------------------
// OCR-rec: Recognition post-processing
// ---------------------------------------------------------------------------

/**
 * Apply special text filtering rules for low-confidence OCR results.
 */
function applyOcrScoreFiltering(item, ocrText, ocrScore) {
  item.text = ocrText;
  item.score = parseFloat(Number(ocrScore || 0).toFixed(3));

  if (Number(ocrScore || 0) < OcrConfidence.min_confidence) {
    item.category_id = CategoryId.LowScoreText;
    return;
  }

  const bbox = [item.poly[0], item.poly[1], item.poly[4], item.poly[5]];
  const width = bbox[2] - bbox[0];
  const height = bbox[3] - bbox[1];
  const specialTexts = ['（204号', '（20', '（2', '（2号', '（20号', '号', '（204'];
  if (specialTexts.includes(ocrText) && ocrScore < 0.8 && width < height) {
    item.category_id = CategoryId.LowScoreText;
  }
}

/**
 * Post-process OCR recognition for spans that contain np_img.
 * @param {object[][]} imagesLayoutRes
 * @param {object} ocrConfig
 */
export async function runOcrRecPostprocess(imagesLayoutRes, ocrConfig) {
  const atomModelManager = AtomModelSingleton.getInstance();

  const needOcrByLang = {};
  const imgCropByLang = {};

  for (const layoutRes of imagesLayoutRes) {
    for (const item of layoutRes) {
      if (item.category_id !== CategoryId.OcrText) continue;
      if (item.np_img === undefined || item.lang === undefined) continue;

      const lang = item.lang;
      if (!needOcrByLang[lang]) {
        needOcrByLang[lang] = [];
        imgCropByLang[lang] = [];
      }
      needOcrByLang[lang].push(item);
      imgCropByLang[lang].push(item.np_img);
      delete item.np_img;
      delete item.lang;
    }
  }

  if (!Object.keys(imgCropByLang).length) return;

  for (const [lang, imgCropList] of Object.entries(imgCropByLang)) {
    if (!imgCropList.length) continue;

    const ocrModel = await atomModelManager.getAtomModel(AtomicModel.OCR, {
      det_db_box_thresh: 0.3,
      lang,
      ocr_config: ocrConfig,
    });

    try {
      const ocrResListAll = await ocrModel.ocr(imgCropList, { det: false });
      const ocrResList = (Array.isArray(ocrResListAll) && ocrResListAll.length > 0)
        ? ocrResListAll[0] : [];
      const needOcrList = needOcrByLang[lang];

      if (ocrResList.length !== needOcrList.length) {
        console.warn(formatPipelineError({
          stage: 'ocr', module: 'runOcrRecPostprocess',
          message: `Result count mismatch: got ${ocrResList.length}, expected ${needOcrList.length}`,
          recoverable: true,
        }));
      }

      for (let i = 0; i < needOcrList.length; i++) {
        const [ocrText, ocrScore] = ocrResList[i] || ['', 0];
        applyOcrScoreFiltering(needOcrList[i], ocrText, ocrScore);
      }
    } catch (err) {
      if (err instanceof AbortException) throw err;
      console.warn(formatPipelineError({
        stage: 'ocr', module: 'runOcrRecPostprocess',
        message: `OCR recognition failed for lang=${lang}: ${err.message}`,
        recoverable: true,
      }));
    } finally {
      deleteMatList(imgCropList);
    }
    await yieldToBrowser();
  }
}


// ---------------------------------------------------------------------------
// Table processing
// ---------------------------------------------------------------------------

/**
 * Extract table text from PDF page.
 * @returns {any[]} [boxes, texts, scores] or empty array
 */
export async function extractTableTextFromPdf(tableResDict, pageDict, scale, detRes, usefulList, tableUseWordBox) {
  if (!detRes || !detRes.length || !Array.isArray(usefulList)) return [];

  try {
    const ocrSpans = getOcrResultListTable(detRes, usefulList, scale) || [];
    const poly = tableResDict.table_res.poly || [0, 0, 0, 0, 0, 0, 0, 0];
    // FIX N1: use Math.trunc to match Python's int() truncation (not Math.floor)
    const tableBboxes = [[
      Math.trunc(Number(poly[0] || 0) / scale), Math.trunc(Number(poly[1] || 0) / scale),
      Math.trunc(Number(poly[4] || 0) / scale), Math.trunc(Number(poly[5] || 0) / scale),
      null, null, null, 'text', null, null, null, null, 1,
    ]];

    await txtSpansExtract(
      pageDict, ocrSpans, tableResDict.table_img, scale,
      tableBboxes, [], tableUseWordBox, usefulList
    );

    const filtered = [];
    if (tableUseWordBox) {
      for (const item of ocrSpans) {
        const group = item.word_result;
        if (!Array.isArray(group)) continue;
        for (const w of group) {
          if (w && w[2] !== '') filtered.push([w[2], w[0], w[1]]);
        }
      }
    } else {
      for (const item of ocrSpans) {
        if (item.content) filtered.push([item.ori_bbox, item.content, item.score]);
      }
    }

    if (!filtered.length) return [];
    return [filtered.map(r => r[0]), filtered.map(r => r[1]), filtered.map(r => r[2])];
  } catch (err) {
    if (err instanceof AbortException) throw err;
    console.warn(formatPipelineError({
      stage: 'table', module: 'extractTableTextFromPdf',
      message: `PDF table text extraction error: ${err.message}`,
      recoverable: true,
    }));
    return [];
  }
}

/**
 * Run OCR on table image with cropped detection regions.
 * @returns {any[]} [boxes, texts, scores] or empty array
 */
export async function runTableOcr(ocrModel, bgrImage, detRes, tableUseWordBox) {
  if (!Array.isArray(detRes) || detRes.length === 0) return [];

  const recImgList = detRes.map(dtBox => ({
    croppedImg: getRotateCropImage(bgrImage, dtBox),
    dtBox,
  }));

  const croppedImgList = recImgList.map(item => item.croppedImg);
  let ocrResRawResult;
  try {
    ocrResRawResult = await ocrModel.ocr(croppedImgList, {
      det: false,
      returnWordBox: tableUseWordBox,
      oriImg: bgrImage,
      dtBoxes: detRes,
    });
  } catch (err) {
    if (err instanceof AbortException) throw err;
    console.warn(formatPipelineError({
      stage: 'table', module: 'runTableOcr',
      message: `Table OCR recognition failed: ${err.message}`,
      recoverable: true,
    }));
    return [];
  } finally {
    deleteMatList(croppedImgList);
  }

  const ocrResListRaw = (Array.isArray(ocrResRawResult) && ocrResRawResult.length > 0)
    ? (ocrResRawResult[0] || []) : [];

  const ocrResult = [];
  for (let i = 0; i < recImgList.length; i++) {
    const imgDict = recImgList[i];
    const ocrRes = ocrResListRaw[i];
    if (!Array.isArray(ocrRes)) continue;

    if (tableUseWordBox && ocrRes.length >= 3) {
      const wordResults = Array.isArray(ocrRes[2]) ? ocrRes[2] : [];
      for (const wordResult of wordResults) {
        if (wordResult && wordResult.length >= 3) {
          ocrResult.push([wordResult[2], wordResult[0], wordResult[1]]);
        }
      }
    } else {
      ocrResult.push([imgDict.dtBox, ocrRes[0], ocrRes[1]]);
    }
  }

  if (!ocrResult.length) return [];
  return [ocrResult.map(r => r[0]), ocrResult.map(r => r[1]), ocrResult.map(r => r[2])];
}


// ---------------------------------------------------------------------------
// Table: Orientation detection sub-step
// ---------------------------------------------------------------------------

/**
 * Run OCR detection on a table image, optionally masking formula regions.
 * @returns {any[]} Detection results
 */
async function runTableDetection(tableImg, adjustedMfdetrecRes, ocrModel) {
  const detImage = (adjustedMfdetrecRes && adjustedMfdetrecRes.length > 0)
    ? applyMaskBoxesToImage(tableImg, adjustedMfdetrecRes)
    : tableImg;

  try {
    const ocrResRaw = await ocrModel.ocr(detImage, {
      mfdRes: adjustedMfdetrecRes,
      rec: false,
      enableMergeDetBoxes: false,
    });
    return (Array.isArray(ocrResRaw) && ocrResRaw.length > 0) ? (ocrResRaw[0] || []) : [];
  } finally {
    if (detImage !== tableImg) deleteMat(detImage);
  }
}

/**
 * Determine rotation label using PDF angle data and orientation model.
 */
async function determineRotationLabel(
  tableResDict, pageDict, scale, detRes, atomModelManager, orientationConfig
) {
  const pdfNotRotate = !["90", "180", "270"].includes(String(pageDict?.rotate_label ?? "0"));
  let rotateLabel = "0";
  // FIX N4: track whether any PDF text angles were found, to distinguish
  // "text at 0°" (don't use orientation model) from "no text at all" (use it).
  let hasAngles = false;

  if (pdfNotRotate) {
    const { mostAngle, hasAngles: found } = txtMostAngleExtractTable(pageDict, tableResDict, Number(scale));
    hasAngles = found;
    if (mostAngle) {
      rotateLabel = String(mostAngle);
    }
  }

  // FIX N4: only fall through to orientation model when NO text angles exist
  if (!hasAngles) {
    try {
      const imgOrientationClsModel = await atomModelManager.getAtomModel(
        AtomicModel.ImgOrientationCls,
        { orientation_config: orientationConfig }
      );
      rotateLabel = await imgOrientationClsModel.predict(tableResDict.table_img, detRes);
    } catch (err) {
      if (err instanceof AbortException) throw err;
      // Orientation model unavailable — keep rotateLabel = "0"
    }
  }

  return { rotateLabel, pdfNotRotate };
}

/**
 * Detect table orientation and re-run detection if rotated.
 * @returns {{ detRes: any[], rotateLabel: string, pdfNotRotate: boolean }}
 */
async function detectTableOrientation(
  tableResDict, pageDict, scale, adjustedMfdetrecRes, ocrModel, atomModelManager, orientationConfig
) {
  let detRes = await runTableDetection(tableResDict.table_img, adjustedMfdetrecRes, ocrModel);

  const { rotateLabel, pdfNotRotate } = await determineRotationLabel(
    tableResDict, pageDict, scale, detRes, atomModelManager, orientationConfig
  );

  // Re-detect after rotation if needed
  if (rotateLabel === "90" || rotateLabel === "270") {
    rotateImage(tableResDict, rotateLabel);
    detRes = await runTableDetection(tableResDict.table_img, adjustedMfdetrecRes, ocrModel);
  }

  return { detRes, rotateLabel, pdfNotRotate };
}

// ---------------------------------------------------------------------------
// Table: Model recognition sub-step
// ---------------------------------------------------------------------------

/**
 * Run table structure recognition model and assign HTML result.
 */
async function runTableRecognition(
  tableResDict, scale, ocrResult, adjustedMfdetrecRes,
  atomModelManager, tableConfig, ocrConfig, fillImageRes
) {
  const skipTextInImage = tableConfig?.skip_text_in_image ?? true;
  const useImg2table = tableConfig?.use_img2table ?? false;

  const tableModel = await atomModelManager.getAtomModel(AtomicModel.Table, {
    lang: tableResDict.lang,
    ocr_config: ocrConfig,
    table_config: tableConfig,
  });

  if (tableResDict?.table_res) {
    clearLayoutImageList(tableResDict.table_res);
  }

  if (!tableModel || typeof tableModel.predict !== 'function') return;

  const tableResult = await tableModel.predict(
    tableResDict.table_img, ocrResult,
    {
      fillImageRes: Array.isArray(fillImageRes) ? fillImageRes : [],
      mfdRes: Array.isArray(adjustedMfdetrecRes) ? adjustedMfdetrecRes : [],
      skipTextInImage,
      useImg2table,
      useCompareTable: tableConfig?.use_compare_table ?? false,
    }
  );

  const htmlCode = tableResult ? tableResult.html : null;
  assignTableHtml(tableResDict, htmlCode, scale, fillImageRes);
}

/**
 * Assign HTML and metadata to table result if valid.
 */
function assignTableHtml(tableResDict, htmlCode, scale, fillImageRes) {
  if (!htmlCode || typeof htmlCode !== 'string' || !htmlCode.includes('<table>') || !htmlCode.includes('</table>')) {
    console.warn(formatPipelineError({
      stage: 'table', module: 'processSingleTable',
      message: 'Table recognition produced no valid HTML',
      recoverable: true,
    }));
    return;
  }

  const start = htmlCode.indexOf('<table>');
  const end = htmlCode.lastIndexOf('</table>') + '</table>'.length;
  tableResDict.table_res.html = htmlCode.slice(start, end);

  const singlePageMfResArr = Array.isArray(tableResDict.single_page_mfdetrec_res)
    ? tableResDict.single_page_mfdetrec_res : [];
  const checkboxResArr = Array.isArray(tableResDict.checkbox_res)
    ? tableResDict.checkbox_res : [];

  const formulaBoxes = [...singlePageMfResArr, ...checkboxResArr]
    .filter(t => t && t.bbox)
    .map(t => t.bbox);

  if (formulaBoxes.length && tableResDict.table_res) {
    // FIX N10: use Math.trunc to match Python's int() truncation
    tableResDict.table_res.formula_boxes = formulaBoxes.map(
      bbox => Array.isArray(bbox) ? bbox.map(c => Math.trunc(Number(c) / scale)) : []
    );
  }

  const validFillImgResArr = Array.isArray(fillImageRes) ? fillImageRes : [];
  const imgBoxes = validFillImgResArr.filter(t => t && t.bbox).map(t => t.ori_bbox);
  if (imgBoxes?.length && tableResDict.table_res) {
    // FIX N10: use Math.trunc to match Python's int() truncation
    tableResDict.table_res.img_boxes = imgBoxes.map(
      bbox => Array.isArray(bbox) ? bbox.map(c => Math.trunc(Number(c) / scale)) : []
    );
  }
}


// ---------------------------------------------------------------------------
// Table: Config and setup helpers
// ---------------------------------------------------------------------------

/**
 * Prepare table processing configuration from tableConfig.
 */
function getTableProcessingConfig(tableConfig) {
  return {
    tableForceOcr: tableConfig?.force_ocr ?? false,
    tableUseWordBox: tableConfig?.use_word_box ?? false,
    tableFormulaEnable: tableConfig?.table_formula_enable ?? true,
    tableImageEnable: tableConfig?.table_image_enable ?? true,
    tableExtractOriginalImage: tableConfig?.extract_original_image ?? false,
  };
}

/**
 * Prepare OCR model for table usage (without custom_model).
 */
async function prepareTableOcrModel(atomModelManager, ocrConfig, lang) {
  let ocrConfigClean = null;
  if (ocrConfig != null) {
    ocrConfigClean = { ...ocrConfig };
    delete ocrConfigClean.custom_model;
  }

  return atomModelManager.getAtomModel(AtomicModel.OCR, {
    det_db_thresh: ocrConfigClean?.["Det.det_db_thresh"] ?? ocrConfigClean?.det_db_thresh ?? 0.3,
    det_db_box_thresh: 0.5,
    det_db_unclip_ratio: 1.6,
    lang,
    ocr_config: ocrConfigClean,
    enable_merge_det_boxes: false,
  });
}

/**
 * Attempt to extract table text from PDF, falling back to OCR if needed.
 */
async function extractOrOcrTableText(
  tableResDict, pageDict, scale, detRes, usefulList,
  ocrModel, tableForceOcr, tableUseWordBox, rotateLabel, pdfNotRotate
) {
  let ocrResult = [];

  if (!tableForceOcr && !tableResDict.ocr_enable && rotateLabel === "0" && pdfNotRotate) {
    ocrResult = await extractTableTextFromPdf(
      tableResDict, pageDict, scale, detRes, usefulList, tableUseWordBox
    );
  }

  if ((!ocrResult || !ocrResult.length) && Array.isArray(detRes) && detRes.length > 0) {
    ocrResult = await runTableOcr(ocrModel, tableResDict.table_img, detRes, tableUseWordBox);
  }

  return Array.isArray(ocrResult) ? ocrResult : [];
}


// ---------------------------------------------------------------------------
// Table: Main entry point
// ---------------------------------------------------------------------------

/**
 * Process a single table region: detect text boxes, determine orientation,
 * extract/OCR text, and run table structure recognition.
 *
 * @param {object} tableResDict
 * @param {object} pageDict
 * @param {number} scale
 * @param {AtomModelSingleton} atomModelManager
 * @param {object} tableConfig
 * @param {object} ocrConfig
 * @param {object|null} orientationConfig
 */
export async function processSingleTable(
  tableResDict, pageDict, scale, atomModelManager, tableConfig, ocrConfig, orientationConfig = null
) {
  const {
    tableForceOcr, tableUseWordBox, tableFormulaEnable,
    tableImageEnable, tableExtractOriginalImage,
  } = getTableProcessingConfig(tableConfig);

  if (!Array.isArray(tableResDict.useful_list)) {
    tableResDict.useful_list = [0, 0, 0, 0, 0, 0, 0, 0];
  }
  const usefulList = tableResDict.useful_list;

  // Prepare formula mask data
  let adjustedMfdetrecRes = [];
  if (tableFormulaEnable) {
    adjustedMfdetrecRes = getAdjustedMfdetrecRes(
      combineMfdetrecAndCheckbox(tableResDict), usefulList, { returnText: true }
    ) || [];
  }

  const ocrModel = await prepareTableOcrModel(atomModelManager, ocrConfig, tableResDict.lang);

  // Detect orientation and get text boxes
  const { detRes, rotateLabel, pdfNotRotate } = await detectTableOrientation(
    tableResDict, pageDict, scale, adjustedMfdetrecRes,
    ocrModel, atomModelManager, orientationConfig
  );

  // Extract or OCR table text
  const ocrResult = await extractOrOcrTableText(
    tableResDict, pageDict, scale, detRes, usefulList,
    ocrModel, tableForceOcr, tableUseWordBox, rotateLabel, pdfNotRotate
  );

  // Extract fill images for table
  let fillImageRes = [];
  if (tableImageEnable) {
    fillImageRes = extractTableFillImage(pageDict, tableResDict, scale, tableExtractOriginalImage) || [];
  }

  // Run table recognition
  try {
    await runTableRecognition(
      tableResDict, scale, ocrResult, adjustedMfdetrecRes,
      atomModelManager, tableConfig, ocrConfig, fillImageRes
    );
  } catch (err) {
    if (err instanceof AbortException) throw err;
    console.warn(formatPipelineError({
      stage: 'table', module: 'processSingleTable',
      message: `Table model error: ${err.message}`,
      recoverable: true,
    }));
    if (tableResDict?.table_res) {
      clearLayoutImageList(tableResDict.table_res);
    }
  }
}
