// Copyright (c) RapidAI. All rights reserved.
// PORTING NOTE: analyze_utils.py → analyze_utils.js
// Python tqdm progress loops → async iteration; NumPy arrays → JS arrays.
// ADAPTED METHODS: _extract_text_from_pdf, _run_ocr_det_batch, _run_ocr_rec_postprocess,
//                  _process_single_table, _extract_table_text_from_pdf, _run_table_ocr

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

// Re-export for batch_analyze.js consumers
export { extractTableFillImage } from "../../utils/span_pre_proc.js";

const RESOLUTION_GROUP_STRIDE = 64;

function deleteMat(mat) {
  if (mat && typeof cv !== 'undefined' && mat instanceof cv.Mat && !mat.isDeleted?.()) {
    mat.delete();
  }
}

function clearLayoutImageList(tableRes) {
  const list = tableRes?.layout_image_list;
  if (Array.isArray(list)) {
    for (const item of list) deleteMat(item?.pil_image);
  }
  if (tableRes) delete tableRes.layout_image_list;
}

async function yieldToBrowser() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Helper: Apply mask boxes to image
// ---------------------------------------------------------------------------

/**
 * Mask regions (e.g., formulas) by filling with white (255).
 * Prevents OCR from detecting text inside masked regions.
 * PORTING NOTE: _apply_mask_boxes_to_image(...) → applyMaskBoxesToImage(...)
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
      roi.setTo(new cv.Scalar(255, 255, 255, 255)); // Fill white
      roi.delete();
    } catch (e) {
      console.warn(`[applyMaskBoxesToImage] Failed to mask region [${x0},${y0},${x1},${y1}]:`, e);
    }
  }

  return maskedMat;
}

// ---------------------------------------------------------------------------
// OCR-det
// ---------------------------------------------------------------------------

/**
 * Extract text from PDF for OCR results where ocr_enable is false.
 * PORTING NOTE: _extract_text_from_pdf(...) → async extractTextFromPdf(...)
 * @param {object[]} ocrResAllPage
 * @param {object[]} pdfDictList
 * @param {number[]} scaleList
 * @returns {Promise<void>}
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
            [...(Array.isArray(ocrResDict.single_page_mfdetrec_res) ? ocrResDict.single_page_mfdetrec_res : []), ...(Array.isArray(ocrResDict.checkbox_res) ? ocrResDict.checkbox_res : [])],
            usefulList
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
        } finally {
          deleteMat(newImage);
        }
      }
      await yieldToBrowser();
    }
  }
}

/**
 * Batch OCR detection across pages.
 * PORTING NOTE: _run_ocr_det_batch(...) → async runOcrDetBatch(...)
 * @param {object[]} ocrResAllPage
 * @param {AtomModelSingleton} atomModelManager
 * @param {object} ocrConfig
 * @returns {Promise<void>}
 */
export async function runOcrDetBatch(ocrResAllPage, atomModelManager, ocrConfig) {
  const useDetMode = (ocrConfig || {}).use_det_mode || "auto";
  const ocrDetBaseBatchSize = (ocrConfig || {})["Det.rec_batch_num"] || 1;

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
        [...(Array.isArray(ocrResDict.single_page_mfdetrec_res) ? ocrResDict.single_page_mfdetrec_res : []), ...(Array.isArray(ocrResDict.checkbox_res) ? ocrResDict.checkbox_res : [])],
        usefulList
      );

      // Apply mask to formula regions before OCR detection
      const detImage = applyMaskBoxesToImage(bgrImage, adjustedMfdetrecRes);

      allCroppedInfo.push([
        bgrImage, detImage, usefulList, ocrResDict,
        adjustedMfdetrecRes, ocrResDict.lang, res, ocrEnable,
      ]);
    }
  }

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
      det_db_box_thresh: 0.3,
      lang,
      ocr_config: ocrConfig,
    });

    // Group by resolution (padded to stride multiples)
    const resolutionGroups = {};
    for (const info of langCropList) {
      const croppedImg = info[1]; // detImage
      const { rows: h, cols: w } = croppedImg; // cv.Mat or {rows, cols}
      const imgH = h || (croppedImg.height || 0);
      const imgW = w || (croppedImg.width || 0);
      const targetH = Math.ceil(imgH / RESOLUTION_GROUP_STRIDE) * RESOLUTION_GROUP_STRIDE;
      const targetW = Math.ceil(imgW / RESOLUTION_GROUP_STRIDE) * RESOLUTION_GROUP_STRIDE;
      const key = `${targetH},${targetW}`;
      (resolutionGroups[key] = resolutionGroups[key] || []).push(info);
    }

    for (const [key, groupCrops] of Object.entries(resolutionGroups)) {
      const [targetH, targetW] = key.split(',').map(Number);

      // Pad and collect batch images
      const batchImages = groupCrops.map(info => {
        const img = info[1]; // detImage (masked)
        return padImageTo(img, targetH, targetW);
      });

      const detBatchSize = Math.min(batchImages.length, ocrDetBaseBatchSize);
      const batchResults = await ocrModel.detBatchPredict(batchImages, detBatchSize);

      // Free padded Mats that were created above
      for (const padded of batchImages) {
        if (padded && typeof cv !== 'undefined' && padded instanceof cv.Mat) padded.delete();
      }

      for (let i = 0; i < groupCrops.length; i++) {
        const info = groupCrops[i];
        const [bgrImage, detImage, usefulList, ocrResDict, adjustedMfdetrecRes, _lang, res, ocrEnable] = info;
        // detBatchPredict returns { boxes, elapse } objects — destructure by name.
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
              ocrRes, usefulList, ocrEnable, bgrImage, _lang,
              res.original_label, res.original_order
            );
            ocrResDict.layout_res.push(...ocrResultList);
          }
        }

        if (detImage !== bgrImage) deleteMat(detImage);
        deleteMat(bgrImage);
      }
      await yieldToBrowser();
    }
  }
}

// ---------------------------------------------------------------------------
// OCR-rec
// ---------------------------------------------------------------------------

/**
 * Post-process OCR recognition for spans that contain np_img.
 * PORTING NOTE: _run_ocr_rec_postprocess(images_layout_res, ocr_config)
 * @param {object[][]} imagesLayoutRes
 * @param {object} ocrConfig
 * @returns {Promise<void>}
 */
export async function runOcrRecPostprocess(imagesLayoutRes, ocrConfig) {
  const atomModelManager = AtomModelSingleton.getInstance();

  const needOcrByLang = {};
  const imgCropByLang = {};

  for (const layoutRes of imagesLayoutRes) {
    for (const item of layoutRes) {
      if (item.category_id === CategoryId.OcrText) {
        if (item.np_img !== undefined && item.lang !== undefined) {
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
      const ocrResList = (Array.isArray(ocrResListAll) && ocrResListAll.length > 0) ? ocrResListAll[0] : [];
    const needOcrList = needOcrByLang[lang];

    if (ocrResList.length !== needOcrList.length) {
      console.warn(`[runOcrRecPostprocess] mismatch: ocrResList=${ocrResList.length}, need=${needOcrList.length}`);
    }

      for (let i = 0; i < needOcrList.length; i++) {
      const item = needOcrList[i];
      const [ocrText, ocrScore] = ocrResList[i] || ['', 0];

      item.text = ocrText;
      item.score = parseFloat(Number(ocrScore || 0).toFixed(3));

      if (Number(ocrScore || 0) < OcrConfidence.min_confidence) {
        item.category_id = CategoryId.LowScoreText;
      } else {
        const bbox = [item.poly[0], item.poly[1], item.poly[4], item.poly[5]];
        const width = bbox[2] - bbox[0];
        const height = bbox[3] - bbox[1];
        const specialTexts = ['（204号', '（20', '（2', '（2号', '（20号', '号', '（204'];
        if (specialTexts.includes(ocrText) && ocrScore < 0.8 && width < height) {
          item.category_id = CategoryId.LowScoreText;
        }
      }
      }
    } finally {
      for (const img of imgCropList) deleteMat(img);
    }
    await yieldToBrowser();
  }
}

// ---------------------------------------------------------------------------
// Table processing
// ---------------------------------------------------------------------------

/**
 * Process a single table region.
 * PORTING NOTE: _process_single_table(...) → async processSingleTable(...)
 * @param {object} tableResDict
 * @param {object} pageDict
 * @param {number} scale
 * @param {AtomModelSingleton} atomModelManager
 * @param {object} tableConfig
 * @param {object} ocrConfig
 * @returns {Promise<void>}
 */
export async function processSingleTable(
  tableResDict, pageDict, scale, atomModelManager, tableConfig, ocrConfig
) {
  const tableForceOcr = tableConfig?.force_ocr ?? false;
  const skipTextInImage = tableConfig?.skip_text_in_image ?? true;
  const useImg2table = tableConfig?.use_img2table ?? false;
  const tableUseWordBox = tableConfig?.use_word_box ?? false;
  const tableFormulaEnable = tableConfig?.table_formula_enable ?? true;
  const tableImageEnable = tableConfig?.table_image_enable ?? true;
  const tableExtractOriginalImage = tableConfig?.extract_original_image ?? false;

  const _lang = tableResDict.lang;
  if (!Array.isArray(tableResDict.useful_list)) {
    tableResDict.useful_list = [0, 0, 0, 0, 0, 0, 0, 0];
  }
  const usefulList = tableResDict.useful_list;

  let adjustedMfdetrecRes = [];
  if (tableFormulaEnable) {
    adjustedMfdetrecRes = getAdjustedMfdetrecRes(
      [...(Array.isArray(tableResDict.single_page_mfdetrec_res) ? tableResDict.single_page_mfdetrec_res : []), ...(Array.isArray(tableResDict.checkbox_res) ? tableResDict.checkbox_res : [])],
      usefulList, { returnText: true }
    ) || [];
  }

  let ocrConfigClean = null;
  if (ocrConfig !== null && ocrConfig !== undefined) {
    ocrConfigClean = { ...ocrConfig };
    delete ocrConfigClean.custom_model;
  }

  const ocrModel = await atomModelManager.getAtomModel(AtomicModel.OCR, {
    det_db_thresh: 0.3,          // Lower binarization threshold (detect fainter text)
    det_db_box_thresh: 0.5,      // Lower box confidence threshold (detect more boxes)
    det_db_unclip_ratio: 1.6,    // Slightly tighter unclip (reduce box overlap)
    lang: _lang,
    ocr_config: ocrConfigClean,
    enable_merge_det_boxes: false,
  });

  // Apply mask to formula regions before OCR detection
  const detImage = adjustedMfdetrecRes && adjustedMfdetrecRes.length > 0
    ? applyMaskBoxesToImage(tableResDict.table_img, adjustedMfdetrecRes)
    : tableResDict.table_img;

  const ocrResRaw = await ocrModel.ocr(detImage, {
    mfdRes: adjustedMfdetrecRes, 
    rec: false,
    enableMergeDetBoxes: false,
  });
  let detRes = (Array.isArray(ocrResRaw) && ocrResRaw.length > 0) ? (ocrResRaw[0] || []) : [];

  // Clean up masked image if created
  if (detImage !== tableResDict.table_img) deleteMat(detImage);

  let angles = [];
  let rotateLabel = "0";
  const pdfNotRotate = !["90", "180", "270"].includes(String(pageDict?.rotate_label ?? "0"));
  if (pdfNotRotate) {
    const mostAngle = Number(txtMostAngleExtractTable(pageDict, tableResDict, Number(scale)) || 0);
    if (mostAngle) {
      rotateLabel = String(mostAngle);
      angles = [mostAngle];
    }
  }
  if (!angles.length) {
    try {
      const imgOrientationClsModel = await atomModelManager.getAtomModel(AtomicModel.ImgOrientationCls);
      rotateLabel = await imgOrientationClsModel.predict(tableResDict.table_img, detRes);
    } catch (e) {
      // Orientation model unavailable or failed — keep rotateLabel = "0"
    }
  }
  if (rotateLabel === "90" || rotateLabel === "270") {
    rotateImage(tableResDict, rotateLabel);
    const rotatedDetImage = adjustedMfdetrecRes && adjustedMfdetrecRes.length > 0
      ? applyMaskBoxesToImage(tableResDict.table_img, adjustedMfdetrecRes)
      : tableResDict.table_img;
    try {
      const rotatedOcrResRaw = await ocrModel.ocr(rotatedDetImage, {
        mfdRes: adjustedMfdetrecRes,
        rec: false,
        enableMergeDetBoxes: false,
      });
      detRes = (Array.isArray(rotatedOcrResRaw) && rotatedOcrResRaw.length > 0) ? (rotatedOcrResRaw[0] || []) : [];
    } finally {
      if (rotatedDetImage !== tableResDict.table_img) deleteMat(rotatedDetImage);
    }
  }

  let ocrResult = [];

  // Try PDF text extraction first
  if (!tableForceOcr && !tableResDict.ocr_enable && rotateLabel === "0" && pdfNotRotate) {
    ocrResult = await extractTableTextFromPdf(tableResDict, pageDict, scale, detRes, usefulList, tableUseWordBox);
  }

  // Fall back to OCR if extraction failed
  if ((!ocrResult || !ocrResult.length) && Array.isArray(detRes) && detRes.length > 0) {
    ocrResult = await runTableOcr(ocrModel, tableResDict.table_img, detRes, tableUseWordBox);
  }

  // Ensure ocrResult is an array
  if (!ocrResult || !Array.isArray(ocrResult)) ocrResult = [];

  // Get table model and run recognition
  let htmlCode = null;
  let fillImageRes = [];
  try {
    const tableModel = await atomModelManager.getAtomModel(AtomicModel.Table, {
      lang: _lang,
      ocr_config: ocrConfig,
      table_config: tableConfig,
    });

    if (tableImageEnable) {
      fillImageRes = extractTableFillImage(pageDict, tableResDict, scale, tableExtractOriginalImage) || [];
    }

    if (tableResDict && tableResDict.table_res) {
      clearLayoutImageList(tableResDict.table_res);
    }

    if (tableModel && typeof tableModel.predict === 'function') {
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
      htmlCode = tableResult ? tableResult.html : null;
    }
  } catch (err) {
    console.warn('[processSingleTable] table model error:', err.message);
    if (tableResDict && tableResDict.table_res) {
      clearLayoutImageList(tableResDict.table_res);
    }
  }

  if (htmlCode && typeof htmlCode === 'string' && htmlCode.includes('<table>') && htmlCode.includes('</table>')) {
    const start = htmlCode.indexOf('<table>');
    const end = htmlCode.lastIndexOf('</table>') + '</table>'.length;
    tableResDict.table_res.html = htmlCode.slice(start, end);

    const singlePageMfResArr = Array.isArray(tableResDict.single_page_mfdetrec_res) ? tableResDict.single_page_mfdetrec_res : [];
    const checkboxResArr = Array.isArray(tableResDict.checkbox_res) ? tableResDict.checkbox_res : [];

    const formulaBoxes = [
      ...singlePageMfResArr,
      ...checkboxResArr,
    ].filter(t => t && t.bbox).map(t => t.bbox);

    if (formulaBoxes.length && tableResDict.table_res) {
      tableResDict.table_res.formula_boxes = formulaBoxes.map(
        bbox => Array.isArray(bbox) ? bbox.map(c => Math.round(Number(c) / scale)) : []
      );
    }

    const validFillImgResArr = Array.isArray(fillImageRes) ? fillImageRes : [];
    const imgBoxes = validFillImgResArr.filter(t => t && t.bbox).map(t => t.ori_bbox);
    if (imgBoxes?.length && tableResDict.table_res) {
      tableResDict.table_res.img_boxes = imgBoxes.map(
        bbox => Array.isArray(bbox) ? bbox.map(c => Math.round(Number(c) / scale)) : []
      );
    }
  } else {
    console.warn('[processSingleTable] table recognition processing fails');
  }
}

/**
 * Extract table text from PDF page.
 * PORTING NOTE: _extract_table_text_from_pdf(...) → async extractTableTextFromPdf(...)
 * @returns {Promise<any[]>}
 */
export async function extractTableTextFromPdf(tableResDict, pageDict, scale, detRes, usefulList, tableUseWordBox) {
  if (!detRes || !detRes.length || !Array.isArray(usefulList)) return [];
  try {
    const ocrSpans = getOcrResultListTable(detRes, usefulList, scale) || [];
    const poly = tableResDict.table_res.poly || [0, 0, 0, 0, 0, 0, 0, 0];
    const tableBboxes = [[
      Math.floor(Number(poly[0] || 0) / scale), Math.floor(Number(poly[1] || 0) / scale),
      Math.floor(Number(poly[4] || 0) / scale), Math.floor(Number(poly[5] || 0) / scale),
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
    const [a, b, c] = [filtered.map(r => r[0]), filtered.map(r => r[1]), filtered.map(r => r[2])];
    return [a, b, c];
  } catch (e) {
    console.warn('[extractTableTextFromPdf] error:', e.message);
    return [];
  }
}

/**
 * Run OCR on table image.
 * PORTING NOTE: _run_table_ocr(...) → async runTableOcr(...)
 * @returns {Promise<any[]>}
 */
export async function runTableOcr(ocrModel, bgrImage, detRes, tableUseWordBox) {
  if (!Array.isArray(detRes) || detRes.length === 0) {
    return [];
  }
  
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
  } finally {
    for (const img of croppedImgList) deleteMat(img);
  }

  const ocrResListRaw = (Array.isArray(ocrResRawResult) && ocrResRawResult.length > 0) ? (ocrResRawResult[0] || []) : [];

  console.log('[runTableOcr] OCR recognition result:', {
    ocrResListRawLen: ocrResListRaw.length,
    ocrResListRawSample: ocrResListRaw.slice(0, 2),
  });

  const ocrResult = [];
  for (let i = 0; i < recImgList.length; i++) {
    const imgDict = recImgList[i];
    const ocrRes = ocrResListRaw[i];
    if (!Array.isArray(ocrRes)) continue;

    if (tableUseWordBox && ocrRes.length >= 3) {
      // Format: [text, score, wordResults]
      // wordResults is array of word info from calRecBoxes
      const wordResults = Array.isArray(ocrRes[2]) ? ocrRes[2] : [];
      for (const wordResult of wordResults) {
        // wordResult format: [text, score, bbox]
        if (wordResult && wordResult.length >= 3) {
          ocrResult.push([wordResult[2], wordResult[0], wordResult[1]]);
        }
      }
    } else {
      ocrResult.push([imgDict.dtBox, ocrRes[0], ocrRes[1]]);
    }
  }

  if (!ocrResult.length) {
    console.warn('[runTableOcr] No OCR results after processing');
    return [];
  }
  
  const finalResult = [ocrResult.map(r => r[0]), ocrResult.map(r => r[1]), ocrResult.map(r => r[2])];
  console.log('[runTableOcr] Final result:', {
    boxesLen: finalResult[0].length,
    textsLen: finalResult[1].length,
    scoresLen: finalResult[2].length,
    textsSample: finalResult[1].slice(0, 5),
  });
  
  return finalResult;
}

// ---------------------------------------------------------------------------
// Internal utility
// ---------------------------------------------------------------------------

/**
 * Pad a cv.Mat or ImageData-like object to targetH × targetW with white (255).
 * Returns the padded image handle (same type as input).
 * @param {any} img
 * @param {number} targetH
 * @param {number} targetW
 * @returns {any}
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
  // Fallback: return as-is (caller handles padding)
  return img;
}
