/**
 * ui/utils/pipelineAdapter.js
 * Bridge between the UI state and the RapidDoc-JS pipeline engine.
 *
 * Responsibilities:
 *  1. Build pipeline config from AppState
 *  2. Register model download handlers on ModelManager
 *  3. Drive AppState stages/progress/timings during execution
 *  4. Handle research-mode repeat runs
 *  5. Forward results to AppState on completion
 *
 * The actual inference is delegated to the RapidDoc-JS entry point (demo.js /
 * rapid_doc/index.js). This adapter translates between the UI contract and the
 * engine API without embedding inference logic.
 */

import { appState } from '../state/appState.js';
import { exportUtils } from './exportUtils.js';

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/bmp',
  'image/webp', 'image/tiff', 'image/tif',
]);
const IMAGE_EXTENSIONS = /\.(png|jpe?g|bmp|webp|tiff?)$/i;

function isImageFile(file) {
  if (file.type && IMAGE_MIME_TYPES.has(file.type.toLowerCase())) return true;
  if (file.name && IMAGE_EXTENSIONS.test(file.name)) return true;
  return false;
}

function toFiniteMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function quadBounds(box) {
  if (!Array.isArray(box) || box.length < 4) return null;
  const xs = box.map((p) => Number(p?.[0]));
  const ys = box.map((p) => Number(p?.[1]));
  if (xs.some((v) => !Number.isFinite(v)) || ys.some((v) => !Number.isFinite(v))) {
    return null;
  }
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return {
    left,
    right,
    top,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function isCjkChar(ch) {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(ch);
}

function shouldInsertSpace(prev, next) {
  if (!prev || !next) return false;
  const prevLast = prev.slice(-1);
  const nextFirst = next.charAt(0);
  if (!prevLast || !nextFirst) return false;
  if (isCjkChar(prevLast) || isCjkChar(nextFirst)) return false;
  if (/[([{\"'`\-]/.test(prevLast)) return false;
  if (/[)\]}\"'`.,;:!?%]/.test(nextFirst)) return false;
  return true;
}

function formatOcrPairs(pairs) {
  const items = (Array.isArray(pairs) ? pairs : [])
    .map((pair) => {
      const [box, rec] = pair ?? [];
      const text = String(rec?.[0] ?? '').trim();
      if (!text) return null;
      const bounds = quadBounds(box);
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
      return {
        text,
        ...bounds,
        centerY: bounds.top + (bounds.height / 2),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const yDelta = Math.abs(a.centerY - b.centerY);
      if (yDelta <= Math.max(6, Math.min(a.height, b.height) * 0.5)) {
        return a.left - b.left;
      }
      return a.top - b.top;
    });

  if (!items.length) {
    return { text: '', lines: [] };
  }

  const lineGroups = [];
  for (const item of items) {
    const current = lineGroups.at(-1);
    if (!current) {
      lineGroups.push([item]);
      continue;
    }

    const avgCenterY = current.reduce((sum, v) => sum + v.centerY, 0) / current.length;
    const avgHeight = current.reduce((sum, v) => sum + v.height, 0) / current.length;
    const sameLineThreshold = Math.max(8, avgHeight * 0.65);

    if (Math.abs(item.centerY - avgCenterY) <= sameLineThreshold) {
      current.push(item);
    } else {
      lineGroups.push([item]);
    }
  }

  const lines = lineGroups.map((group) => {
    const ordered = [...group].sort((a, b) => a.left - b.left);
    let lineText = '';
    for (const token of ordered) {
      if (!lineText) {
        lineText = token.text;
      } else {
        lineText += shouldInsertSpace(lineText, token.text) ? ` ${token.text}` : token.text;
      }
    }
    return lineText.trim();
  }).filter(Boolean);

  return {
    text: lines.join('\n'),
    lines,
  };
}

async function fileToImageMat(file, toMatBgr) {
  const imageBitmap = await createImageBitmap(file);
  try {
    return toMatBgr(imageBitmap);
  } finally {
    if (typeof imageBitmap.close === 'function') {
      imageBitmap.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Lazy imports — engine modules loaded only when needed to keep initial
// bundle time minimal. Replace these paths if the JS entry points change.
// ---------------------------------------------------------------------------

let _engineModule = null;

async function getEngine() {
  if (_engineModule) return _engineModule;
  try {
    // Primary: use the ported rapid_doc JS entry
    _engineModule = await import('../../rapid_doc/index.js');
  } catch (e) {
    console.warn('[pipelineAdapter] rapid_doc/index.js failed to load:', e);
    try {
      // Fallback: use demo.js top-level export
      _engineModule = await import('../../demo.js');
    } catch (e2) {
      console.error('[pipelineAdapter] Both engine entry points failed:', e2);
      _engineModule = null;
    }
  }
  return _engineModule;
}

// ---------------------------------------------------------------------------
// PipelineAdapter class
// ---------------------------------------------------------------------------

export class PipelineAdapter {
  constructor() {
    /** @type {import('../components/ModelManager.js').ModelManager|null} */
    this._modelManager = null;
    this._abortController = null;
  }

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Called by index.html after ModelManager is mounted.
   * Registers download callbacks so ModelManager cards can trigger downloads.
   * @param {import('../components/ModelManager.js').ModelManager} mm
   */
  registerModelManager(mm) {
    this._modelManager = mm;

    // Register per-model download stubs (real download happens inside engine load)
    const { MODEL_CATALOG } = mm.constructor;
    if (!MODEL_CATALOG) return;

    for (const model of MODEL_CATALOG) {
      mm.onDownload(model.id, async () => {
        await this._downloadSingleModel(model.id);
      });
      mm.onDownload(`${model.id}_clear`, () => {
        this._clearModelCache(model.id);
      });
    }
  }

  // ── Main entry point ──────────────────────────────────────────────────────

  /**
   * Execute the full pipeline for all queued files, driven by appState.
   * Handles research-mode repetition automatically.
   *
   * @param {import('../state/appState.js').AppState} [state] — defaults to singleton
   */
  async run(state = appState) {
    if (state.get('isProcessing')) return;
    const file = state.currentFile;
    if (!file) {
      this._toast('No file selected.', 'error');
      return;
    }

    const researchMode  = state.get('researchMode');
    const repeatCount   = researchMode ? state.get('researchRepeatCount') : 1;

    // Clear previous research history when starting a new batch
    if (researchMode) state.clearResearchHistory();

    for (let run = 0; run < repeatCount; run++) {
      if (researchMode) {
        state.patch({ researchCurrentRun: run });
      }

      const abortCtrl = new AbortController();
      this._abortController = abortCtrl;
      state.set('abortController', abortCtrl);

      const timings = await this._runSingle(state, file, abortCtrl.signal);

      if (abortCtrl.signal.aborted) break;

      if (researchMode && timings) {
        state.recordResearchRun(timings);

        // Auto-export after last run
        if (run === repeatCount - 1) {
          try { exportUtils.exportResearchCsv(state); } catch { /* non-critical */ }
        }
      }
    }
  }

  // ── Single-document run ───────────────────────────────────────────────────

  /**
   * @param {import('../state/appState.js').AppState} state
   * @param {File} file
   * @param {AbortSignal} signal
   * @returns {Promise<import('../state/appState.js').Timings|null>}
   */
  async _runSingle(state, file, signal) {
    if (isImageFile(file)) {
      this._toast('Running Full Analysis on image input.', 'info');
    }
    return this._runFullAnalysis(state, file, signal);
  }

  // ── OCR-Only Pipeline ─────────────────────────────────────────────────────

  /**
    * Fast OCR-only path: image/PDF → OCR det+rec → plain text.
   * Skips layout detection, formula recognition, table recognition entirely.
   */
  async _runOcrOnly(state, file, signal) {
    const t0 = performance.now();
    try {
      state.beginStage('loading_models');

      // Lazy-import OCR dependencies.
      const { loadImagesFromPdf } = await import('../../rapid_doc/utils/pdf_image_tools.js');
      const { toMatBgr } = await import('../../rapid_doc/utils/model_utils.js');

      if (signal.aborted) return null;

      // ── Step 1: read file bytes ─────────────────────────────────────────
      const tPre0 = performance.now();
      state.beginStage('preprocessing');
      const imageInput = isImageFile(file);
      let rawFileBytes = null;
      if (!imageInput) {
        rawFileBytes = new Uint8Array(await file.arrayBuffer());
      }
      if (signal.aborted) return null;

      const tPre1 = performance.now();
      state.recordTiming('preprocessing', tPre1 - tPre0);

      // ── Step 2: render PDF pages to images ──────────────────────────────
      const tOcr0 = performance.now();
      state.beginStage('ocr');
      state.updateMemory();

      let imagesList = null;
      let pdfDoc = null;
      let singleImageMat = null;
      if (imageInput) {
        singleImageMat = await fileToImageMat(file, toMatBgr);
      } else {
        [imagesList, pdfDoc] = await loadImagesFromPdf(rawFileBytes);
      }
      if (signal.aborted) {
        await pdfDoc?.cleanup?.();
        if (singleImageMat?.owned) singleImageMat.mat.delete();
        return null;
      }

      const config = this._buildConfig(state, file);
      const lang = config.language ?? 'ch';

      // ── Step 3: create OCR model (cached via singleton) ─────────────────
      // Use the AtomModelSingleton so the model is shared with full pipeline
      const { AtomModelSingleton } = await import('../../rapid_doc/backend/pipeline/model_init.js');
      const { AtomicModel } = await import('../../rapid_doc/backend/pipeline/model_list.js');
      const atomMgr = AtomModelSingleton.getInstance();
      const ocrModel = await atomMgr.getAtomModel(AtomicModel.OCR, {
        det_db_box_thresh: 0.3,
        lang,
        ocr_config: config.ocr_config ?? null,
      });

      if (signal.aborted) {
        await pdfDoc?.cleanup?.();
        if (singleImageMat?.owned) singleImageMat.mat.delete();
        return null;
      }

      // ── Step 4: run OCR on each page ────────────────────────────────────
      const allPageTexts = [];
      const allPageLines = [];
      const totalPages = imageInput ? 1 : imagesList.length;
      for (let i = 0; i < totalPages; i++) {
        if (signal.aborted) break;
        state.updateProgress(i + 1, totalPages);
        state.updateMemory();

        let mat = null;
        let owned = false;
        if (imageInput) {
          mat = singleImageMat.mat;
          owned = false;
        } else {
          const imgDict = imagesList[i];
          const matInfo = toMatBgr(imgDict.img_pil);
          mat = matInfo.mat;
          owned = matInfo.owned;
        }

        try {
          const ocrResult = await ocrModel.ocr(mat, { det: true, rec: true });
          // ocrResult: [[boxes_and_pairs]] where pairs = [[box, [text, score]], ...]
          if (ocrResult && ocrResult[0]) {
            const pairs = ocrResult[0];
            const formatted = formatOcrPairs(pairs);
            allPageTexts.push(formatted.text);
            allPageLines.push(formatted.lines);
          } else {
            allPageTexts.push('');
            allPageLines.push([]);
          }
        } finally {
          if (owned) mat.delete();
        }
      }

      await pdfDoc?.cleanup?.();
      if (singleImageMat?.owned) {
        singleImageMat.mat.delete();
      }
      const tOcr1 = performance.now();
      state.recordTiming('ocr', tOcr1 - tOcr0);

      if (signal.aborted) return null;

      // ── Step 5: build result ────────────────────────────────────────────
      const tPost0 = performance.now();
      state.beginStage('postprocessing');
      const fullText = allPageTexts.join('\n\n---\n\n');

      const results = {
        markdown:      fullText,
        raw_text:      fullText,
        content_list:  allPageTexts.map((text, i) => ({
          type: 'text',
          page_no: i,
          text,
          lines: allPageLines[i] ?? [],
        })),
        middle_json:   null,
        model_output:  null,
        layout_bboxes: [],
        span_bboxes:   [],
        page_count:    totalPages,
        images:        {},
        _config: config,
        _file:   { name: file.name, size: file.size },
      };

      const tPost1 = performance.now();
      state.recordTiming('postprocessing', tPost1 - tPost0);

      const total = performance.now() - t0;
      state.recordTiming('total', total);
      state.recordTiming('layoutAnalysis', 0); // no layout in OCR-only mode
      state.recordTiming('formula', 0);
      state.recordTiming('table', 0);
      state.recordTiming('readingOrder', 0);
      state.updateMemory();

      state.finishProcessing(results);
      this._toast(`OCR complete — ${totalPages} page(s) in ${(total / 1000).toFixed(1)}s`, 'success');

      return {
        preprocessing:  tPre1 - tPre0,
        layoutAnalysis: 0,
        ocr:            tOcr1 - tOcr0,
        formula:        0,
        table:          0,
        readingOrder:   0,
        postprocessing: tPost1 - tPost0,
        total,
      };
    } catch (err) {
      if (signal.aborted) {
        state.failProcessing('Cancelled');
        return null;
      }
      console.error('[pipelineAdapter/OCR] Run failed:', err);
      state.failProcessing(err);
      this._toast(`OCR failed: ${err.message ?? err}`, 'error');
      return null;
    }
  }

  // ── Full Analysis Pipeline ────────────────────────────────────────────────

  async _runFullAnalysis(state, file, signal) {
    const t0 = performance.now();
    const postBreakdown = {
      engine_postprocessing_ms: 0,
      middle_json_ms: 0,
      markdown_union_ms: 0,
      content_list_union_ms: 0,
      result_normalize_ms: 0,
      visual_render_ui_ms: 0,
      total_ms: 0,
    };

    try {
      // ── Step 1: ensure models present ─────────────────────────────────────
      state.beginStage('loading_models');
      await this._ensureModels(state, signal);
      if (signal.aborted) return null;

      // ── Step 2: read file bytes ────────────────────────────────────────────
      const tPre0 = performance.now();
      state.beginStage('preprocessing');
      const rawFileBytes = new Uint8Array(await file.arrayBuffer());
      if (signal.aborted) return null;

      const fileBytes = rawFileBytes.buffer.slice(
        rawFileBytes.byteOffset,
        rawFileBytes.byteOffset + rawFileBytes.byteLength
      );

      // ── Step 3: build pipeline config ─────────────────────────────────────
      const config = this._buildConfig(state, file);

      // ── Step 4: load engine ────────────────────────────────────────────────
      const engine = await getEngine();
      if (!engine) throw new Error('RapidDoc engine could not be loaded.');
      if (signal.aborted) return null;

      const tPre1 = performance.now();
      state.recordTiming('preprocessing', tPre1 - tPre0);

      // ── Step 5: run layout ─────────────────────────────────────────────────
      const tLay0 = performance.now();
      state.beginStage('layout');
      state.updateMemory();

      // Progress callback from engine
      const onProgress = (current, total) => {
        state.updateProgress(current, total);
        state.updateMemory();
      };

      // Invoke engine. The API surface may differ; try multiple call styles:
      let rawResult = null;

      if (typeof engine.docAnalyze === 'function') {
        // Primary: rapid_doc/index.js exports docAnalyze(pdfBytesList, opts)
        // .slice(0) makes a fresh copy so the original fileBytes is never detached
        // by PDF.js's postMessage/structuredClone transfer semantics
        // docAnalyze returns [inferResults, allImageLists, allPdfDocs, langList, ocrEnabledList]
        const docResult = await engine.docAnalyze(
          [new Uint8Array(fileBytes.slice(0))],
          {
            lang_list:      [config.language ?? 'ch'],
            parse_method:   config.parse_method,
            formula_enable: config.formula_enable,
            table_enable:   config.table_enable,
            layout_config:  config.layout_config,
            ocr_config:     config.ocr_config,
            formula_config: config.formula_config,
            table_config:   config.table_config,
            checkbox_config: config.checkbox_config,
            start_page_id:  config.start_page_id ?? 0,
            end_page_id:    config.end_page_id ?? null,
          }
        );

        if (Array.isArray(docResult) && docResult.length >= 5 &&
            typeof engine.resultToMiddleJson === 'function' &&
            typeof engine.unionMake === 'function') {
          // ── Post-process: model output → middle JSON → markdown ──
          const [inferResults, allImageLists, allPdfDocs, langList, ocrEnabledList, stageTimings = null] = docResult;
          const modelList    = inferResults[0];   // first (only) PDF
          const imagesList   = allImageLists[0];
          const pageDictList = allPdfDocs[0];
          const lang         = langList[0]  ?? config.language ?? 'ch';
          const ocrEnabled   = ocrEnabledList[0] ?? false;

          // MemoryDataWriter stub — collects cut images in-memory
          const imageWriter = (typeof engine.MemoryDataWriter === 'function')
            ? new engine.MemoryDataWriter()
            : { files: {}, write(path, bytes) { this.files[path] = bytes; } };

          const tMiddle0 = performance.now();
          const middleJson = await engine.resultToMiddleJson(
            modelList,
            imagesList,
            pageDictList,
            imageWriter,
            {
              lang,
              ocr_enable:      ocrEnabled,
              formula_enabled: config.formula_enable ?? true,
              ocr_config:      config.ocr_config  ?? null,
              image_config:    null,
            }
          );
          postBreakdown.middle_json_ms = performance.now() - tMiddle0;

          const pdfInfo = middleJson?.pdf_info ?? [];
          const tMarkdown0 = performance.now();
          const markdown = engine.unionMake(pdfInfo, 'mm_markdown', 'images') || '';
          postBreakdown.markdown_union_ms = performance.now() - tMarkdown0;

          const tContent0 = performance.now();
          const contentList = engine.unionMake(pdfInfo, 'content_list', 'images') || [];
          postBreakdown.content_list_union_ms = performance.now() - tContent0;

          const images = await this._collectImageMap(imageWriter);

          rawResult = {
            markdown,
            content_list:  contentList,
            middle_json:   middleJson,
            model_output:  modelList,
            page_count:    modelList.length,
            images,
            layout_dets:   modelList.flatMap(p => p?.layout_dets ?? []),
            page_info:     modelList[0]?.page_info ?? null,
            _timings:      stageTimings,
          };
        } else if (Array.isArray(docResult)) {
          // Fallback: unwrap first element
          rawResult = docResult[0];
        } else {
          rawResult = docResult;
        }
      } else if (typeof engine.RapidDoc === 'function' || typeof engine.RapidDoc === 'object') {
        // Class-style: new RapidDoc(config).parse(bytes, onProgress)
        const doc = engine.RapidDoc?.create
          ? engine.RapidDoc.create(config)
          : new engine.RapidDoc(config);
        rawResult = await doc.parse(new Uint8Array(fileBytes.slice(0)), { onProgress, signal });
      } else if (typeof engine.parse === 'function') {
        rawResult = await engine.parse(new Uint8Array(fileBytes.slice(0)), config, { onProgress, signal });
      } else if (typeof engine.default === 'function') {
        rawResult = await engine.default(new Uint8Array(fileBytes.slice(0)), config, { onProgress, signal });
      } else {
        throw new Error('Unknown engine API shape — cannot call parse.');
      }

      const tLay1 = performance.now();
      const measuredLayout = tLay1 - tLay0;
      const stageTimings = rawResult?._timings ?? null;

      const layoutMs = Number(stageTimings?.layout ?? measuredLayout);
      const formulaMs = Number(stageTimings?.formula ?? 0);
      const tableMs = Number(stageTimings?.table ?? 0);
      const readingOrderMs = Number(stageTimings?.reading_order ?? 0);
      const postCoreMs = Number(stageTimings?.postprocessing ?? 0);
      const ocrMs = Number(stageTimings?.ocr ?? rawResult?._timings?.ocr ?? 0);
      postBreakdown.engine_postprocessing_ms = toFiniteMs(postCoreMs);

      state.recordTiming('layoutAnalysis', layoutMs);
      state.recordTiming('formula', formulaMs);
      state.recordTiming('table', tableMs);
      state.recordTiming('readingOrder', readingOrderMs);

      if (signal.aborted) return null;

      // ── Step 6: OCR stage (reported by engine timing, fallback 0) ──
      state.beginStage('ocr');
      state.recordTiming('ocr', ocrMs);

      // ── Step 7: postprocessing ─────────────────────────────────────────────
      const tPost0 = performance.now();
      state.beginStage('postprocessing');
      const results = this._normaliseResult(rawResult, file, config);
      const tPost1 = performance.now();
      postBreakdown.result_normalize_ms = tPost1 - tPost0;
      const postprocessingTotal =
        toFiniteMs(postBreakdown.engine_postprocessing_ms)
        + toFiniteMs(postBreakdown.middle_json_ms)
        + toFiniteMs(postBreakdown.markdown_union_ms)
        + toFiniteMs(postBreakdown.content_list_union_ms)
        + toFiniteMs(postBreakdown.result_normalize_ms);
      postBreakdown.total_ms = postprocessingTotal;

      results._timingBreakdown = {
        ...(results._timingBreakdown || {}),
        postprocessing: { ...postBreakdown },
      };

      state.recordTiming('postprocessing', postprocessingTotal);

      const total = performance.now() - t0;
      state.recordTiming('total', total);
      state.updateMemory();

      // ── Step 8: done ───────────────────────────────────────────────────────
      state.finishProcessing(results);
      this._toast('Document processed successfully.', 'success');

      return {
        preprocessing:  state.get('timings').preprocessing,
        layoutAnalysis: layoutMs,
        ocr:            ocrMs,
        formula:        formulaMs,
        table:          tableMs,
        readingOrder:   readingOrderMs,
        postprocessing: postprocessingTotal,
        total,
      };
    } catch (err) {
      if (signal.aborted) {
        state.failProcessing('Cancelled');
        return null;
      }
      console.error('[pipelineAdapter] Run failed:', err);
      state.failProcessing(err);
      this._toast(`Processing failed: ${err.message ?? err}`, 'error');
      return null;
    }
  }

  // ── Model management ──────────────────────────────────────────────────────

  /**
   * Check which models are required for the current config and download any missing ones.
   * @param {import('../state/appState.js').AppState} state
   * @param {AbortSignal} signal
   */
  async _ensureModels(state, signal) {
    const engine = await getEngine();
    if (!engine) return;

    // If engine exposes a model-check API, use it
    if (typeof engine.getRequiredModels === 'function') {
      const required = engine.getRequiredModels(this._buildConfig(state, state.currentFile));
      for (const modelId of required) {
        if (signal.aborted) return;
        if (state.get('modelStatus')[modelId] !== 'cached') {
          await this._downloadSingleModel(modelId, state, signal);
        }
      }
    }
    // Otherwise models are loaded lazily by the engine itself and will emit
    // progress events that we forward via state.setModelStatus()
  }

  /**
   * Download a single model with progress reporting.
   * @param {string} modelId
   * @param {import('../state/appState.js').AppState} [state]
   * @param {AbortSignal} [signal]
   */
  async _downloadSingleModel(modelId, state = appState, signal) {
    state.setModelStatus(modelId, 'downloading', 0);
    try {
      const engine = await getEngine();
      if (engine && typeof engine.downloadModel === 'function') {
        await engine.downloadModel(modelId, (pct) => {
          state.setModelStatus(modelId, 'downloading', pct);
        }, signal);
        state.setModelStatus(modelId, 'cached', 100);
      } else {
        // No engine download API — mark as pending (engine will load lazily)
        state.setModelStatus(modelId, 'not_downloaded', 0);
      }
    } catch (e) {
      console.error(`[pipelineAdapter] Model download failed: ${modelId}`, e);
      state.setModelStatus(modelId, 'error', 0);
      throw e;
    }
  }

  _clearModelCache(modelId) {
    const engine = window.__rapidDocEngine;
    if (engine && typeof engine.clearModelCache === 'function') {
      engine.clearModelCache(modelId);
    }
  }

  // ── Config builder ────────────────────────────────────────────────────────

  /**
   * Convert AppState values to the config object expected by the RapidDoc engine.
   * @param {import('../state/appState.js').AppState} state
   * @param {File} file
   * @returns {object}
   */
  _buildConfig(state, file) {
    const { start, end } = state.get('pageRange');
    return {
      // Input
      file_name:           file?.name ?? '',
      parse_method:        state.get('parseMethod'),
      force_ocr:           state.get('forceOcr'),
      language:            state.get('language'),
      start_page_id:       start,
      end_page_id:         end,
      max_pages:           state.get('maxPages'),

      // Features
      formula_enable:      state.get('formulaEnable'),
      table_enable:        state.get('tableEnable'),
      checkbox_enable:     state.get('checkboxEnable'),
      formula_config:      state.formulaConfig,

      // Layout
      layout_config:       state.layoutConfig,

      // OCR
      ocr_config:          state.ocrConfig,

      // Table
      table_config:        state.tableConfig,

      // Checkbox
      checkbox_config:     state.checkboxConfig,

      // Output flags
      dump_md:             state.get('dumpMd'),
      dump_middle_json:    state.get('dumpMiddleJson'),
      dump_model_output:   state.get('dumpModelOutput'),
      dump_content_list:   state.get('dumpContentList'),
      draw_layout_bbox:    state.get('drawLayoutBbox'),
      draw_span_bbox:      state.get('drawSpanBbox'),
      dump_md_html:        state.get('dumpMdHtml'),
      make_mode:           state.get('makeMode'),

      // Execution
      execution_provider:  state.get('activeExecutionProvider') ?? 'wasm',

      // Pipeline mode
      pipeline_mode:       'full_analysis',
    };
  }

  // ── Image normalization ───────────────────────────────────────────────────

  /**
   * Convert MemoryDataWriter output into a plain object of data URLs.
   * @param {any} imageWriter
   * @returns {Promise<Object.<string, string>>}
   */
  async _collectImageMap(imageWriter) {
    if (!imageWriter) return {};

    if (imageWriter instanceof Map) {
      return this._normalizeImageEntries(imageWriter.entries());
    }

    if (typeof imageWriter.getStore === 'function') {
      const store = imageWriter.getStore();
      if (store instanceof Map) {
        return this._normalizeImageEntries(store.entries());
      }
    }

    if (imageWriter._store instanceof Map) {
      return this._normalizeImageEntries(imageWriter._store.entries());
    }

    if (imageWriter.files && typeof imageWriter.files === 'object') {
      return this._normalizeImageEntries(Object.entries(imageWriter.files));
    }

    return {};
  }

  /**
   * @param {Iterable<[string, any]>} entries
   * @returns {Promise<Object.<string, string>>}
   */
  async _normalizeImageEntries(entries) {
    const output = {};
    for (const [key, value] of entries) {
      const dataUrl = await this._toDataUrl(value);
      if (dataUrl) output[key] = dataUrl;
    }
    return output;
  }

  /**
   * @param {any} value
   * @returns {Promise<string|null>}
   */
  async _toDataUrl(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      return value.startsWith('data:') ? value : null;
    }

    if (value instanceof Blob) {
      return this._blobToDataUrl(value);
    }

    if (value instanceof Uint8Array) {
      return this._blobToDataUrl(new Blob([value], { type: 'image/png' }));
    }

    if (value instanceof ArrayBuffer) {
      return this._blobToDataUrl(new Blob([value], { type: 'image/png' }));
    }

    return null;
  }

  /**
   * @param {Blob} blob
   * @returns {Promise<string>}
   */
  _blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Failed to read image blob'));
      reader.readAsDataURL(blob);
    });
  }

  // ── Result normaliser ─────────────────────────────────────────────────────

  /**
   * Normalise the raw engine output into the shape expected by OutputTabs.
   * Different engine builds may return slightly different key names.
   *
   * @param {object} raw
   * @param {File} file
   * @param {object} config
   * @returns {object}
   */
  _normaliseResult(raw, file, config) {
    if (!raw) return { markdown: '', raw_text: '', page_count: 0 };

    return {
      // Core outputs
      markdown:      raw.markdown    ?? raw.md_content     ?? raw.md       ?? '',
      raw_text:      raw.raw_text    ?? raw.text_content   ?? raw.text     ?? '',
      content_list:  raw.content_list ?? raw.contentList   ?? null,
      middle_json:   raw.middle_json  ?? raw.middleJson     ?? raw.layout_info ?? null,
      model_output:  raw.model_output ?? raw.modelOutput    ?? null,

      // Bbox overlays (per-page arrays)
      layout_bboxes: raw.layout_bboxes ?? raw.layoutBboxes ?? [],
      span_bboxes:   raw.span_bboxes   ?? raw.spanBboxes   ?? [],

      // Meta
      page_count:    raw.page_count   ?? raw.pageCount     ?? 1,
      images:        raw.images       ?? {},

      // Pass-through for downstream use
      _config: config,
      _file:   { name: file.name, size: file.size },
      _timingBreakdown: raw._timingBreakdown ?? null,
      _raw:    raw,
    };
  }

  // ── Toast helper ──────────────────────────────────────────────────────────

  /**
   * @param {string} msg
   * @param {'success'|'error'|'warning'|'info'} [type]
   */
  _toast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const icons = { info: 'ℹ️', success: '✅', error: '❌', warn: '⚠️', warning: '⚠️' };
    const borders = { info: 'border-blue-400', success: 'border-green-400', error: 'border-red-400', warn: 'border-amber-400', warning: 'border-amber-400' };
    const t = document.createElement('div');
    t.className = `pointer-events-auto flex items-start gap-3 bg-[#1c2128] border ${borders[type] || borders.info} border-l-4 rounded-xl px-4 py-3 shadow-2xl text-sm`;
    t.style.animation = 'slide-in-right 0.25s ease forwards';
    t.setAttribute('role', type === 'error' ? 'alert' : 'status');
    t.innerHTML = `
      <span class="text-base mt-0.5">${icons[type] || icons.info}</span>
      <span class="flex-1" style="color:#8b949e">${msg}</span>
      <button style="color:#484f58;cursor:pointer" onclick="this.closest('div').remove()">×</button>
    `;
    container.appendChild(t);
    const duration = type === 'error' ? 6000 : 3500;
    setTimeout(() => t.remove(), duration);
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** @type {PipelineAdapter} */
export const pipelineAdapter = new PipelineAdapter();
