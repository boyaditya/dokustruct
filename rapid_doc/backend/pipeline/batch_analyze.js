// Copyright (c) RapidAI. All rights reserved.
/**
 * PORTING NOTE: batch_analyze.py → batch_analyze.js
 *
 * WORKAROUND: Python synchronous __call__ with tqdm progress
 * REASON: All model inference is async in the browser
 * SOLUTION: async call() method; tqdm loops replaced with plain async iterations
 *
 * AFFECTED METHODS:
 *   BatchAnalyze.__call__ → async call(imagesWithExtraInfo)
 *   _run_layout_detection → async _runLayoutDetection()
 *   _run_formula_recognition → async _runFormulaRecognition()
 *   _run_custom_ocr → async _runCustomOcr()
 *   _run_traditional_ocr → async _runTraditionalOcr()
 *   _run_table_recognition → async _runTableRecognition()
 *   _run_traditional_table_recognition → async _runTraditionalTableRecognition()
 */

import {
  extractTextFromPdf, runOcrDetBatch, runOcrRecPostprocess, processSingleTable,
  extractTableFillImage,
} from "./analyze_utils.js";
import { AtomModelSingleton } from "./model_init.js";
import { removeLayoutInOriImages, filterOverlapBoxes } from "../utils/utils.js";
import { normalizeToIntBbox } from "../../utils/bbox_utils.js";
import { checkboxPredict } from "../../utils/checkbox_det_cls.js";
import { getFormulaEnable, getTableEnable } from "../../utils/config_reader.js";
import { CategoryId } from "../../utils/enum_class.js";
import { cropImg, getResListFromLayoutRes, cleanVram, toMatBgr } from "../../utils/model_utils.js";
import { getCropNpImg } from "../../utils/pdf_image_tools.js";
import { extractTableFillImage as _extractTableFillImage } from "../../utils/span_pre_proc.js";
import { AtomicModel } from "./model_list.js";
import { getRotateImage, restorePoly } from "../../utils/boxbase.js";

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

/**
 * Batch analysis processor — orchestrates layout, formula, OCR, and table models.
 * PORTING NOTE: BatchAnalyze class with __call__ → call()
 */
export class BatchAnalyze {
  /**
   * @param {object} modelManager - ModelSingleton instance
   * @param {number} batchRatio
   * @param {boolean} formulaEnable
   * @param {boolean} tableEnable
   * @param {object|null} layoutConfig
   * @param {object|null} ocrConfig
   * @param {object|null} formulaConfig
   * @param {object|null} tableConfig
   * @param {object|null} checkboxConfig
   */
  constructor(
    modelManager,
    batchRatio,
    formulaEnable,
    tableEnable,
    layoutConfig = null,
    ocrConfig = null,
    formulaConfig = null,
    tableConfig = null,
    checkboxConfig = null,
  ) {
    this.modelManager = modelManager;
    this.batchRatio = batchRatio;

    this.formulaEnable = getFormulaEnable(formulaEnable);
    this.tableEnable = getTableEnable(tableEnable);
    this.checkboxEnable = checkboxConfig?.checkbox_enable ?? false;

    this.layoutConfig = layoutConfig || {};
    this.ocrConfig = ocrConfig || {};
    this.formulaConfig = formulaConfig || {};
    this.tableConfig = tableConfig || {};

    this.useDetMode = this.ocrConfig.use_det_mode || "auto";
    this.ocrDetBaseBatchSize = this.ocrConfig["Det.rec_batch_num"] || 1;
    this.sealEnable = this.ocrConfig.seal_enable ?? true;
    this.useDocOrientationClassify =
      this.layoutConfig.use_doc_orientation_classify ??
      this.layoutConfig.useDocOrientationClassify ??
      true;
    this.useCustomOcr = false;
    this.useCustomTable = false;

    this.layoutBaseBatchSize = this.layoutConfig.batch_num || 1;

    this.formulaLevel = this.formulaConfig.formula_level || 0;
    // WEBGPU LIMITATION: PP-FormulaNet Plus M is a ~100M param Transformer.
    // Batch size > 1 causes session.run() to hang permanently on RX 580 (and similar GPUs)
    // because the intermediate attention tensors exceed WebGPU dispatch/buffer limits.
    // batchSize=1 is the ONLY safe configuration for WebGPU Transformer inference.
    this.formulaBaseBatchSize = this.formulaConfig.batch_num || 1;

    this.tableForceOcr = this.tableConfig.force_ocr ?? false;
    this.skipTextInImage = this.tableConfig.skip_text_in_image ?? true;
    this.useImg2table = this.tableConfig.use_img2table ?? false;
    this.tableUseWordBox = this.tableConfig.use_word_box ?? false;
    this.tableFormulaEnable = this.tableConfig.table_formula_enable ?? true;
    this.tableImageEnable = this.tableConfig.table_image_enable ?? true;
    this.tableExtractOriginalImage = this.tableConfig.extract_original_image ?? false;

    this.model = null;
    this.lang = null;
    this.lastStageTimings = {
      layout: 0,
      formula: 0,
      ocr: 0,
      table: 0,
      reading_order: 0,
      postprocessing: 0,
    };
  }

  /**
   * Execute batch analysis.
   * PORTING NOTE: BatchAnalyze.__call__(images_with_extra_info) → async call(...)
   *
   * @param {Array<[any, number, boolean, string, object]>} imagesWithExtraInfo
   *   Each entry: [PIL image (as ImageBitmap/etc), scale, ocr_enable, lang, pdf_dict]
   * @returns {Promise<object[][]>} images_layout_res
   */
  async call(imagesWithExtraInfo) {
    if (!imagesWithExtraInfo.length) return [];

    const stageTimings = {
      layout: 0,
      formula: 0,
      ocr: 0,
      table: 0,
      reading_order: 0,
      postprocessing: 0,
    };

    // Initialize models
    this.model = await this.modelManager.getModel({
      lang: this.lang,
      formula_enable: this.formulaEnable,
      table_enable: this.tableEnable,
      layout_config: this.layoutConfig,
      ocr_config: this.ocrConfig,
      formula_config: this.formulaConfig,
      table_config: this.tableConfig,
    });

    this.useCustomOcr = typeof this.model.ocrModel?.batchPredict === "function" &&
                        !("ocr" in this.model.ocrModel);
    this.useCustomTable = !!this.tableConfig.custom_model &&
                          typeof this.model.tableModel?.batchPredict === "function";

    const pdfDictList = imagesWithExtraInfo.map(([,,,, pdfDict]) => pdfDict);
    const scaleList = imagesWithExtraInfo.map(([, scale]) => scale);

    // Convert raw page images (OffscreenCanvas / ImageBitmap from PDF.js) to BGR
    // cv.Mat objects that all downstream pipeline code (cropImg, OCR, etc.) expects.
    // owned[i]=true means we created the Mat and must delete it when we're done.
    const matResults = imagesWithExtraInfo.map(([image]) => toMatBgr(image));
    const npImages   = matResults.map(r => r.mat);
    const ownedMats  = matResults.map(r => r.owned);
    const imgOriOrientationList = [];

    if (this.useDocOrientationClassify) {
      const atomModelManager = AtomModelSingleton.getInstance();
      const imgOrientationClsModel = await atomModelManager.getAtomModel(
        AtomicModel.ImgOrientationCls
      );
      for (let i = 0; i < npImages.length; i++) {
        const npImg = npImages[i];
        const h = npImg.rows;
        const w = npImg.cols;
        const rotateLabel = await imgOrientationClsModel.predict(npImg);
        if (rotateLabel === "90" || rotateLabel === "270") {
          const rotated = getRotateImage(npImg, rotateLabel);
          if (rotated !== npImg && ownedMats[i]) npImg.delete();
          npImages[i] = rotated;
        }
        pdfDictList[i].rotate_label = rotateLabel;
        imgOriOrientationList.push([h, w, rotateLabel]);
      }
    }

    // 1. Layout detection
    const tLayout0 = performance.now();
    const imagesLayoutRes = await this._runLayoutDetection(npImages, pdfDictList, scaleList);
    stageTimings.layout = performance.now() - tLayout0;
    await yieldToBrowser();

    // 2. Collect detection regions
    const [ocrResAllPage, tableResAllPage, formulaResAllPage] =
      await this._collectDetectionRegions(imagesLayoutRes, npImages, imagesWithExtraInfo);

    // 3. Formula recognition
    if (this.formulaEnable) {
      const tFormula0 = performance.now();
      await this._runFormulaRecognition(formulaResAllPage);
      stageTimings.formula = performance.now() - tFormula0;
      await yieldToBrowser();
    }

    // 4. OCR
    if (this.useCustomOcr) {
      const tOcr0 = performance.now();
      await this._runCustomOcr(ocrResAllPage);
      stageTimings.ocr = performance.now() - tOcr0;
    } else {
      const tOcr0 = performance.now();
      await this._runTraditionalOcr(ocrResAllPage, pdfDictList, scaleList);
      stageTimings.ocr = performance.now() - tOcr0;
    }
    await yieldToBrowser();

    // 5. Table recognition
    if (this.tableEnable) {
      const tTable0 = performance.now();
      await this._runTableRecognition(tableResAllPage, pdfDictList, scaleList);
      stageTimings.table = performance.now() - tTable0;
    }
    await yieldToBrowser();

    // 6. Post-process OCR rec results
    const tPost0 = performance.now();
    await runOcrRecPostprocess(imagesLayoutRes, this.ocrConfig);
    stageTimings.postprocessing = performance.now() - tPost0;
    await yieldToBrowser();

    if (this.sealEnable) {
      await this._runSealOcr(npImages, imagesLayoutRes);
    }

    if (imgOriOrientationList.length) {
      for (let index = 0; index < imagesLayoutRes.length; index++) {
        const [h, w, rotateLabel] = imgOriOrientationList[index];
        for (const layoutRe of imagesLayoutRes[index]) {
          layoutRe.rotate_label = rotateLabel;
          if (rotateLabel === "90" || rotateLabel === "270") {
            layoutRe.poly = restorePoly(layoutRe.poly, rotateLabel, w, h);
          }
        }
      }
    }

    // Release any cv.Mat objects that we created from OffscreenCanvas/ImageBitmap
    for (let i = 0; i < npImages.length; i++) {
      if (ownedMats[i]) npImages[i].delete();
    }

    this.lastStageTimings = stageTimings;

    return imagesLayoutRes;
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  async _runLayoutDetection(npImages, pdfDictList, scaleList) {
    let imagesLayoutRes = await this.model.layoutModel.batchPredict(
      npImages, this.layoutBaseBatchSize
    );
    imagesLayoutRes = imagesLayoutRes.map(item => filterOverlapBoxes(item, this.useCustomOcr));

    if (this.useDetMode === 'txt') {
      imagesLayoutRes = removeLayoutInOriImages(imagesLayoutRes, pdfDictList, scaleList);
    }

    // Align with 0.9.1 baseline: when formula is disabled, inline equations
    // are filtered at layout stage (same as formula level 1 behavior).
    if (!this.formulaEnable || this.formulaLevel === 1) {
      imagesLayoutRes = imagesLayoutRes.map(page =>
        page.filter(item => item.category_id !== CategoryId.InlineEquation)
      );
    }

    return imagesLayoutRes;
  }

  // ---------------------------------------------------------------------------
  // Collect regions
  // ---------------------------------------------------------------------------

  async _collectDetectionRegions(imagesLayoutRes, npImages, imagesWithExtraInfo) {
    const ocrResAllPage = [];
    const tableResAllPage = [];
    const formulaResAllPage = [];

    for (let index = 0; index < npImages.length; index++) {
      const [,, ocrEnable, _lang, ] = imagesWithExtraInfo[index];
      const npImg = npImages[index];
      const layoutRes = imagesLayoutRes[index];

      const { ocrResList, tableResList, formulaResList } = getResListFromLayoutRes(layoutRes, npImg);

      // Checkbox detection
      const checkboxRes = [];
      if (this.checkboxEnable) {
        const cbRes = checkboxPredict(npImg);
        for (const res of cbRes) {
          const poly = [
            res.bbox[0], res.bbox[1], res.bbox[2], res.bbox[1],
            res.bbox[2], res.bbox[3], res.bbox[0], res.bbox[3],
          ];
          layoutRes.push({
            bbox: res.bbox, poly,
            category_id: CategoryId.CheckBox,
            checkbox: res.text, score: 0.9,
          });
          checkboxRes.push({ bbox: res.bbox, poly, category_id: CategoryId.CheckBox, checkbox: res.text, score: 0.9 });
        }
      }

      // OCR region
      ocrResAllPage.push({
        ocr_res_list: ocrResList,
        lang: _lang,
        ocr_enable: ocrEnable,
        np_img: npImg,
        single_page_mfdetrec_res: formulaResList,
        checkbox_res: checkboxRes,
        layout_res: layoutRes,
        page_idx: index,
      });

      // Table regions
      for (const tableRes of tableResList) {
        try {
          // New implementation: use scale=5 for better table quality
          const poly = tableRes.poly;
          let tableImg, usefulList;

          if (!poly || poly.length < 6) {
            tableImg = new cv.Mat(0, 0, cv.CV_8UC3);
            usefulList = [];
          } else {
            let bbox = normalizeToIntBbox(poly, [npImg.rows, npImg.cols]);
            const scale = 5;
            bbox = bbox ? bbox.map(v => v / scale) : null;

            const intBbox = normalizeToIntBbox(bbox);

            if (!intBbox) {
              tableImg = new cv.Mat(0, 0, cv.CV_8UC3);
              usefulList = [];
            } else {
              const result = getCropNpImg(intBbox, npImg, scale, true); // return_list=true
              tableImg = result.mat;
              usefulList = result.usefulList;
              if (!tableImg || tableImg.cols <= 0 || tableImg.rows <= 0) {
                if (tableImg && typeof tableImg.delete === "function" && !tableImg.isDeleted?.()) tableImg.delete();
                const fallback = cropImg(tableRes, npImg, 0, 0, { layoutShapeMode: "rect" });
                tableImg = fallback.newImage;
                usefulList = fallback.usefulList;
              }
            }
          }

          tableResAllPage.push({
            table_res: tableRes,
            lang: _lang,
            table_img: tableImg,
            rect_table_img: tableImg, // Same now (no separate rect crop)
            single_page_mfdetrec_res: formulaResList,
            checkbox_res: checkboxRes,
            useful_list: usefulList,
            ocr_enable: ocrEnable,
            page_idx: index,
          });
        } catch (err) {
          console.warn('[BatchAnalyze] table crop skipped:', formatPipelineError(err));
          tableRes.html = "";
        }
      }

      // Formula regions
      if (this.formulaEnable) {
        for (const formulaRes of formulaResList) {
          const { newImage: formulaImg } = cropImg(formulaRes, npImg);
          formulaResAllPage.push({
            formula_res: formulaRes,
            lang: _lang,
            formula_img: formulaImg,
          });
        }
      }
    }

    return [ocrResAllPage, tableResAllPage, formulaResAllPage];
  }

  // ---------------------------------------------------------------------------
  // Formula
  // ---------------------------------------------------------------------------

  async _runFormulaRecognition(formulaResAllPage) {
    if (!this.model.formulaModel) {
      console.warn('[BatchAnalyze] formulaModel is null (likely failed to load). Skipping formula recognition.');
      return;
    }
    const formulaImgs = formulaResAllPage.map(d => d.formula_img);
    if (!formulaImgs.length) return;

    try {
      const formulaResults = await this.model.formulaModel.batchPredict(
        formulaImgs, this.formulaBaseBatchSize
      );
      const recFormulas = formulaResults.recFormulas ?? [];

      for (let i = 0; i < formulaResAllPage.length; i++) {
        const d = formulaResAllPage[i];
        const res = recFormulas[i];
        if (res !== undefined && res !== null) {
          d.formula_res.latex = res;
        } else {
          console.warn('[BatchAnalyze] latex recognition processing fails');
        }
      }
    } finally {
      for (const img of formulaImgs) deleteMat(img);
    }
  }

  // ---------------------------------------------------------------------------
  // OCR — VL custom model
  // ---------------------------------------------------------------------------

  async _runCustomOcr(ocrResAllPage) {
    const allOcrRegions = [];

    for (const ocrResDict of ocrResAllPage) {
      for (const res of ocrResDict.ocr_res_list) {
        const { newImage: bgrImage, usefulList } = cropImg(res, ocrResDict.np_img);
        allOcrRegions.push({
          image: bgrImage,
          res,
          layoutRes: ocrResDict.layout_res,
          usefulList,
        });
      }
    }

    if (!allOcrRegions.length) return;

    const images = allOcrRegions.map(r => r.image);
    try {
      const ocrTexts = await this.model.ocrModel.batchPredict(
        images, { batchSize: this.ocrDetBaseBatchSize }
      );

      for (let i = 0; i < allOcrRegions.length; i++) {
        const region = allOcrRegions[i];
        const text = ocrTexts[i];
        const res = region.res;

        const vlOcrResult = {
          poly: res.poly,
          category_id: CategoryId.OcrText,
          score: 0.95,
          text: text?.trim() ?? '',
          vl_ocr: true,
          original_label: res.original_label ?? null,
          original_order: res.original_order ?? null,
          polygon_points: res.polygon_points ?? null,
        };
        region.layoutRes.push(vlOcrResult);
      }
    } finally {
      for (const img of images) deleteMat(img);
    }
  }

  // ---------------------------------------------------------------------------
  // OCR — traditional det+rec
  // ---------------------------------------------------------------------------

  async _runTraditionalOcr(ocrResAllPage, pdfDictList, scaleList) {
    const atomModelManager = AtomModelSingleton.getInstance();

    if (this.useDetMode !== 'ocr') {
      await extractTextFromPdf(ocrResAllPage, pdfDictList, scaleList);
    }

    await runOcrDetBatch(ocrResAllPage, atomModelManager, this.ocrConfig);
  }

  // ---------------------------------------------------------------------------
  // Table
  // ---------------------------------------------------------------------------

  async _runTableRecognition(tableResAllPage, pdfDictList, scaleList) {
    // VL/custom table model
    if (this.useCustomTable) {
      const tableImgs = [];
      const fillImageResList = [];

      for (const tableResDict of tableResAllPage) {
        const pageIdx = tableResDict.page_idx;
        const pageDict = pdfDictList[pageIdx];
        const scale = scaleList[pageIdx];
        let fillImageRes = [];
        if (this.tableImageEnable) {
          fillImageRes = _extractTableFillImage(pageDict, tableResDict, scale, this.tableExtractOriginalImage);
        }
        tableImgs.push(tableResDict.table_img);
        fillImageResList.push(fillImageRes);
      }

      if (tableImgs.length) {
        try {
          const tableResults = await this.model.tableModel.batchPredict(
            tableImgs, { fillImageResList }
          );
          const tableHtmls = Array.isArray(tableResults) ? tableResults : (tableResults?.htmls ?? []);
          for (let i = 0; i < tableResAllPage.length; i++) {
            const tableResDict = tableResAllPage[i];
            clearLayoutImageList(tableResDict.table_res);
            if (tableHtmls[i]) {
              tableResDict.table_res.html = tableHtmls[i];
            }
          }
        } finally {
          for (const tableResDict of tableResAllPage) {
            if (tableResDict.table_img === tableResDict.rect_table_img) {
              deleteMat(tableResDict.table_img);
            } else {
              deleteMat(tableResDict.table_img);
              deleteMat(tableResDict.rect_table_img);
            }
            tableResDict.table_img = null;
            tableResDict.rect_table_img = null;
          }
        }
      }
    } else {
      await this._runTraditionalTableRecognition(tableResAllPage, pdfDictList, scaleList);
    }
  }

  async _runTraditionalTableRecognition(tableResAllPage, pdfDictList, scaleList) {
    const atomModelManager = AtomModelSingleton.getInstance();

    // Group by page_idx
    const tableResGrouped = {};
    for (const x of tableResAllPage) {
      (tableResGrouped[x.page_idx] = tableResGrouped[x.page_idx] || []).push(x);
    }

    let done = 0;
    const total = tableResAllPage.length;

    for (const [pageIdxStr, tableList] of Object.entries(tableResGrouped)) {
      const pageIdx = Number(pageIdxStr);
      const pageDict = pdfDictList[pageIdx];
      const scale = scaleList[pageIdx];

      for (const tableResDict of tableList) {
        try {
          tableResDict.table_img = tableResDict.rect_table_img;
          await processSingleTable(
            tableResDict, pageDict, scale, atomModelManager,
            this.tableConfig, this.ocrConfig
          );
        } catch (err) {
          console.warn('[BatchAnalyze] table recognition skipped:', formatPipelineError(err));
          if (tableResDict?.table_res) {
            clearLayoutImageList(tableResDict.table_res);
            tableResDict.table_res.html = tableResDict.table_res.html ?? "";
          }
        } finally {
          if (tableResDict.table_img === tableResDict.rect_table_img) {
            deleteMat(tableResDict.table_img);
          } else {
            deleteMat(tableResDict.table_img);
            deleteMat(tableResDict.rect_table_img);
          }
          tableResDict.table_img = null;
          tableResDict.rect_table_img = null;
        }
        done++;
        if (done % 5 === 0) console.info(`[BatchAnalyze] Table Predict ${done}/${total}`);
        if (done % 2 === 0) await yieldToBrowser();
      }
    }
  }

  async _runSealOcr(npImages, imagesLayoutRes) {
    const sealOcrItems = [];
    for (let index = 0; index < npImages.length; index++) {
      const npImg = npImages[index];
      for (const layoutRe of imagesLayoutRes[index]) {
        if (layoutRe.original_label === "seal") {
          const { newImage: sealImg } = cropImg(layoutRe, npImg);
          sealOcrItems.push([sealImg, layoutRe]);
        }
      }
    }

    if (!sealOcrItems.length) return;

    let sealOcrModel = null;
    try {
      if (this.useCustomOcr && typeof this.model.ocrModel?.batchPredict === "function") {
        const sealTexts = await this.model.ocrModel.batchPredict(
          sealOcrItems.map(([img]) => img),
          { is_seal: true, isSeal: true }
        );
        for (let i = 0; i < sealOcrItems.length; i++) {
          const [, layoutRe] = sealOcrItems[i];
          layoutRe.text = String(sealTexts?.[i] ?? "").split("\n").filter(Boolean);
        }
        return;
      }

      const atomModelManager = AtomModelSingleton.getInstance();
      sealOcrModel = await atomModelManager.getAtomModel(AtomicModel.OCR, {
        is_seal: true,
        ocr_config: this.ocrConfig,
      });
      for (const [sealCropBgr, layoutRe] of sealOcrItems) {
        const sealOcrRes = await sealOcrModel.ocr(sealCropBgr, { det: true, rec: true });
        const pairs = Array.isArray(sealOcrRes?.[0]) ? sealOcrRes[0] : [];
        const sealTexts = [];
        for (const sealItem of pairs) {
          const recResult = sealItem?.[1];
          const recText = Array.isArray(recResult) ? recResult[0] : "";
          if (recText) sealTexts.push(recText);
        }
        if (sealTexts.length) layoutRe.text = sealTexts;
      }
    } finally {
      for (const [sealImg] of sealOcrItems) {
        if (sealImg && typeof sealImg.delete === "function" && !sealImg.isDeleted?.()) sealImg.delete();
      }
    }
  }
}

function formatPipelineError(err) {
  if (err instanceof Error) return err.stack || err.message;
  if (typeof err === "number") return `native runtime error code ${err}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
