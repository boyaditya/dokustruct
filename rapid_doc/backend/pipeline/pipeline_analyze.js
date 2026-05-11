// Copyright (c) RapidAI. All rights reserved.
/**
 * PORTING NOTE: pipeline_analyze.py → pipeline_analyze.js
 *
 * WORKAROUND: os.environ overrides, PIL image loading, CPU/GPU device selection
 * REASON: No OS environment, no GPU VRAM detection in browser
 * SOLUTION: Device defaults to 'wasm'; batchRatio fixed (no VRAM detection);
 *           PIL Images replaced with ImageBitmap/ArrayBuffer; fetch-based PDF loading.
 *
 * WORKAROUND: ModelSingleton._models (Python class-level dict)
 * SOLUTION: W6 static #instance Map pattern (mirrors model_init.js)
 *
 * AFFECTED METHODS:
 *   ModelSingleton.get_model → async getModel()
 *   custom_model_init → async customModelInit()
 *   doc_analyze → async docAnalyze()
 *   batch_image_analyze → async batchImageAnalyze()
 */

import { MineruPipelineModel } from "./model_init.js";
import { convertPdfBytesToBytesByPypdfium2 } from "../../cli/common.js";
import { PDFDocument } from "pdf-lib";
import { getDevice } from "../../utils/config_reader.js";
import { ImageType } from "../../utils/enum_class.js";
import { makeHashable } from "../../utils/hash_utils.js";
import { classify } from "../../utils/pdf_classify.js";
import { loadImagesFromPdf, getOriImage } from "../../utils/pdf_image_tools.js";
import { getVram, cleanMemory } from "../../utils/model_utils.js";
import { getPage } from "../../utils/pdf_text_tool.js";

// ---------------------------------------------------------------------------
// ModelSingleton — W6 pattern
// ---------------------------------------------------------------------------

/**
 * Singleton model cache.
 * PORTING NOTE: ModelSingleton(Python) → JS W6 static #instance
 */
export class ModelSingleton {
  static #instance = null;
  #models = new Map();

  static getInstance() {
    if (!ModelSingleton.#instance) {
      ModelSingleton.#instance = new ModelSingleton();
    }
    return ModelSingleton.#instance;
  }

  /**
   * Get or lazily create a MineruPipelineModel.
   * PORTING NOTE: get_model(...) → async getModel(...)
   * @param {object} opts
   * @returns {Promise<MineruPipelineModel>}
   */
  async getModel({
    lang = null,
    formula_enable = null,
    table_enable = null,
    layout_config = null,
    ocr_config = null,
    formula_config = null,
    table_config = null,
  } = {}) {
    const key = JSON.stringify([
      lang, formula_enable, table_enable,
      makeHashable(layout_config),
      makeHashable(ocr_config),
      makeHashable(formula_config),
      makeHashable(table_config),
    ]);

    if (!this.#models.has(key)) {
      const model = await customModelInit({
        lang, formula_enable, table_enable,
        layout_config, ocr_config, formula_config, table_config,
      });
      this.#models.set(key, model);
    }
    return this.#models.get(key);
  }
}

// ---------------------------------------------------------------------------
// customModelInit
// ---------------------------------------------------------------------------

/**
 * Build and return a MineruPipelineModel.
 * PORTING NOTE: custom_model_init(...) → async customModelInit(...)
 * @param {object} opts
 * @returns {Promise<MineruPipelineModel>}
 */
export async function customModelInit({
  lang = null,
  formula_enable = true,
  table_enable = true,
  layout_config = null,
  ocr_config = null,
  formula_config = null,
  table_config = null,
} = {}) {
  const t0 = performance.now();

  const device = getDevice();

  const finalFormulaConfig = { enable: formula_enable, ...(formula_config || {}) };
  const finalTableConfig = { enable: table_enable, ...(table_config || {}) };

  const modelInput = {
    device,
    layout_config,
    ocr_config,
    table_config: finalTableConfig,
    formula_config: finalFormulaConfig,
    lang,
  };

  const customModel = await MineruPipelineModel.create(modelInput);

  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
  console.info(`[customModelInit] model init cost: ${elapsed}s`);
  return customModel;
}

// ---------------------------------------------------------------------------
// doc_analyze
// ---------------------------------------------------------------------------

/**
 * Analyze one or more PDF documents.
 * PORTING NOTE: doc_analyze(pdf_bytes_list, ...) → async docAnalyze(...)
 *
 * @param {(Uint8Array|ArrayBuffer|{pdf_bytes: Uint8Array, original_image?: any})[]} pdfBytesList
 * @param {object} [opts]
 * @param {number} [opts.start_page_id=0]
 * @param {number|null} [opts.end_page_id=null]
 * @returns {Promise<[object[][], object[][], object[][], string[], boolean[]]>}
 *   [infer_results, all_image_lists, all_pdf_docs, lang_list, ocr_enabled_list]
 */
export async function docAnalyze(
  pdfBytesList,
  {
    lang_list = null,
    parse_method = 'auto',
    formula_enable = true,
    table_enable = true,
    layout_config = null,
    ocr_config = null,
    formula_config = null,
    table_config = null,
    checkbox_config = null,
    start_page_id = 0,
    end_page_id = null,
  } = {}
) {
  const pipelineTimings = {
    layout: 0,
    formula: 0,
    ocr: 0,
    table: 0,
    reading_order: 0,
    postprocessing: 0,
  };
  // -------- Normalize input --------
  const normalizedPdfBytesList = [];
  const contains_dict = pdfBytesList.some(item => item !== null && typeof item === 'object' && 'pdf_bytes' in item);

  if (contains_dict) {
    for (let idx = 0; idx < pdfBytesList.length; idx++) {
      const item = pdfBytesList[idx];
      if (item !== null && typeof item === 'object' && 'pdf_bytes' in item) {
        normalizedPdfBytesList.push(item.pdf_bytes);
      } else {
        normalizedPdfBytesList.push(item);
      }
    }
  } else {
    normalizedPdfBytesList.push(...pdfBytesList);
  }

  for (let i = 0; i < normalizedPdfBytesList.length; i++) {
    if (isImageBytes(normalizedPdfBytesList[i])) {
      normalizedPdfBytesList[i] = await imageBytesToPdfBytes(normalizedPdfBytesList[i]);
    }
  }

  // Apply page slicing if requested (Python parity: pre-slice PDF bytes)
  const hasPageSlice = Number(start_page_id || 0) > 0 || end_page_id != null;
  if (hasPageSlice) {
    const sliced = [];
    for (const pdfBytes of normalizedPdfBytesList) {
      try {
        const outBytes = await convertPdfBytesToBytesByPypdfium2(pdfBytes, start_page_id, end_page_id);
        sliced.push(outBytes);
      } catch (e) {
        console.warn(`[docAnalyze] page slice failed, using original bytes: ${e}`);
        sliced.push(pdfBytes);
      }
    }
    pdfBytesList = sliced;
  } else {
    pdfBytesList = normalizedPdfBytesList;
  }

  if (!lang_list) lang_list = new Array(pdfBytesList.length).fill('ch');

  const minBatchInferenceSize = 384; // browser default (no env var)

  const allPagesInfo = []; // (pdf_idx, page_idx, img, scale, ocr_enable, lang)
  const allImageLists = [];
  const allPdfDocs = [];
  const ocrEnabledList = [];

  for (let pdfIdx = 0; pdfIdx < pdfBytesList.length; pdfIdx++) {
    const pdfBytes = pdfBytesList[pdfIdx];

    let _ocrEnable = false;
    if (parse_method === 'auto') {
      if (await classify(pdfBytes) === 'ocr') _ocrEnable = true;
    } else if (parse_method === 'ocr') {
      _ocrEnable = true;
    }
    ocrEnabledList.push(_ocrEnable);

    const _lang = lang_list[pdfIdx];
    let imagesList, pdfDocProxy;

    [imagesList, pdfDocProxy] = await loadImagesFromPdf(pdfBytes, { imageType: ImageType.PIL });
    allImageLists.push(imagesList);

    // Iterate each page of the PDF document proxy (mirrors Python: for pdf_page in pdf_doc)
    const allPdfDict = [];
    const numPages = pdfDocProxy.numPages;
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDocProxy.getPage(pageNum);
      const pageDict = await getPage(page);
      if (pageDict.blocks?.length) {
        pageDict.ori_image_list = await getOriImage(page);
      } else {
        pageDict.ori_image_list = [];
      }
      allPdfDict.push(pageDict);
    }
    await pdfDocProxy.cleanup?.();
    allPdfDocs.push(allPdfDict);

    for (let pageIdx = 0; pageIdx < imagesList.length; pageIdx++) {
      const imgDict = imagesList[pageIdx];
      allPagesInfo.push([pdfIdx, pageIdx, imgDict.img_pil, imgDict.scale, _ocrEnable, _lang]);
    }
  }

  // -------- Batch processing --------
  const imagesWithExtraInfo = allPagesInfo.map(info =>
    [info[2], info[3], info[4], info[5], allPdfDocs[info[0]][info[1]]]
  );

  const batchSize = minBatchInferenceSize;
  const batchImages = [];
  for (let i = 0; i < imagesWithExtraInfo.length; i += batchSize) {
    batchImages.push(imagesWithExtraInfo.slice(i, i + batchSize));
  }

  const results = [];
  let processedCount = 0;
  for (let index = 0; index < batchImages.length; index++) {
    const batchImage = batchImages[index];
    const batchLang = batchImage[0]?.[3] ?? 'ch';
    processedCount += batchImage.length;
    console.info(
      `[docAnalyze] Batch ${index + 1}/${batchImages.length}: ` +
      `${processedCount}/${imagesWithExtraInfo.length} pages`
    );
    const batchResults = await batchImageAnalyze(batchImage, {
      lang: batchLang,
      formula_enable, table_enable, layout_config, ocr_config,
      formula_config, table_config, checkbox_config,
    });
    results.push(...batchResults);

    const batchTimings = batchResults?._stageTimings;
    if (batchTimings && typeof batchTimings === 'object') {
      pipelineTimings.layout += Number(batchTimings.layout || 0);
      pipelineTimings.formula += Number(batchTimings.formula || 0);
      pipelineTimings.ocr += Number(batchTimings.ocr || 0);
      pipelineTimings.table += Number(batchTimings.table || 0);
      pipelineTimings.reading_order += Number(batchTimings.reading_order || 0);
      pipelineTimings.postprocessing += Number(batchTimings.postprocessing || 0);
    }
  }

  // -------- Build return value --------
  const inferResults = pdfBytesList.map(() => []);

  for (let i = 0; i < allPagesInfo.length; i++) {
    const [pdfIdx, pageIdx, pilImg] = allPagesInfo[i];
    const result = results[i];
    const pageInfoDict = { page_no: pageIdx, width: pilImg.width, height: pilImg.height };
    const pageDict = { layout_dets: result, page_info: pageInfoDict };
    inferResults[pdfIdx].push(pageDict);
  }

  return [inferResults, allImageLists, allPdfDocs, lang_list, ocrEnabledList, pipelineTimings];
}

// ---------------------------------------------------------------------------
// batch_image_analyze
// ---------------------------------------------------------------------------

/**
 * Run a single batch through BatchAnalyze.
 * PORTING NOTE: batch_image_analyze(...) → async batchImageAnalyze(...)
 *
 * @param {Array<[any, number, boolean, string, object]>} imagesWithExtraInfo
 * @param {object} [opts]
 * @returns {Promise<object[][]>}
 */
export async function batchImageAnalyze(
  imagesWithExtraInfo,
  {
    lang = null,
    formula_enable = true,
    table_enable = true,
    layout_config = null,
    ocr_config = null,
    formula_config = null,
    table_config = null,
    checkbox_config = null,
  } = {}
) {
  const { BatchAnalyze } = await import("./batch_analyze.js");

  const modelManager = ModelSingleton.getInstance();

  // In browser there's no GPU VRAM detection — use batch_ratio = 1
  const batchRatio = 1;

  const batchModel = new BatchAnalyze(
    modelManager, batchRatio,
    formula_enable, table_enable,
    layout_config, ocr_config, formula_config, table_config, checkbox_config
  );
  batchModel.lang = lang;

  const results = await batchModel.call(imagesWithExtraInfo);
  results._stageTimings = { ...(batchModel.lastStageTimings || {}) };

  const device = getDevice();
  cleanMemory(device);

  return results;
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Detect image byte streams that must be normalized to PDF before analysis.
 */
function isImageBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return (
    (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) ||
    (b[0] === 0xFF && b[1] === 0xD8) ||
    (b[0] === 0x42 && b[1] === 0x4D) ||
    (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) ||
    (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00) ||
    (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A)
  );
}

async function imageBytesToPdfBytes(bytes) {
  const srcBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const bitmap = await createImageBitmap(new Blob([srcBytes]));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
    const pdfDoc = await PDFDocument.create();
    const embedded = await pdfDoc.embedPng(pngBytes);
    const page = pdfDoc.addPage([bitmap.width, bitmap.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: bitmap.width, height: bitmap.height });
    return await pdfDoc.save();
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}
