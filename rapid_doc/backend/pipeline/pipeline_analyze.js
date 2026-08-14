// Copyright (c) RapidAI. All rights reserved.
/**
 * Pipeline entry point for document analysis.
 *
 * Browser-specific workarounds:
 * - No OS environment, no GPU VRAM detection — device defaults to 'wasm'
 * - PIL Images replaced with ImageBitmap/ArrayBuffer; fetch-based PDF loading
 * - ModelSingleton uses static #instance Map pattern (mirrors model_init.js)
 */

import { AtomModelSingleton, MineruPipelineModel } from "./model_init.js";
import { convertPdfBytesToBytesByPypdfium2 } from "../../cli/common.js";
import { PDFDocument } from "pdf-lib";
import { getDevice } from "../../utils/config_reader.js";
import { ImageType } from "../../utils/enum_class.js";
import { AbortException } from "../../utils/exceptions.js";
import { makeHashable } from "../../utils/hash_utils.js";
import { classify } from "../../utils/pdf_classify.js";
import { loadImagesFromPdf, getOriImage } from "../../utils/pdf_image_tools.js";
import { cleanMemory } from "../../utils/model_utils.js";
import { getPage } from "../../utils/pdf_text_tool.js";
import { AtomicModel } from "./model_list.js";
import { yieldToBrowser, formatPipelineError } from "../../utils/browser_utils.js";
import { releaseImageBitmap, releaseCanvas } from "../../utils/resource_utils.js";
import { resultToMiddleJson } from "./model_json_to_middle_json.js";
import { unionMake } from "./pipeline_middle_json_mkcontent.js";
import { paraSplit } from "./para_split.js";
import { crossPageTableMerge } from "../utils/utils.js";
import { MemoryDataWriter } from "../../data/data_reader_writer/index.js";

const PDF_IMAGE_DPI = 200;
const PDF_POINTS_PER_INCH = 72;
const MIN_BATCH_INFERENCE_SIZE = 384;

async function destroyPdfProxy(pdfDocProxy) {
  if (!pdfDocProxy) return;
  try { await pdfDocProxy.cleanup?.(); } catch { /* ignore */ }
  try { await pdfDocProxy.destroy?.(); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// ModelSingleton — W6 pattern
// ---------------------------------------------------------------------------

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
      lang, formula_enable, table_enable,
      layout_config, ocr_config, formula_config, table_config, orientation_config,
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
      lang, formula_enable, table_enable,
      layout_config, ocr_config, formula_config, table_config, orientation_config,
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
        if (err instanceof AbortException) throw err;
        console.warn(formatPipelineError({
          stage: 'dispose',
          module: 'ModelSingleton',
          message: err?.message ?? String(err),
          recoverable: true,
        }));
      }
    }
    if (keepKey === null || this.#activeKey !== keepKey) this.#activeKey = keepKey;
    if (keepKey === null) {
      await AtomModelSingleton.getInstance().clear();
    }
    // Light-weight GC trigger; full GPU drain happens in engineReset().
    await cleanMemory();
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
// docAnalyze
// ---------------------------------------------------------------------------

/**
 * Analyze one or more PDF documents.
 *
 * @param {(Uint8Array|ArrayBuffer|{pdf_bytes: Uint8Array})[]} pdfBytesList
 * @param {object} [opts]
 * @returns {Promise<[object[][], object[][], object[][], string[], boolean[], object]>}
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
    on_window_result = null,
  } = {}
) {
  const normalizedPdfBytesList = await _normalizeInputBytes(pdfBytesList);

  // Windowed processing for large PDFs
  if (pdf_pages_batch > 0) {
    console.log(`[docAnalyze] Windowed mode — pdf_pages_batch=${pdf_pages_batch}, pages=${normalizedPdfBytesList.length} PDF(s), has on_window_result=${!!on_window_result}`);
    return await _docAnalyzeWindowed(normalizedPdfBytesList, {
      lang_list, parse_method, formula_enable, table_enable,
      force_ocr, layout_config, ocr_config, formula_config, table_config,
      orientation_config, checkbox_config,
      start_page_id, end_page_id, pdf_pages_batch, on_progress, on_window_result,
    });
  }

  // Apply page slicing if requested
  const slicedPdfBytesList = await _slicePdfPages(normalizedPdfBytesList, start_page_id, end_page_id);

  if (!lang_list) lang_list = new Array(slicedPdfBytesList.length).fill('ch');

  const tPdfLoad0 = performance.now();
  const { allPagesInfo, allImageLists, allPdfDocs, ocrEnabledList } = await _loadAllPdfPages(
    slicedPdfBytesList, lang_list, parse_method, force_ocr
  );
  const pdfLoadMs = performance.now() - tPdfLoad0;

  // Build batch input
  const imagesWithExtraInfo = allPagesInfo.map(info =>
    [info[2], info[3], info[4], info[5], allPdfDocs[info[0]][info[1]]]
  );

  const results = await _runBatchProcessing(imagesWithExtraInfo, {
    lang_list, formula_enable, table_enable, layout_config, ocr_config,
    formula_config, table_config, orientation_config, checkbox_config, on_progress,
  });

  // Non-windowed path: the shared tracker no longer fires its own 100%
  // event (the caller owns the final signal), so emit it here.
  if (on_progress) {
    on_progress('complete', 1, 1, 100);
  }

  // Build return value
  const pipelineTimings = results.timings;
  pipelineTimings.pdf_load = (pipelineTimings.pdf_load || 0) + pdfLoadMs;
  const inferResults = _buildInferResults(slicedPdfBytesList, allPagesInfo, results.pageResults);

  return [inferResults, allImageLists, allPdfDocs, lang_list, ocrEnabledList, pipelineTimings];
}

// ---------------------------------------------------------------------------
// docAnalyze sub-functions
// ---------------------------------------------------------------------------

/**
 * Normalize input: extract pdf_bytes from dict entries, convert images to PDF.
 */
async function _normalizeInputBytes(pdfBytesList) {
  const normalized = [];
  const containsDict = pdfBytesList.some(
    item => item !== null && typeof item === 'object' && 'pdf_bytes' in item
  );

  for (const item of pdfBytesList) {
    if (containsDict && item !== null && typeof item === 'object' && 'pdf_bytes' in item) {
      normalized.push(item.pdf_bytes);
    } else {
      normalized.push(item);
    }
  }

  for (let i = 0; i < normalized.length; i++) {
    if (isImageBytes(normalized[i])) {
      normalized[i] = await imageBytesToPdfBytes(normalized[i]);
    }
  }

  return normalized;
}

/**
 * Slice PDF pages if start/end page IDs are specified.
 */
async function _slicePdfPages(pdfBytesList, startPageId, endPageId) {
  const hasPageSlice = Number(startPageId || 0) > 0 || endPageId != null;
  if (!hasPageSlice) return pdfBytesList;

  const sliced = [];
  for (const pdfBytes of pdfBytesList) {
    try {
      const outBytes = await convertPdfBytesToBytesByPypdfium2(pdfBytes, startPageId, endPageId);
      sliced.push(outBytes);
    } catch (err) {
      if (err instanceof AbortException) throw err;
      console.warn(formatPipelineError({
        stage: 'page-slice',
        module: 'docAnalyze',
        message: `page slice failed, using original bytes: ${err?.message ?? err}`,
        recoverable: true,
      }));
      sliced.push(pdfBytes);
    }
  }
  return sliced;
}

/**
 * Load all PDF pages: render images, extract text dictionaries.
 */
async function _loadAllPdfPages(pdfBytesList, langList, parseMethod, forceOcr) {
  const allPagesInfo = [];
  const allImageLists = [];
  const allPdfDocs = [];
  const ocrEnabledList = [];

  for (let pdfIdx = 0; pdfIdx < pdfBytesList.length; pdfIdx++) {
    const pdfBytes = pdfBytesList[pdfIdx];

    let ocrEnable = false;
    if (forceOcr || parseMethod === 'ocr') {
      ocrEnable = true;
    } else if (parseMethod === 'auto') {
      if (await classify(pdfBytes) === 'ocr') ocrEnable = true;
    }
    ocrEnabledList.push(ocrEnable);

    const lang = langList[pdfIdx];
    const [imagesList, pdfDocProxy] = await loadImagesFromPdf(pdfBytes, { imageType: ImageType.PIL });
    allImageLists.push(imagesList);

    const allPdfDict = await _extractPdfPageDicts(pdfDocProxy);
    await destroyPdfProxy(pdfDocProxy);
    allPdfDocs.push(allPdfDict);

    for (let pageIdx = 0; pageIdx < imagesList.length; pageIdx++) {
      const imgDict = imagesList[pageIdx];
      allPagesInfo.push([pdfIdx, pageIdx, imgDict.img_pil, imgDict.scale, ocrEnable, lang]);
    }
  }

  return { allPagesInfo, allImageLists, allPdfDocs, ocrEnabledList };
}

/**
 * Extract page dictionaries (text blocks, ori images) from a PDF document proxy.
 */
async function _extractPdfPageDicts(pdfDocProxy) {
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

  return allPdfDict;
}

/**
 * Run batch processing across all pages, accumulating timings.
 */
async function _runBatchProcessing(imagesWithExtraInfo, opts) {
  const {
    lang_list, formula_enable, table_enable, layout_config, ocr_config,
    formula_config, table_config, orientation_config, checkbox_config, on_progress,
  } = opts;

  const pipelineTimings = _newTimings();
  const batchImages = [];
  for (let i = 0; i < imagesWithExtraInfo.length; i += MIN_BATCH_INFERENCE_SIZE) {
    batchImages.push(imagesWithExtraInfo.slice(i, i + MIN_BATCH_INFERENCE_SIZE));
  }

  const allResults = [];
  let processedCount = 0;

  // Create a single ProgressTracker for all batches
  const { ProgressTracker } = await import('./progress_tracker.js');
  const progressTracker = new ProgressTracker(on_progress);
  
  // Pre-calculate total work for ALL batches
  const totalPages = imagesWithExtraInfo.length;
  const hasOrientation = layout_config?.use_doc_orientation_classify ?? layout_config?.useDocOrientationClassify ?? false;
  
  console.log(`[_runBatchProcessing] Creating shared ProgressTracker for ${totalPages} total pages`);
  console.log(`[_runBatchProcessing] hasOrientation=${hasOrientation}, batches=${batchImages.length}`);
  
  progressTracker.initStage('orientation', hasOrientation ? totalPages : 0);
  progressTracker.initStage('layout', totalPages);

  for (let index = 0; index < batchImages.length; index++) {
    const batchImage = batchImages[index];
    const batchLang = batchImage[0]?.[3] ?? lang_list?.[0] ?? 'ch';
    processedCount += batchImage.length;
    console.info(
      `[docAnalyze] Batch ${index + 1}/${batchImages.length}: ` +
      `${processedCount}/${imagesWithExtraInfo.length} pages`
    );

    const batchResults = await batchImageAnalyze(batchImage, {
      lang: batchLang,
      formula_enable, table_enable, layout_config, ocr_config,
      formula_config, table_config, orientation_config, checkbox_config,
      on_stage_progress: on_progress,
      progress_tracker: progressTracker,  // Pass shared tracker
      batch_offset: index * MIN_BATCH_INFERENCE_SIZE,  // Pass offset for accurate counting
    });
    allResults.push(...batchResults);
    await yieldToBrowser();

    _accumulateTimings(pipelineTimings, batchResults?._stageTimings);
  }

  return { pageResults: allResults, timings: pipelineTimings };
}

/**
 * Create a fresh pipeline-timings accumulator (all stages, milliseconds).
 * Keys must match BatchAnalyze.lastStageTimings plus pipeline-level stages
 * (pdf_load) so nothing is silently dropped during accumulation.
 */
function _newTimings() {
  return {
    layout: 0, formula: 0, ocr_det: 0, ocr_rec: 0, table: 0, reading_order: 0,
    orientation: 0, region_collect: 0,
    model_init: 0, pdf_load: 0,
  };
}

/**
 * Accumulate stage timings from a batch result into the pipeline totals.
 */
function _accumulateTimings(pipelineTimings, batchTimings) {
  if (!batchTimings || typeof batchTimings !== 'object') return;
  for (const k of Object.keys(pipelineTimings)) {
    pipelineTimings[k] += Number(batchTimings[k] || 0);
  }
}

/**
 * Build the final inferResults array grouped by PDF index.
 */
function _buildInferResults(pdfBytesList, allPagesInfo, results) {
  const inferResults = pdfBytesList.map(() => []);
  for (let i = 0; i < allPagesInfo.length; i++) {
    const [pdfIdx, pageIdx, pilImg] = allPagesInfo[i];
    const result = results[i];
    const pageInfoDict = { page_no: pageIdx, width: pilImg.width, height: pilImg.height };
    inferResults[pdfIdx].push({ layout_dets: result, page_info: pageInfoDict });
  }
  return inferResults;
}

// ---------------------------------------------------------------------------
// Windowed PDF processing (pdf_pages_batch)
// ---------------------------------------------------------------------------

/**
 * Process PDFs in windows of N pages to avoid OOM on large documents.
 */
async function _docAnalyzeWindowed(pdfBytesList, opts) {
  const {
    lang_list: langListOpt, parse_method, force_ocr, formula_enable, table_enable,
    layout_config, ocr_config, formula_config, table_config, orientation_config, checkbox_config,
    start_page_id, end_page_id, pdf_pages_batch, on_progress, on_window_result,
  } = opts;

  const langList = langListOpt || new Array(pdfBytesList.length).fill('ch');
  const pipelineTimings = _newTimings();

  const slicedPdfBytesList = await _sliceAllPdfsForWindow(pdfBytesList, start_page_id, end_page_id);

  // Count total pages BEFORE entering window loop.
  // Use pdf-lib's metadata-only page count (no rendering) to avoid
  // allocating full OffscreenCanvas backing stores for every page just
  // to count them. On 4GB GPUs, 8 pages × 15 chunks = 120 unretained
  // canvas allocations was enough to exhaust VRAM.
  const { PDFDocument } = await import('pdf-lib');
  let totalPages = 0;
  for (const pdfBytes of slicedPdfBytesList) {
    try {
      const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      totalPages += doc.getPageCount();
    } catch (err) {
      console.warn('[_docAnalyzeWindowed] Failed to count pages:', err);
      totalPages += Math.max(1, Math.floor((pdfBytes.byteLength || pdfBytes.length) / 100000));
    }
  }

  const totalWindows = Math.ceil(totalPages / (pdf_pages_batch || 1));
  // Single-page documents never produce useful page-level progress (one
  // window → one 100% event). Forward per-stage model progress instead so
  // the UI can render a cumulative stage-by-stage bar.
  const singlePageDocument = totalPages <= 1;

  // Per-window accumulation: only compact pdf_info (not raw canvas/inference data)
  const accumulatedPdfInfo = [];
  const imageWriter = new MemoryDataWriter();
  const ocrEnabledList = [];

  // For single-page documents the per-stage events flow through a shared
  // tracker so BatchAnalyze does NOT fire its own premature 'complete'
  // event (resultToMiddleJson + unionMake still run after batch analysis).
  let singlePageTracker = null;
  if (singlePageDocument) {
    const { ProgressTracker } = await import('./progress_tracker.js');
    singlePageTracker = new ProgressTracker(on_progress);
  }

  const finished = new Array(pdfBytesList.length).fill(false);
  let tmpStartPageId = 0;
  let batchIdx = 0;

  // Page-based progress: simple, accurate, understandable
  // (replaces weighted ProgressTracker which gives misleading % on image-heavy PDFs)
  let completedPages = 0;
  const firePageProgress = () => {
    // Single-page documents receive per-stage events instead; a page-level
    // event here would overwrite the cumulative bar with a 100% jump.
    if (on_progress && totalPages > 1) {
      const pct = Math.round((completedPages / totalPages) * 100);
      on_progress('pages', completedPages, totalPages, pct);
    }
  };

  while (!finished.every(Boolean)) {
    const activeIndexes = finished.map((f, i) => f ? -1 : i).filter(i => i >= 0);
    const activePdfBytes = activeIndexes.map(i => slicedPdfBytesList[i]);
    const activeLangList = activeIndexes.map(i => langList[i]);

    const [inferResults, allImageLists, allPdfDocs, , ocrEnabled, windowTimings] =
      await _docAnalyzeSingleWindow(activePdfBytes, {
        lang_list: activeLangList,
        parse_method, formula_enable, table_enable,
        force_ocr, layout_config, ocr_config, formula_config, table_config,
        orientation_config, checkbox_config,
        start_page_id: tmpStartPageId,
        end_page_id: tmpStartPageId + pdf_pages_batch - 1,
        // For single-page documents, the weighted per-stage events carry the
        // real granularity (layout → OCR → formula → table). The page-level
        // firePageProgress() below only ever reports 0% or 100% for them.
        on_progress: singlePageDocument ? on_progress : null,
        progress_tracker: singlePageDocument ? singlePageTracker : null,
      });

    _accumulateTimings(pipelineTimings, windowTimings);

    // ── Per-window conversion to middle JSON (the key fix for memory) ──
    for (let ai = 0; ai < activeIndexes.length; ai++) {
      const origIdx = activeIndexes[ai];
      const modelList = inferResults[ai] || [];
      const imagesList = allImageLists[ai] || [];
      const pageDictList = allPdfDocs[ai] || [];
      const lang = langList[origIdx] || 'ch';

      if (batchIdx === 0 && ocrEnabled[ai] !== undefined) {
        ocrEnabledList[origIdx] = ocrEnabled[ai];
      }

      if (modelList.length === 0) {
        if (modelList.length < pdf_pages_batch) finished[origIdx] = true;
        continue;
      }

      try {
        const middleJson = await resultToMiddleJson(
          modelList,
          imagesList,
          pageDictList,
          imageWriter,
          {
            lang,
            ocr_enable: ocrEnabled[ai] ?? ocrEnabledList[origIdx] ?? false,
            formula_enabled: formula_enable,
            ocr_config,
            image_config: null,
            batch_idx: batchIdx,
            pdf_pages_batch,
            skipCrossPageMerge: true, // defer crossPageTableMerge until all windows complete
            // paraSplit runs per-window so unionMake produces readable markdown immediately
          }
        );

        accumulatedPdfInfo.push(...(middleJson.pdf_info || []));
      } catch (err) {
        if (err instanceof AbortException) throw err;
        // ORT WASM trap: raw number, no .message. Session is permanently
        // corrupted after this — subsequent windows WILL crash native.
        if (typeof err === 'number' || (err && !err.message)) {
          console.warn(
            `[Pipeline] native runtime trap during resultToMiddleJson ` +
            `(window ${batchIdx + 1}): ${err}. Stopping further windows; ` +
            `preserving ${accumulatedPdfInfo.length} pages already accumulated.`
          );
          finished.fill(true);
          break;
        }
        console.warn(
          `[Pipeline] resultToMiddleJson failed for window ${batchIdx + 1}: ` +
          `${err?.message || err}`
        );
      }

      // ── Eager disposal: zero OffscreenCanvas dimensions, release GPU buffers ──
      for (const img of imagesList) {
        releaseCanvas(img?.img_pil);
        releaseCanvas(img);
      }

      if (modelList.length < pdf_pages_batch) {
        finished[origIdx] = true;
      }
    }

    // Page-based progress: update after each window completes
    const windowPages = activeIndexes.reduce((sum, _, ai) => sum + (inferResults[ai]?.length || 0), 0);
    completedPages += windowPages;
    firePageProgress();

    // ── Incremental callback for streaming UX ──
    if (on_window_result && accumulatedPdfInfo.length > 0) {
      try {
        const tWindowUnion0 = performance.now();
        const windowMarkdown = unionMake(accumulatedPdfInfo, 'mm_markdown', 'images') || '';
        const windowContentList = unionMake(accumulatedPdfInfo, 'content_list', 'images') || [];
        const tWindowUnion1 = performance.now();
        console.log(
          `[_docAnalyzeWindowed] Firing on_window_result — ` +
          `window ${batchIdx + 1}/${totalWindows}, ` +
          `pages ${accumulatedPdfInfo.length}, ` +
          `markdown ${windowMarkdown.length} chars, ` +
          `contentList ${windowContentList.length} items, ` +
          `unionMake took ${(tWindowUnion1 - tWindowUnion0).toFixed(0)}ms`
        );
        // Pass imageWriter so the adapter can collect cut images incrementally
        on_window_result({
          markdown: windowMarkdown,
          contentList: windowContentList,
          pageCount: accumulatedPdfInfo.length,
          totalWindows,
          windowIndex: batchIdx,
          imageWriter,
        });
        // Yield so the browser event loop can process UI updates.
        await yieldToBrowser();
      } catch (err) {
        console.warn(
          `[Pipeline] on_window_result callback failed for window ${batchIdx + 1}: ` +
          `${err?.message || err}`, err
        );
      }
    }

    tmpStartPageId += pdf_pages_batch;
    batchIdx++;

    // Safety: if no pages returned for any active PDF, stop
    const totalPagesReturned = activeIndexes.reduce(
      (sum, _, ai) => sum + (inferResults[ai]?.length || 0), 0
    );
    if (totalPagesReturned === 0) break;
    await yieldToBrowser();
  }

  // ── Final cross-page processing (deferred from per-window skipGlobalPost) ──
  if (accumulatedPdfInfo.length > 0) {
    paraSplit(accumulatedPdfInfo);
    crossPageTableMerge(accumulatedPdfInfo);
  }

  // Mark progress as 100% — for single-page documents this final event must
  // not be a 'pages' event (which would flip the bar back to indeterminate);
  // 'complete' renders as "Finishing up" at 100%.
  if (on_progress && totalPages > 0) {
    if (totalPages <= 1) {
      on_progress('complete', 1, 1, 100);
    } else {
      on_progress('pages', totalPages, totalPages, 100);
    }
  }

  return {
    _windowed: true,
    pdf_info: accumulatedPdfInfo,
    imageWriter,
    langList,
    ocrEnabledList,
    pipelineTimings,
  };
}

/**
 * Pre-slice all PDFs to the requested page range for windowed processing.
 */
async function _sliceAllPdfsForWindow(pdfBytesList, startPageId, endPageId) {
  const sliced = [];
  for (const pdfBytes of pdfBytesList) {
    try {
      const result = await convertPdfBytesToBytesByPypdfium2(pdfBytes, startPageId, endPageId);
      sliced.push(result);
    } catch (err) {
      if (err instanceof AbortException) throw err;
      sliced.push(pdfBytes);
    }
  }
  return sliced;
}

/**
 * Process a single window of pages from PDFs.
 */
async function _docAnalyzeSingleWindow(pdfBytesList, opts) {
  const {
    lang_list, parse_method, force_ocr, formula_enable, table_enable,
    layout_config, ocr_config, formula_config, table_config, orientation_config, checkbox_config,
    start_page_id = 0, end_page_id = null, on_progress = null,
    progress_tracker = null, batch_offset = 0,
  } = opts;

  const pipelineTimings = _newTimings();
  const langList = lang_list || new Array(pdfBytesList.length).fill('ch');

  const slicedList = await _sliceAllPdfsForWindow(pdfBytesList, start_page_id, end_page_id);

  const tPdfLoad0 = performance.now();
  const { allPagesInfo, allImageLists, allPdfDocs, ocrEnabledList } = await _loadAllPdfPages(
    slicedList, langList, parse_method, force_ocr
  );
  pipelineTimings.pdf_load = performance.now() - tPdfLoad0;

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
    on_stage_progress: on_progress,
    progress_tracker,
    batch_offset,
  });
  await yieldToBrowser();

  _accumulateTimings(pipelineTimings, batchResults?._stageTimings);

  const inferResults = _buildInferResults(pdfBytesList, allPagesInfo, batchResults);

  return [inferResults, allImageLists, allPdfDocs, langList, ocrEnabledList, pipelineTimings];
}

// ---------------------------------------------------------------------------
// batchImageAnalyze
// ---------------------------------------------------------------------------

/**
 * Run a single batch through BatchAnalyze.
 *
 * @param {Array<[any, number, boolean, string, object]>} imagesWithExtraInfo
 * @param {object} [opts]
 * @returns {Promise<object[]>}
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
    on_stage_progress = null,
    progress_tracker = null,
    batch_offset = 0,
  } = {}
) {
  const { BatchAnalyze } = await import("./batch_analyze.js");

  const modelManager = ModelSingleton.getInstance();

  const batchRatio = 1;

  const batchModel = new BatchAnalyze(
    modelManager, batchRatio,
    formula_enable, table_enable,
    layout_config, ocr_config, formula_config, table_config, checkbox_config, orientation_config,
    on_stage_progress,
    progress_tracker,
    batch_offset
  );
  batchModel.lang = lang;

  const results = await batchModel.call(imagesWithExtraInfo);
  results._stageTimings = { ...(batchModel.lastStageTimings || {}) };

  const device = getDevice();
  // Best-effort drain of transient inference allocations between batches.
  // Use { releaseGpu: false } to keep warm sessions alive — full device
  // teardown happens on engineReset() at the end of a run.
  await cleanMemory(device, { releaseGpu: false });

  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Detect image byte streams that must be normalized to PDF before analysis. */
function isImageBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return (
    (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) || // PNG
    (b[0] === 0xFF && b[1] === 0xD8) || // JPEG
    (b[0] === 0x42 && b[1] === 0x4D) || // BMP
    (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) || // WEBP (RIFF)
    (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00) || // TIFF LE
    (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A)    // TIFF BE
  );
}

/** Convert raw image bytes to a single-page PDF. */
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
    releaseImageBitmap(bitmap);
  }
}


// ---------------------------------------------------------------------------
// engineReset — full per-run teardown for VRAM hygiene
// ---------------------------------------------------------------------------

/**
 * Drop every cached model, release every ONNX session, flush WebGPU, and
 * destroy the shared WebGPU device. Use this between runs (especially in
 * the UI's run-failure handler) to guarantee VRAM is returned to the driver.
 *
 * Without this, ORT-Web's WebGPU JSEP buffer pool grows unbounded across
 * runs, eventually exceeding the driver's per-allocation limit and producing
 * "createBuffer failed, size too large for the implementation" errors on
 * later runs.
 *
 * Pass `{ keepDevice: true }` to keep the WebGPU device alive (useful when
 * the same model configuration will run again immediately).
 *
 * @param {{ keepDevice?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function engineReset(opts = {}) {
  const keepDevice = opts.keepDevice === true;

  // 1) Drop pipeline-level cache and dispose every cached MineruPipelineModel.
  try {
    await ModelSingleton.getInstance().clear();
  } catch (err) {
    console.warn(formatPipelineError({
      stage: 'dispose',
      module: 'engineReset',
      message: `ModelSingleton.clear failed: ${err?.message ?? err}`,
      recoverable: true,
    }));
  }

  // 2) Drop atomic model cache (which owns the actual ORT sessions).
  try {
    await AtomModelSingleton.getInstance().clear();
  } catch (err) {
    console.warn(formatPipelineError({
      stage: 'dispose',
      module: 'engineReset',
      message: `AtomModelSingleton.clear failed: ${err?.message ?? err}`,
      recoverable: true,
    }));
  }

  // 3) Flush + drop the shared WebGPU device. This is the only mechanism
  //    that returns ORT-Web's pooled GPU buffers to the driver.
  const device = getDevice();
  if (!keepDevice) {
    await cleanMemory(device, { releaseGpu: true });
  } else {
    await cleanMemory(device, { releaseGpu: false });
  }
}
