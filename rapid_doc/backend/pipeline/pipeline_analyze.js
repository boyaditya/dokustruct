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

import { AtomModelSingleton, MineruPipelineModel } from "./model_init.js";
import { convertPdfBytesToBytesByPypdfium2 } from "../../cli/common.js";
import { PDFDocument } from "pdf-lib";
import { getDevice } from "../../utils/config_reader.js";
import { ImageType } from "../../utils/enum_class.js";
import { makeHashable } from "../../utils/hash_utils.js";
import { classify } from "../../utils/pdf_classify.js";
import { loadImagesFromPdf, getOriImage } from "../../utils/pdf_image_tools.js";
import { getVram, cleanMemory, getBatchRatio, initVramDetection } from "../../utils/model_utils.js";
import { getPage } from "../../utils/pdf_text_tool.js";
import { AtomicModel } from "./model_list.js";

const PDF_IMAGE_DPI = 200;
const PDF_POINTS_PER_INCH = 72;

async function yieldToBrowser() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function destroyPdfProxy(pdfDocProxy) {
  if (!pdfDocProxy) return;
  try { await pdfDocProxy.cleanup?.(); } catch { /* ignore */ }
  try { await pdfDocProxy.destroy?.(); } catch { /* ignore */ }
}

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
  #activeKey = null;

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
    orientation_config = null,
  } = {}) {
    const key = ModelSingleton.makeKey({
      lang,
      formula_enable,
      table_enable,
      layout_config,
      ocr_config,
      formula_config,
      table_config,
      orientation_config,
    });

    if (!this.#models.has(key)) {
      const model = await customModelInit({
        lang, formula_enable, table_enable,
        layout_config, ocr_config, formula_config, table_config, orientation_config,
      });
      this.#models.set(key, model);
    }
    if (this.#activeKey !== null && this.#activeKey !== key) {
      await this.clear(key);
    }
    this.#activeKey = key;
    await AtomModelSingleton.getInstance().retainKeys(ModelSingleton.makeAtomKeySet({
      lang, formula_enable, table_enable, layout_config, ocr_config, formula_config, table_config, orientation_config,
    }));
    return this.#models.get(key);
  }

  static makeKey({
    lang = null,
    formula_enable = null,
    table_enable = null,
    layout_config = null,
    ocr_config = null,
    formula_config = null,
    table_config = null,
    orientation_config = null,
  } = {}) {
    return JSON.stringify([
      lang, formula_enable, table_enable,
      makeHashable(layout_config),
      makeHashable(ocr_config),
      makeHashable(formula_config),
      makeHashable(table_config),
      makeHashable(orientation_config),
    ]);
  }

  async clear(keepKey = null) {
    for (const [key, value] of this.#models.entries()) {
      if (keepKey !== null && key === keepKey) continue;
      this.#models.delete(key);
      try {
        await (await value)?.dispose?.();
      } catch (err) {
        console.warn("[ModelSingleton] failed to dispose model:", err?.message ?? err);
      }
    }
    if (keepKey === null || this.#activeKey !== keepKey) this.#activeKey = keepKey;
    if (keepKey === null) {
      await AtomModelSingleton.getInstance().clear();
    }
    cleanMemory();
  }

  async clearByConfig(config = null) {
    const keepKey = config ? ModelSingleton.makeKey(config) : null;
    await this.clear(keepKey);
  }

  async dispose() {
    await this.clear();
  }

  static makeAtomKeySet({
    lang = null,
    formula_enable = true,
    table_enable = true,
    layout_config = null,
    ocr_config = null,
    formula_config = null,
    table_config = null,
    orientation_config = null,
  } = {}) {
    const finalFormulaConfig = { enable: formula_enable, ...(formula_config || {}) };
    const finalTableConfig = { enable: table_enable, ...(table_config || {}) };
    const ocrDetDbThresh = ocr_config?.["Det.det_db_thresh"] ?? ocr_config?.det_db_thresh ?? 0.3;
    const keep = new Set();
    keep.add(AtomModelSingleton.buildKey(AtomicModel.Layout, { layout_config }));
    keep.add(AtomModelSingleton.buildKey(AtomicModel.OCR, {
      det_db_thresh: ocrDetDbThresh,
      det_db_box_thresh: 0.3,
      lang,
      ocr_config,
    }));
    if (finalFormulaConfig.enable) {
      keep.add(AtomModelSingleton.buildKey(AtomicModel.FORMULA, { formula_config: finalFormulaConfig }));
    }
    if (finalTableConfig.enable) {
      const ocrConfigClean = ocr_config ? { ...ocr_config } : null;
      if (ocrConfigClean) delete ocrConfigClean.custom_model;
      keep.add(AtomModelSingleton.buildKey(AtomicModel.Table, {
        lang,
        ocr_config: ocrConfigClean,
        table_config: finalTableConfig,
      }));
      keep.add(AtomModelSingleton.buildKey(AtomicModel.OCR, {
        det_db_thresh: ocrConfigClean?.["Det.det_db_thresh"] ?? ocrConfigClean?.det_db_thresh ?? 0.3,
        det_db_box_thresh: 0.5,
        det_db_unclip_ratio: 1.6,
        lang,
        ocr_config: ocrConfigClean,
        enable_merge_det_boxes: false,
      }));
    }
    if (layout_config?.use_doc_orientation_classify ?? layout_config?.useDocOrientationClassify ?? true) {
      keep.add(AtomModelSingleton.buildKey(AtomicModel.ImgOrientationCls, { orientation_config }));
    }
    return keep;
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
  orientation_config = null,
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
    orientation_config,
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
 * @param {number} [opts.pdf_pages_batch=0] - If >0, process PDF in windows of N pages
 * @returns {Promise<[object[][], object[][], object[][], string[], boolean[]]>}
 *   [infer_results, all_image_lists, all_pdf_docs, lang_list, ocr_enabled_list]
 */
export async function docAnalyze(
  pdfBytesList,
  {
    lang_list = null,
    parse_method = 'auto',
    force_ocr = false,
    formula_enable = true,
    table_enable = true,
    layout_config = null,
    ocr_config = null,
    formula_config = null,
    table_config = null,
    orientation_config = null,
    checkbox_config = null,
    start_page_id = 0,
    end_page_id = null,
    pdf_pages_batch = 0,
    on_progress = null,
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

  // -------- pdf_pages_batch windowing --------
  // If pdf_pages_batch > 0, process each PDF in windows of N pages (Python parity).
  // This prevents OOM on large PDFs by only loading N pages at a time.
  if (pdf_pages_batch > 0) {
    return await _docAnalyzeWindowed(normalizedPdfBytesList, {
      lang_list, parse_method, formula_enable, table_enable,
      force_ocr, layout_config, ocr_config, formula_config, table_config, orientation_config, checkbox_config,
      start_page_id, end_page_id, pdf_pages_batch, on_progress,
    });
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
    if (force_ocr || parse_method === 'ocr') {
      _ocrEnable = true;
    } else if (parse_method === 'auto') {
      if (await classify(pdfBytes) === 'ocr') _ocrEnable = true;
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
      if (pageNum % 2 === 0) await yieldToBrowser();
    }
    await destroyPdfProxy(pdfDocProxy);
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
    on_progress?.(processedCount, imagesWithExtraInfo.length);
    console.info(
      `[docAnalyze] Batch ${index + 1}/${batchImages.length}: ` +
      `${processedCount}/${imagesWithExtraInfo.length} pages`
    );
    const batchResults = await batchImageAnalyze(batchImage, {
      lang: batchLang,
      formula_enable, table_enable, layout_config, ocr_config,
      formula_config, table_config, orientation_config, checkbox_config,
    });
    results.push(...batchResults);
    await yieldToBrowser();

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
// Windowed PDF processing (pdf_pages_batch)
// ---------------------------------------------------------------------------

/**
 * Process PDFs in windows of N pages to avoid OOM on large documents.
 * PORTING NOTE: Python _parse_pipeline_batch while-loop → async _docAnalyzeWindowed
 *
 * @param {Uint8Array[]} pdfBytesList
 * @param {object} opts
 * @returns {Promise<[object[][], object[][], object[][], string[], boolean[], object]>}
 */
async function _docAnalyzeWindowed(pdfBytesList, opts) {
  const {
    lang_list: langListOpt, parse_method, force_ocr, formula_enable, table_enable,
    layout_config, ocr_config, formula_config, table_config, orientation_config, checkbox_config,
    start_page_id, end_page_id, pdf_pages_batch,
    on_progress,
  } = opts;

  const langList = langListOpt || new Array(pdfBytesList.length).fill('ch');
  const pipelineTimings = { layout: 0, formula: 0, ocr: 0, table: 0, reading_order: 0, postprocessing: 0 };

  // Pre-slice each PDF to the requested page range
  const slicedPdfBytesList = [];
  for (const pdfBytes of pdfBytesList) {
    try {
      const sliced = await convertPdfBytesToBytesByPypdfium2(pdfBytes, start_page_id, end_page_id);
      slicedPdfBytesList.push(sliced);
    } catch {
      slicedPdfBytesList.push(pdfBytes);
    }
  }

  // Accumulate results per PDF
  const allInferResults = pdfBytesList.map(() => []);
  const allImageListsAccum = pdfBytesList.map(() => []);
  const allPdfDocsAccum = pdfBytesList.map(() => []);
  const ocrEnabledList = [];

  // Track which PDFs are finished
  const finished = new Array(pdfBytesList.length).fill(false);
  let tmpStartPageId = 0;
  let batchIdx = 0;

  while (!finished.every(Boolean)) {
    const activeIndexes = finished.map((f, i) => f ? -1 : i).filter(i => i >= 0);
    const activePdfBytes = activeIndexes.map(i => slicedPdfBytesList[i]);
    const activeLangList = activeIndexes.map(i => langList[i]);

    // Process this window
    const [inferResults, allImageLists, allPdfDocs, finalLangList, ocrEnabled, windowTimings] =
      await _docAnalyzeSingleWindow(activePdfBytes, {
        lang_list: activeLangList,
        parse_method, formula_enable, table_enable,
        force_ocr, layout_config, ocr_config, formula_config, table_config, orientation_config, checkbox_config,
        start_page_id: tmpStartPageId,
        end_page_id: tmpStartPageId + pdf_pages_batch - 1,
        on_progress,
      });

    // Accumulate timings
    if (windowTimings && typeof windowTimings === 'object') {
      for (const k of Object.keys(pipelineTimings)) {
        pipelineTimings[k] += Number(windowTimings[k] || 0);
      }
    }

    // Merge results
    for (let ai = 0; ai < activeIndexes.length; ai++) {
      const origIdx = activeIndexes[ai];
      const pageResults = inferResults[ai] || [];
      allInferResults[origIdx].push(...pageResults);
      allImageListsAccum[origIdx].push(...(allImageLists[ai] || []));
      allPdfDocsAccum[origIdx].push(...(allPdfDocs[ai] || []));

      if (batchIdx === 0 && ocrEnabled[ai] !== undefined) {
        ocrEnabledList[origIdx] = ocrEnabled[ai];
      }

      // Check if this PDF is done (fewer pages returned than window size)
      const pagesReturned = pageResults.length;
      if (pagesReturned < pdf_pages_batch) {
        finished[origIdx] = true;
      }
    }

    tmpStartPageId += pdf_pages_batch;
    batchIdx++;

    // Safety: if no pages returned for any active PDF, mark all as done
    const totalPagesReturned = activeIndexes.reduce((sum, _, ai) => sum + (inferResults[ai]?.length || 0), 0);
    if (totalPagesReturned === 0) break;
    await yieldToBrowser();
  }

  return [allInferResults, allImageListsAccum, allPdfDocsAccum, langList, ocrEnabledList, pipelineTimings];
}

/**
 * Process a single window of pages from PDFs.
 * @returns {Promise<[object[][], object[][], object[][], string[], boolean[], object]>}
 */
async function _docAnalyzeSingleWindow(pdfBytesList, opts) {
  const {
    lang_list, parse_method, force_ocr, formula_enable, table_enable,
    layout_config, ocr_config, formula_config, table_config, orientation_config, checkbox_config,
    start_page_id = 0, end_page_id = null,
    on_progress = null,
  } = opts;

  const pipelineTimings = { layout: 0, formula: 0, ocr: 0, table: 0, reading_order: 0, postprocessing: 0 };
  const langList = lang_list || new Array(pdfBytesList.length).fill('ch');

  // Slice pages for this window
  const slicedList = [];
  for (const pdfBytes of pdfBytesList) {
    try {
      const sliced = await convertPdfBytesToBytesByPypdfium2(pdfBytes, start_page_id, end_page_id);
      slicedList.push(sliced);
    } catch {
      slicedList.push(pdfBytes);
    }
  }

  const allPagesInfo = [];
  const allImageLists = [];
  const allPdfDocs = [];
  const ocrEnabledList = [];

  for (let pdfIdx = 0; pdfIdx < slicedList.length; pdfIdx++) {
    const pdfBytes = slicedList[pdfIdx];

    let _ocrEnable = false;
    if (force_ocr || parse_method === 'ocr') {
      _ocrEnable = true;
    } else if (parse_method === 'auto') {
      if (await classify(pdfBytes) === 'ocr') _ocrEnable = true;
    }
    ocrEnabledList.push(_ocrEnable);

    const _lang = langList[pdfIdx];
    const [imagesList, pdfDocProxy] = await loadImagesFromPdf(pdfBytes, { imageType: ImageType.PIL });
    allImageLists.push(imagesList);

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
      if (pageNum % 2 === 0) await yieldToBrowser();
    }
    await destroyPdfProxy(pdfDocProxy);
    allPdfDocs.push(allPdfDict);

    for (let pageIdx = 0; pageIdx < imagesList.length; pageIdx++) {
      const imgDict = imagesList[pageIdx];
      allPagesInfo.push([pdfIdx, pageIdx, imgDict.img_pil, imgDict.scale, _ocrEnable, _lang]);
    }
  }

  if (!allPagesInfo.length) {
    return [pdfBytesList.map(() => []), allImageLists, allPdfDocs, langList, ocrEnabledList, pipelineTimings];
  }

  const imagesWithExtraInfo = allPagesInfo.map(info =>
    [info[2], info[3], info[4], info[5], allPdfDocs[info[0]][info[1]]]
  );

  const batchResults = await batchImageAnalyze(imagesWithExtraInfo, {
    lang: imagesWithExtraInfo[0]?.[3] ?? langList[0] ?? 'ch',
    formula_enable, table_enable, layout_config, ocr_config,
    formula_config, table_config, orientation_config, checkbox_config,
  });
  on_progress?.(imagesWithExtraInfo.length, imagesWithExtraInfo.length);
  await yieldToBrowser();

  const batchTimings = batchResults?._stageTimings;
  if (batchTimings) {
    for (const k of Object.keys(pipelineTimings)) {
      pipelineTimings[k] += Number(batchTimings[k] || 0);
    }
  }

  const inferResults = pdfBytesList.map(() => []);
  for (let i = 0; i < allPagesInfo.length; i++) {
    const [pdfIdx, pageIdx, pilImg] = allPagesInfo[i];
    const result = batchResults[i];
    const pageInfoDict = { page_no: pageIdx, width: pilImg.width, height: pilImg.height };
    inferResults[pdfIdx].push({ layout_dets: result, page_info: pageInfoDict });
  }

  return [inferResults, allImageLists, allPdfDocs, langList, ocrEnabledList, pipelineTimings];
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
    orientation_config = null,
    checkbox_config = null,
  } = {}
) {
  const { BatchAnalyze } = await import("./batch_analyze.js");

  const modelManager = ModelSingleton.getInstance();
  await initVramDetection();

  // Use WebGPU VRAM detection for batch ratio (mirrors Python CUDA VRAM logic)
  const batchRatio = getBatchRatio();

  const batchModel = new BatchAnalyze(
    modelManager, batchRatio,
    formula_enable, table_enable,
    layout_config, ocr_config, formula_config, table_config, checkbox_config, orientation_config
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
    const pageWidth = bitmap.width * PDF_POINTS_PER_INCH / PDF_IMAGE_DPI;
    const pageHeight = bitmap.height * PDF_POINTS_PER_INCH / PDF_IMAGE_DPI;
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    page.drawImage(embedded, { x: 0, y: 0, width: pageWidth, height: pageHeight });
    return await pdfDoc.save();
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}
