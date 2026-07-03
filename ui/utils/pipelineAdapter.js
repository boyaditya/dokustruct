/**
 * ui/utils/pipelineAdapter.js
 * Bridge between the UI state and the browser pipeline engine.
 *
 * Responsibilities:
 *  1. Build pipeline config from AppState
 *  2. Register model download handlers on ModelManager
 *  3. Drive AppState stages/progress/timings during execution
 *  4. Handle research-mode repeat runs
 *  5. Forward results to AppState on completion
 *
 * The actual inference is delegated to the browser engine entry point (demo.js /
 * rapid_doc/index.js). This adapter translates between the UI contract and the
 * engine API without embedding inference logic.
 */

import { appState } from '../state/appState.js';
import {
  clearAsset,
  downloadAssetGroup,
  getAssetRuntimeUrl,
  getAssetsStatus,
} from '../../rapid_doc/utils/download_file.js';
import { getFormulaAssets, summarizeAssets } from '../../rapid_doc/utils/model_url_map.js';
import { PDF_PAGES_BATCH } from '../../rapid_doc/utils/browser_utils.js';

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/bmp',
  'image/webp', 'image/tiff', 'image/tif',
]);
const IMAGE_EXTENSIONS = /\.(png|jpe?g|bmp|webp|tiff?)$/i;
const PDF_IMAGE_DPI = 200;
const PDF_POINTS_PER_INCH = 72;
let pdfDocumentPromise = null;
let exportUtilsPromise = null;
let openCvScriptPromise = null;
let ortRuntimeConfigPromise = null;

function hasOpenCVRuntime() {
  return Boolean(globalThis.cv?.Mat);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('Operation aborted', 'AbortError');
  }
}

function isAbortError(error, signal = null) {
  return Boolean(signal?.aborted || error?.name === 'AbortError');
}

function loadOpenCVScript(signal) {
  if (hasOpenCVRuntime()) return Promise.resolve();
  if (openCvScriptPromise) return openCvScriptPromise;

  openCvScriptPromise = new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const existingScript = document.querySelector('script[data-docparse-opencv], script[src="/opencv/opencv.js"]');
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener('error', () => reject(new Error('Failed to load /opencv/opencv.js')), { once: true });
      signal?.addEventListener('abort', () => reject(new DOMException('Operation aborted', 'AbortError')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = '/opencv/opencv.js';
    script.async = true;
    script.dataset.docparseOpencv = 'true';
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Failed to load /opencv/opencv.js')), { once: true });
    signal?.addEventListener('abort', () => reject(new DOMException('Operation aborted', 'AbortError')), { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    if (!hasOpenCVRuntime()) openCvScriptPromise = null;
    throw error;
  });

  return openCvScriptPromise;
}

function waitForOpenCV(signal, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    if (hasOpenCVRuntime()) {
      resolve(true);
      return;
    }

    const checkInterval = setInterval(() => {
      if (hasOpenCVRuntime()) {
        clearInterval(checkInterval);
        resolve(true);
      }
    }, 100);

    const timeout = setTimeout(() => {
      clearInterval(checkInterval);
      resolve(hasOpenCVRuntime());
    }, timeoutMs);

    signal?.addEventListener('abort', () => {
      clearInterval(checkInterval);
      clearTimeout(timeout);
      reject(new DOMException('Operation aborted', 'AbortError'));
    }, { once: true });
  });
}

async function configureDocumentRuntime() {
  if (!ortRuntimeConfigPromise) {
    ortRuntimeConfigPromise = import('../../rapid_doc/utils/ort_runtime.js')
      .then((module) => module.configureOrtWasmRuntime({ numThreads: 4 }))
      .catch((error) => {
        ortRuntimeConfigPromise = null;
        throw error;
      });
  }
  return ortRuntimeConfigPromise;
}

async function getPDFDocument() {
  if (!pdfDocumentPromise) {
    pdfDocumentPromise = import('pdf-lib').then((module) => module.PDFDocument);
  }
  return pdfDocumentPromise;
}

async function getExportUtils() {
  if (!exportUtilsPromise) {
    exportUtilsPromise = import('./exportUtils.js').then((module) => module.exportUtils);
  }
  return exportUtilsPromise;
}

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

function formatPipelineError(err) {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'number') return `native runtime error code ${err}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function extractSearchableTextFallback(pageDictList) {
  const pages = Array.isArray(pageDictList) ? pageDictList : [];
  const contentList = [];
  const markdownPages = [];

  for (let pageNo = 0; pageNo < pages.length; pageNo++) {
    const lines = [];
    for (const block of pages[pageNo]?.blocks ?? []) {
      for (const line of block.lines ?? []) {
        const spans = [...(line.spans ?? [])].sort((a, b) => {
          const ab = Array.isArray(a.bbox?.bbox) ? a.bbox.bbox : a.bbox;
          const bb = Array.isArray(b.bbox?.bbox) ? b.bbox.bbox : b.bbox;
          return Number(ab?.[0] ?? 0) - Number(bb?.[0] ?? 0);
        });
        let text = '';
        for (const span of spans) {
          const token = String(span.text ?? span.content ?? '').trim();
          if (!token) continue;
          text += text && shouldInsertSpace(text, token) ? ` ${token}` : token;
        }
        if (text) lines.push(text);
      }
    }

    const pageText = lines.join('\n').trim();
    if (pageText) {
      markdownPages.push(pageText);
      contentList.push({ type: 'text', page_no: pageNo, text: pageText, lines });
    }
  }

  return {
    markdown: markdownPages.join('\n\n'),
    contentList,
  };
}

function textHasContent(value) {
  const text = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/[#*_`~|>\-[\](){}:;.,!?/\\]+/g, ' ')
    .trim();
  return /[A-Za-z0-9\u00C0-\uFFFF]/.test(text);
}

function hasMeaningfulContentList(contentList) {
  if (!Array.isArray(contentList)) return false;
  return contentList.some(item =>
    textHasContent(item?.text) ||
    textHasContent(item?.content) ||
    textHasContent(item?.table_body) ||
    textHasContent(item?.table)
  );
}

function markdownToPlainText(markdown) {
  return String(markdown ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/[#*_`~|>\-[\](){}:;.,!?/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

async function imageFileToPdfBytes(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
    const PDFDocument = await getPDFDocument();
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

function releaseCanvasLike(value) {
  const canvas = value?.img_pil ?? value?.canvas ?? value;
  if (canvas && typeof canvas === 'object' && 'width' in canvas && 'height' in canvas) {
    try {
      canvas.width = 0;
      canvas.height = 0;
    } catch { /* ignore */ }
  }
}

function releaseImageLists(imageLists) {
  for (const list of Array.isArray(imageLists) ? imageLists : []) {
    for (const item of Array.isArray(list) ? list : []) releaseCanvasLike(item);
  }
}

async function destroyPdfProxy(pdfDoc) {
  if (!pdfDoc) return;
  try { await pdfDoc.cleanup?.(); } catch { /* ignore */ }
  try { await pdfDoc.destroy?.(); } catch { /* ignore */ }
}

function getDefaultPdfPagesBatch(state) {
  const ep = String(state.get('activeExecutionProvider') || '').toLowerCase();
  if (ep === 'webgpu') {
    return Math.max(1, Math.floor(PDF_PAGES_BATCH / 2));
  }
  return PDF_PAGES_BATCH;
}

function markdownHasImageRefs(markdown) {
  return /!\[[^\]]*\]\([^)]+\)|<img\b/i.test(String(markdown || ''));
}

function normalizeLayoutText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function extractLayoutLabelBlocks(middleJson) {
  const pages = Array.isArray(middleJson?.pdf_info) ? middleJson.pdf_info : [];
  const items = [];

  for (let pageNo = 0; pageNo < pages.length; pageNo++) {
    const blocks = Array.isArray(pages[pageNo]?.preproc_blocks) ? pages[pageNo].preproc_blocks : [];
    for (const block of blocks) {
      let text = '';
      for (const line of Array.isArray(block?.lines) ? block.lines : []) {
        for (const span of Array.isArray(line?.spans) ? line.spans : []) {
          const token = normalizeLayoutText(span?.content ?? span?.text ?? '');
          if (!token) continue;
          text += text && shouldInsertSpace(text, token) ? ` ${token}` : token;
        }
      }
      text = normalizeLayoutText(text);
      if (!text) continue;
      items.push({
        pageNo,
        text,
        originalLabel: block.original_label ?? null,
        blockType: block.type ?? null,
      });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// PipelineAdapter class
// ---------------------------------------------------------------------------

export class PipelineAdapter {
  constructor() {
    /** @type {import('../components/ModelManager.js').ModelManager|null} */
    this._modelManager = null;
    this._abortController = null;
    this._lastModelConfigKey = null;
    this._preparedKey = null;
    this._prepareKey = null;
    this._preparePromise = null;
  }

  /**
   * Returns true if the current config uses windowed (streaming) processing.
   * Can be called before a run starts — depends only on execution provider.
   * @param {import('../state/appState.js').AppState} [state]
   * @returns {boolean}
   */
  _isWindowedMode(state = appState) {
    return getDefaultPdfPagesBatch(state) > 0;
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

    const abortCtrl = new AbortController();
    this._abortController = abortCtrl;
    state.set('abortController', abortCtrl);

    await this._runSingle(state, file, abortCtrl.signal);
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
    if (state.get('pipelineMode') === 'ocr_only') {
      return this._runOcrOnly(state, file, signal);
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
    let _pdfDoc = null;
    let _singleImageMat = null;
    try {
      state.beginStage('loading_models');

      // Lazy-import OCR dependencies.
      throwIfAborted(signal);      const { loadImagesFromPdf } = await import('../../rapid_doc/utils/pdf_image_tools.js');
      throwIfAborted(signal);      const { toMatBgr } = await import('../../rapid_doc/utils/model_utils.js');

      // ── Step 1: read file bytes ─────────────────────────────────────────
      const tPre0 = performance.now();
      state.beginStage('preprocessing');
      const imageInput = isImageFile(file);
      let rawFileBytes = null;
      if (!imageInput) {
        throwIfAborted(signal);        rawFileBytes = new Uint8Array(await file.arrayBuffer());
      }

      const tPre1 = performance.now();
      state.recordTiming('preprocessing', tPre1 - tPre0);

      // ── Step 2: render PDF pages to images ──────────────────────────────
      const tOcr0 = performance.now();
      state.beginStage('ocr');
      state.updateMemory();

      let imagesList = null;
      if (imageInput) {
        throwIfAborted(signal);        _singleImageMat = await fileToImageMat(file, toMatBgr);
      } else {
        throwIfAborted(signal);        [imagesList, _pdfDoc] = await loadImagesFromPdf(rawFileBytes);
      }

      const config = this._buildConfig(state, file);
      throwIfAborted(signal);      const engine = await getEngine();
      throwIfAborted(signal);      await this._evictStaleModelCache(engine, config);
      const lang = config.language ?? 'ch';

      // ── Step 3: create OCR model (cached via singleton) ─────────────────
      // Use the AtomModelSingleton so the model is shared with full pipeline
      throwIfAborted(signal);      const { AtomModelSingleton } = await import('../../rapid_doc/backend/pipeline/model_init.js');
      throwIfAborted(signal);      const { AtomicModel } = await import('../../rapid_doc/backend/pipeline/model_list.js');
      const atomMgr = AtomModelSingleton.getInstance();
      throwIfAborted(signal);      const ocrModel = await atomMgr.getAtomModel(AtomicModel.OCR, {
        det_db_thresh: config.ocr_config?.["Det.det_db_thresh"] ?? config.ocr_config?.det_db_thresh ?? 0.3,
        det_db_box_thresh: 0.3,
        lang,
        ocr_config: config.ocr_config ?? null,
      });

      // ── Step 4: run OCR on each page ────────────────────────────────────
      const allPageTexts = [];
      const allPageLines = [];
      const totalPages = imageInput ? 1 : imagesList.length;
      for (let i = 0; i < totalPages; i++) {
        throwIfAborted(signal);        state.updateProgress(i + 1, totalPages);
        state.updateMemory();

        let mat = null;
        let owned = false;
        if (imageInput) {
          mat = _singleImageMat.mat;
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

      throwIfAborted(signal);      await destroyPdfProxy(_pdfDoc);
      _pdfDoc = null;
      if (_singleImageMat?.owned) {
        _singleImageMat.mat.delete();
        _singleImageMat = null;
      }
      const tOcr1 = performance.now();
      state.recordTiming('ocr', tOcr1 - tOcr0);

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
      state.recordTiming('layout', 0); // no layout in OCR-only mode
      state.recordTiming('formula', 0);
      state.recordTiming('table', 0);
      state.recordTiming('reading_order', 0);
      state.recordTiming('model_init', Number((state.get('startupTimings') || {}).layout || 0));
      state.recordTiming('total_inference', 0);
      state.recordTiming('pdf_load', 0);
      state.recordTiming('orientation', 0);
      state.recordTiming('region_collect', 0);
      state.recordTiming('ocr_det', 0);
      state.recordTiming('ocr_rec', 0);
      const otherMs = Math.max(0, total - (tPost1 - tPost0));
      state.recordTiming('other', otherMs);
      state.updateMemory();

      state.finishProcessing(results);
      this._toast(`OCR complete — ${totalPages} page(s) in ${(total / 1000).toFixed(1)}s`, 'success');

      return {
        preprocessing:  tPre1 - tPre0,
        layout:         0,
        ocr:            tOcr1 - tOcr0,
        formula:        0,
        table:          0,
        reading_order:  0,
        model_init:     Number((state.get('startupTimings') || {}).layout || 0),
        pdf_load:       0,
        orientation:    0,
        region_collect: 0,
        ocr_det:        0,
        ocr_rec:        0,
        total_inference: 0,
        postprocessing: tPost1 - tPost0,
        other:          otherMs,
        total,
      };
    } catch (err) {
      if (isAbortError(err, signal)) {
        await destroyPdfProxy(_pdfDoc);
        _pdfDoc = null;
        if (_singleImageMat?.owned) {
          _singleImageMat.mat.delete();
          _singleImageMat = null;
        }
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
    const postBreakdown = {
      engine_postprocessing_ms: 0,
      middle_json_ms: 0,
      markdown_union_ms: 0,
      content_list_union_ms: 0,
      result_normalize_ms: 0,
      visual_render_ui_ms: 0,
      total_ms: 0,
    };

    // Resources tracked across success/error/finally so VRAM and PNG byte
    // arrays are reliably released even when the pipeline throws.
    let _allImageLists = null;
    let _imageWriter = null;
    let _engineRef = null;
    let _runFailedFatally = false;

    try {
      // ── Step 1: ensure models present ─────────────────────────────────────
      if (!this.isPrepared(state, file)) {
        throwIfAborted(signal);        await this.prepare(state, file, signal);
      }
      if (signal.aborted) return null;

      const t0 = performance.now();

      // ── Step 2: read file bytes ────────────────────────────────────────────
      const tPre0 = performance.now();
      state.beginStage('preprocessing');
      throwIfAborted(signal);      const rawFileBytes = isImageFile(file)
        ? await imageFileToPdfBytes(file)
        : new Uint8Array(await file.arrayBuffer());
      if (signal.aborted) return null;

      const fileBytes = rawFileBytes.buffer.slice(
        rawFileBytes.byteOffset,
        rawFileBytes.byteOffset + rawFileBytes.byteLength
      );

      // ── Step 3: build pipeline config ─────────────────────────────────────
      const config = this._buildConfig(state, file);

      // ── Step 4: load engine ────────────────────────────────────────────────
      throwIfAborted(signal);      const engine = await getEngine();
      if (!engine) throw new Error('Document engine could not be loaded.');
      _engineRef = engine;
      if (signal.aborted) return null;

      const tPre1 = performance.now();
      state.recordTiming('preprocessing', tPre1 - tPre0);

      // ── Step 5: run layout ─────────────────────────────────────────────────
      const tLay0 = performance.now();
      state.beginStage('layout');
      state.updateMemory();

      // Progress callback from engine
      const onProgress = (stage, current, total, percent) => {
        // Use ProgressTracker percentage for accurate progress
        if (typeof percent === 'number') {
          state.patch({ 
            progressPercent: percent,
            progressStage: stage,
          });
        }
        state.updateMemory();
      };

      // Invoke engine. The API surface may differ; try multiple call styles:
      let rawResult = null;

      // Streaming callback for windowed processing — updates UI incrementally
      const pdfPagesBatch = config.pdf_pages_batch ?? 0;
      const onWindowResult = pdfPagesBatch > 0
        ? ({ markdown, contentList, pageCount }) => {
            console.log(`[adapter] onWindowResult fired — markdown: ${(markdown || '').length} chars, pages: ${pageCount}, contentList: ${contentList?.length ?? 0} items`);
            state.updatePartialResults({ markdown, contentList, pageCount });
            state.updateMemory();
          }
        : null;

      if (typeof engine.docAnalyze === 'function') {
        // Primary: rapid_doc/index.js exports docAnalyze(pdfBytesList, opts)
        // .slice(0) makes a fresh copy so the original fileBytes is never detached
        // by PDF.js's postMessage/structuredClone transfer semantics
        // docAnalyze returns [inferResults, allImageLists, allPdfDocs, langList, ocrEnabledList]
        //   OR { _windowed: true, pdf_info, imageWriter, ... } for windowed mode
        throwIfAborted(signal);        const docResult = await engine.docAnalyze(
          [new Uint8Array(fileBytes.slice(0))],
          {
            lang_list:      [config.language ?? 'ch'],
            parse_method:   config.parse_method,
            force_ocr:      config.force_ocr,
            formula_enable: config.formula_enable,
            table_enable:   config.table_enable,
            layout_config:  config.layout_config,
            ocr_config:     config.ocr_config,
            formula_config: config.formula_config,
            table_config:   config.table_config,
            orientation_config: config.orientation_config,
            checkbox_config: config.checkbox_config,
            start_page_id:  config.start_page_id ?? 0,
            end_page_id:    config.end_page_id ?? null,
            pdf_pages_batch: pdfPagesBatch,
            on_progress:    onProgress,
            on_window_result: onWindowResult,
          }
        );

        // ── Windowed mode: engine already did per-window resultToMiddleJson ──
        if (docResult && docResult._windowed) {
          const { pdf_info: pdfInfo, imageWriter, pipelineTimings } = docResult;
          _imageWriter = imageWriter;

          const tMarkdown0 = performance.now();
          let markdown = engine.unionMake(pdfInfo, 'mm_markdown', 'images') || '';
          postBreakdown.markdown_union_ms = performance.now() - tMarkdown0;

          const tContent0 = performance.now();
          let contentList = engine.unionMake(pdfInfo, 'content_list', 'images') || [];
          postBreakdown.content_list_union_ms = performance.now() - tContent0;

          // Fallback check for markdown/content viability
          const markdownHasContent = textHasContent(markdown);
          const contentListHasContent = hasMeaningfulContentList(contentList);
          const ocrEnabledWindowed = true; // ocr_enable handled per-window already
          if (!ocrEnabledWindowed && (!markdownHasContent || !contentListHasContent)) {
            const searchableFallback = extractSearchableTextFallback([]);
            if (searchableFallback.markdown) {
              markdown = searchableFallback.markdown;
              contentList = searchableFallback.contentList;
            }
          }

          const shouldKeepImages = Boolean(
            markdownHasImageRefs(markdown)
            || config.dump_middle_json
            || config.dump_model_output
            || config.dump_md_html
            || config.dump_md_docx
          );
          throwIfAborted(signal);
          const images = shouldKeepImages ? await this._collectImageMap(imageWriter) : {};

          rawResult = {
            markdown,
            content_list:  contentList,
            middle_json:   config.dump_middle_json ? { pdf_info: pdfInfo } : null,
            model_output:  config.dump_model_output ? [] : null,
            layout_label_blocks: extractLayoutLabelBlocks({ pdf_info: pdfInfo }),
            page_count:    pdfInfo.length,
            images,
            layout_dets:   [],
            page_info:     pdfInfo[0]?.page_size ? { width: pdfInfo[0].page_size[0], height: pdfInfo[0].page_size[1] } : null,
            _timings:      pipelineTimings,
          };
        } else if (Array.isArray(docResult) && docResult.length >= 5 &&
            typeof engine.resultToMiddleJson === 'function' &&
            typeof engine.unionMake === 'function') {
          // ── Post-process: model output → middle JSON → markdown ──
          const [inferResults, allImageLists, allPdfDocs, langList, ocrEnabledList, stageTimings = null] = docResult;
          _allImageLists = allImageLists;
          const modelList    = inferResults[0];   // first (only) PDF
          const imagesList   = allImageLists[0];
          const pageDictList = allPdfDocs[0];
          const lang         = langList[0]  ?? config.language ?? 'ch';
          const ocrEnabled   = ocrEnabledList[0] ?? false;

          // MemoryDataWriter stub — collects cut images in-memory
          const imageWriter = (typeof engine.MemoryDataWriter === 'function')
            ? new engine.MemoryDataWriter()
            : { files: {}, write(path, bytes) { this.files[path] = bytes; } };
          _imageWriter = imageWriter;

          const tMiddle0 = performance.now();
          throwIfAborted(signal);          const middleJson = await engine.resultToMiddleJson(
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
          let markdown = engine.unionMake(pdfInfo, 'mm_markdown', 'images') || '';
          postBreakdown.markdown_union_ms = performance.now() - tMarkdown0;

          const tContent0 = performance.now();
          let contentList = engine.unionMake(pdfInfo, 'content_list', 'images') || [];
          postBreakdown.content_list_union_ms = performance.now() - tContent0;

          const markdownHasContent = textHasContent(markdown);
          const contentListHasContent = hasMeaningfulContentList(contentList);
          if (!ocrEnabled && (!markdownHasContent || !contentListHasContent)) {
            const searchableFallback = extractSearchableTextFallback(pageDictList);
            if (searchableFallback.markdown) {
              markdown = searchableFallback.markdown;
              contentList = searchableFallback.contentList;
            }
          }

          const shouldKeepImages = Boolean(
            markdownHasImageRefs(markdown)
            || config.dump_middle_json
            || config.dump_model_output
            || config.dump_md_html
            || config.dump_md_docx
          );
          throwIfAborted(signal);          const images = shouldKeepImages ? await this._collectImageMap(imageWriter) : {};

          rawResult = {
            markdown,
            content_list:  contentList,
            middle_json:   config.dump_middle_json ? middleJson : null,
            model_output:  config.dump_model_output ? modelList : null,
            layout_label_blocks: extractLayoutLabelBlocks(middleJson),
            page_count:    modelList.length,
            images,
            layout_dets:   modelList.flatMap(p => p?.layout_dets ?? []),
            page_info:     modelList[0]?.page_info ?? null,
            _timings:      stageTimings,
          };

          // Release immediately so the OffscreenCanvas backing stores are
          // freed before downstream postprocessing (the finally also covers
          // the error path; calling it twice is safe due to the null guard).
          releaseImageLists(allImageLists);
          _allImageLists = null;
        } else if (Array.isArray(docResult)) {
          // Fallback: unwrap first element
          rawResult = docResult[0];
        } else {
          rawResult = docResult;
        }
      } else if (typeof engine[['Rapid', 'Doc'].join('')] === 'function' || typeof engine[['Rapid', 'Doc'].join('')] === 'object') {
        const engineApiName = ['Rapid', 'Doc'].join('');
        // Class-style engine wrapper: new Engine(config).parse(bytes, onProgress)
        const doc = engine[engineApiName]?.create
          ? engine[engineApiName].create(config)
          : new engine[engineApiName](config);
        throwIfAborted(signal);        rawResult = await doc.parse(new Uint8Array(fileBytes.slice(0)), { onProgress, signal });
      } else if (typeof engine.parse === 'function') {
        throwIfAborted(signal);        rawResult = await engine.parse(new Uint8Array(fileBytes.slice(0)), config, { onProgress, signal });
      } else if (typeof engine.default === 'function') {
        throwIfAborted(signal);        rawResult = await engine.default(new Uint8Array(fileBytes.slice(0)), config, { onProgress, signal });
      } else {
        throw new Error('Unknown engine API shape — cannot call parse.');
      }

      const tLay1 = performance.now();
      const measuredLayout = tLay1 - tLay0;
      const stageTimings = rawResult?._timings ?? null;

      const layoutMs       = Number(stageTimings?.layout         ?? measuredLayout);
      const formulaMs      = Number(stageTimings?.formula        ?? 0);
      const tableMs        = Number(stageTimings?.table          ?? 0);
      const readingOrderMs = Number(stageTimings?.reading_order  ?? 0);
      // OCR is now split into det + rec (both inference). Combine for the UI's
      // single OCR stage. Fall back to the legacy single "ocr" key, and treat
      // any legacy "postprocessing" (which used to hold OCR-rec) as rec time.
      const ocrDetMs       = Number(stageTimings?.ocr_det ?? stageTimings?.ocr ?? 0);
      const ocrRecMs       = Number(stageTimings?.ocr_rec ?? stageTimings?.postprocessing ?? 0);
      const ocrMs          = ocrDetMs + ocrRecMs;
      // Engine no longer reports a separate heavy "postprocessing"; the
      // lightweight middle-json/markdown build is measured by the UI below.
      const postCoreMs     = 0;
      // model_init: time spent loading/initialising models inside the engine.
      // Reported separately so it can be excluded from inference totals.
      const st = state.get('startupTimings') || {};
      // Engine reports model_init ≈0 when models are pre-warmed. Take the
      // larger of engine measurement and warmup timing to get the true cost.
      const modelInitMs    = Math.max(
        Number(stageTimings?.model_init ?? 0),
        Number(st.layout || 0)
      );
      // Extra engine stages (not displayed individually but needed for `other` attribution)
      const pdfLoadMs      = Number(stageTimings?.pdf_load       ?? 0);
      const orientationMs  = Number(stageTimings?.orientation    ?? 0);
      const regionCollectMs= Number(stageTimings?.region_collect ?? 0);
      postBreakdown.engine_postprocessing_ms = toFiniteMs(postCoreMs);

      state.recordTiming('layout', layoutMs);
      state.recordTiming('formula', formulaMs);
      state.recordTiming('table', tableMs);
      state.recordTiming('reading_order', readingOrderMs);
      state.recordTiming('model_init', modelInitMs);
      state.recordTiming('pdf_load', pdfLoadMs);
      state.recordTiming('orientation', orientationMs);
      state.recordTiming('region_collect', regionCollectMs);
      state.recordTiming('ocr_det', ocrDetMs);
      state.recordTiming('ocr_rec', ocrRecMs);

      if (signal.aborted) return null;

      // ── Step 6: OCR stage (reported by engine timing, fallback 0) ──
      state.beginStage('ocr');
      state.recordTiming('ocr', ocrMs);

      // Inference = layout + OCR + formula + table (pure model inference, excludes init/pdf/post)
      const totalInferenceMs = layoutMs + ocrMs + formulaMs + tableMs;
      state.recordTiming('total_inference', totalInferenceMs);

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

      // Compute `other` as balancing figure: only visible pill stages.
      // model_init (pre-pipeline warmup) and hidden engine stages
      // (pdf_load, orientation, region_collect, reading_order) are excluded
      // so Total = Layout + OCR + Formula + Table + Post + Other.
      const attributedMs = layoutMs + ocrMs + formulaMs + tableMs + postprocessingTotal;
      const otherMs = Math.max(0, total - attributedMs);
      state.recordTiming('other', otherMs);

      state.updateMemory();

      // ── Step 8: done ───────────────────────────────────────────────────────
      state.finishProcessing(results);
      this._toast('Document processed successfully.', 'success');

      return {
        preprocessing:  state.get('timings').preprocessing,
        model_init:     modelInitMs,
        pdf_load:       pdfLoadMs,
        orientation:    orientationMs,
        layout:         layoutMs,
        region_collect: regionCollectMs,
        ocr:            ocrMs,
        ocr_det:        ocrDetMs,
        ocr_rec:        ocrRecMs,
        formula:        formulaMs,
        table:          tableMs,
        reading_order:  readingOrderMs,
        total_inference: totalInferenceMs,
        postprocessing: postprocessingTotal,
        other:          otherMs,
        total,
      };
    } catch (err) {
      if (isAbortError(err, signal)) {
        state.failProcessing('Cancelled');
        return null;
      }
      const message = formatPipelineError(err);
      console.error('[pipelineAdapter] Run failed:', message, err);
      state.failProcessing(message);
      this._toast(`Processing failed: ${message}`, 'error');
      // Heuristic: any GPU buffer / WebGPU lost-device error indicates the
      // pool is in a bad state. Force a full engine + GPU teardown so the
      // next run starts from a clean device.
      const errMsg = String(err?.message ?? err ?? '');
      if (
        errMsg.includes('createBuffer')
        || errMsg.includes('mapAsync')
        || errMsg.includes('external Instance')
        || errMsg.includes('GPUDevice')
        || errMsg.includes('WebGPU')
      ) {
        _runFailedFatally = true;
      }
      return null;
    } finally {
      // Per-run cleanup: always run even on success / abort / error so
      // OffscreenCanvas backing stores and PNG byte arrays are released
      // without waiting for GC. Previously these were only freed on the
      // success path, leaving ~4 GB stuck in VRAM after a run.
      try {
        if (_allImageLists) {
          releaseImageLists(_allImageLists);
          _allImageLists = null;
        }
      } catch (e) {
        console.warn('[pipelineAdapter] releaseImageLists failed in finally:', e?.message ?? e);
      }
      try {
        if (_imageWriter && _imageWriter.files && typeof _imageWriter.files === 'object') {
          // Drop references to PNG byte arrays so JS GC can reclaim them.
          // The downstream `state.results.images` already holds data URLs
          // for the images we want to keep.
          for (const k of Object.keys(_imageWriter.files)) delete _imageWriter.files[k];
          _imageWriter = null;
        }
      } catch (e) {
        console.warn('[pipelineAdapter] imageWriter cleanup failed:', e?.message ?? e);
      }
      // GPU drain: best-effort flush of pending WebGPU work. On fatal failure,
      // also tear down the entire engine + WebGPU device. The next run will
      // re-create the device and reload sessions — slower but guarantees
      // VRAM is returned to the driver.
      try {
        if (_runFailedFatally && _engineRef && typeof _engineRef.engineReset === 'function') {
          await _engineRef.engineReset();
          console.warn('[pipelineAdapter] engineReset() called after fatal GPU error.');
        } else if (_engineRef) {
          // Light-weight drain. Do NOT release the device on success — that
          // would force a 60s reload on next run with no benefit when the
          // pool is healthy. cleanMemory below is async but we don't await
          // it, since the run is already complete.
          const ortRuntime = await import('../../rapid_doc/utils/ort_runtime.js');
          ortRuntime.flushGpuQueue?.();
        }
      } catch (e) {
        console.warn('[pipelineAdapter] post-run GPU drain failed:', e?.message ?? e);
      }
      _engineRef = null;
    }
  }

  // ── Model management ──────────────────────────────────────────────────────

  getPreparationKey(state = appState, file = state.currentFile) {
    const config = this._buildConfig(state, file);
    return JSON.stringify({
      language: config.language,
      layout: config.layout_config,
      ocr: config.ocr_config,
      formula: config.formula_enable ? config.formula_config : null,
      table: config.table_enable ? config.table_config : null,
      orientation: config.orientation_config,
      checkbox: config.checkbox_config,
      executionProvider: config.execution_provider,
    });
  }

  isPrepared(state = appState, file = state.currentFile) {
    return this._preparedKey !== null && this._preparedKey === this.getPreparationKey(state, file);
  }

  async prepare(state = appState, file = state.currentFile, signal = null) {
    if (!file) throw new Error('No file selected for model warmup.');
    const key = this.getPreparationKey(state, file);
    if (this._preparedKey === key) {
      state.patch({ runtimeStatus: 'ready', warmupStatus: 'ready', warmupConfigKey: key, warmupError: null });
      return key;
    }
    if (this._preparePromise && this._prepareKey === key) return this._preparePromise;

    this._prepareKey = key;
    this._preparePromise = this._prepare(state, file, signal, key)
      .finally(() => {
        if (this._prepareKey === key) {
          this._preparePromise = null;
          this._prepareKey = null;
        }
      });
    return this._preparePromise;
  }

  async _prepare(state, file, signal, key) {
    const startupTimings = {
      preprocessing: 0,
      layout: 0,
      ocr: 0,
      formula: 0,
      table: 0,
      reading_order: 0,
      postprocessing: 0,
      total: 0,
    };
    const t0 = performance.now();
    state.patch({
      runtimeStatus: 'runtime_loading',
      warmupStatus: 'runtime_loading',
      warmupConfigKey: key,
      warmupError: null,
      startupTimings,
    });

    try {
      throwIfAborted(signal);
      const runtimeStart = performance.now();
      await loadOpenCVScript(signal);
      const openCvLoaded = await waitForOpenCV(signal);
      if (!openCvLoaded) {
        throw new Error('OpenCV runtime is not available. Check /opencv/opencv.js and reload the page.');
      }
      await configureDocumentRuntime();
      state.recordStartupTiming('preprocessing', performance.now() - runtimeStart);
      state.patch({ runtimeStatus: 'ready', warmupStatus: 'model_warming' });

      throwIfAborted(signal);
      const modelStart = performance.now();
      const engine = await getEngine();
      if (!engine) throw new Error('Document engine could not be loaded.');
      await this._ensureModels(state, signal);
      await this._warmModelSessions(engine, state, file, signal);
      state.recordStartupTiming('layout', performance.now() - modelStart);

      const total = performance.now() - t0;
      state.recordStartupTiming('total', total);
      this._preparedKey = key;
      state.patch({
        runtimeStatus: 'ready',
        warmupStatus: 'ready',
        warmupConfigKey: key,
        warmupError: null,
      });
      return key;
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        state.patch({
          warmupStatus: 'idle',
          warmupError: null,
        });
        throw err;
      }
      const message = formatPipelineError(err);
      state.patch({
        runtimeStatus: 'error',
        warmupStatus: 'error',
        warmupError: message,
      });
      throw err;
    }
  }

  async _warmModelSessions(engine, state, file, signal) {
    throwIfAborted(signal);
    const config = this._buildConfig(state, file);
    const modelManager = engine.ModelSingleton?.getInstance?.();
    if (modelManager?.getModel) {
      await modelManager.getModel({
        lang: config.language ?? 'ch',
        formula_enable: config.formula_enable,
        table_enable: config.table_enable,
        layout_config: config.layout_config,
        ocr_config: config.ocr_config,
        formula_config: config.formula_config,
        table_config: config.table_config,
        orientation_config: config.orientation_config,
      });
    }

    throwIfAborted(signal);
    if (config.layout_config?.use_doc_orientation_classify && engine.AtomModelSingleton && engine.AtomicModel) {
      try {
        await engine.AtomModelSingleton.getInstance().getAtomModel(
          engine.AtomicModel.ImgOrientationCls,
          { orientation_config: config.orientation_config }
        );
      } catch (err) {
        console.warn('[pipelineAdapter] Orientation model warmup failed:', err?.message ?? err);
      }
    }
  }

  getRequiredAssetIds(state = appState, file = state.currentFile) {
    const config = this._buildConfig(state, file);
    const engine = _engineModule;
    if (engine && typeof engine.getRequiredAssets === 'function') {
      return engine.getRequiredAssets(config);
    }
    return [];
  }

  async getRequiredAssetSummary(state = appState, file = state.currentFile) {
    const engine = await getEngine();
    const config = this._buildConfig(state, file);
    const ids = typeof engine?.getRequiredAssets === 'function'
      ? engine.getRequiredAssets(config)
      : [];
    const status = await getAssetsStatus(ids);
    return {
      ...summarizeAssets(ids),
      status,
      ready: ids.every(id => status[id]?.cached),
    };
  }

  async downloadRequiredAssets(state = appState, file = state.currentFile, onProgress = null, signal = null) {
    const summary = await this.getRequiredAssetSummary(state, file);
    const missingIds = summary.ids.filter(id => !summary.status[id]?.cached);
    if (!missingIds.length) return summary;
    await downloadAssetGroup(missingIds, onProgress, signal);
    return this.getRequiredAssetSummary(state, file);
  }

  async getFormulaAssetSummary(state = appState, file = state.currentFile) {
    const config = this._buildConfig(state, file);
    const ids = getFormulaAssets(config);
    const status = await getAssetsStatus(ids);
    return {
      ...summarizeAssets(ids),
      enabled: Boolean(config.formula_enable),
      status,
      ready: ids.length > 0 && ids.every(id => status[id]?.cached),
    };
  }

  async downloadFormulaAssets(state = appState, file = state.currentFile, onProgress = null, signal = null) {
    const summary = await this.getFormulaAssetSummary(state, file);
    const missingIds = summary.ids.filter(id => !summary.status[id]?.cached);
    if (!missingIds.length) return summary;
    await downloadAssetGroup(missingIds, onProgress, signal);
    return this.getFormulaAssetSummary(state, file);
  }

  /**
   * Check which models are required for the current config and download any missing ones.
   * @param {import('../state/appState.js').AppState} state
   * @param {AbortSignal} signal
   */
  async _ensureModels(state, signal) {
    const engine = await getEngine();
    if (!engine) return;

    // The setup gate should have cached these already. This stays as a direct
    // safeguard for programmatic callers that use PipelineAdapter without the UI.
    if (typeof engine.getRequiredAssets === 'function') {
      const required = engine.getRequiredAssets(this._buildConfig(state, state.currentFile));
      const status = await getAssetsStatus(required);
      const missing = required.filter(assetId => !status[assetId]?.cached);
      if (missing.length) {
        await downloadAssetGroup(missing, (event) => {
          if (event.assetId) state.setModelStatus(event.assetId, 'downloading', event.percent);
        }, signal);
        for (const assetId of missing) state.setModelStatus(assetId, 'cached', 100);
      }
    } else if (typeof engine.getRequiredModels === 'function') {
      const required = engine.getRequiredModels(this._buildConfig(state, state.currentFile));
      for (const modelId of required) {
        if (signal?.aborted) return;
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
      if (isAbortError(e, signal)) {
        state.setModelStatus(modelId, 'cancelled', 0);
        throw e;
      }
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

  async _evictStaleModelCache(engine, config) {
    const key = JSON.stringify({
      language: config.language,
      layout: config.layout_config,
      ocr: config.ocr_config,
      formula: config.formula_enable ? config.formula_config : null,
      table: config.table_enable ? config.table_config : null,
      orientation: config.orientation_config,
      checkbox: config.checkbox_config,
    });
    if (this._lastModelConfigKey === key) return;
    this._lastModelConfigKey = key;
  }

  // ── Config builder ────────────────────────────────────────────────────────

  /**
   * Convert AppState values to the config object expected by the document engine.
   * @param {import('../state/appState.js').AppState} state
   * @param {File} file
   * @returns {object}
   */
  _buildConfig(state, file) {
    const { start, end } = state.get('pageRange');
    const executionProvider = state.get('activeExecutionProvider') ?? 'wasm';
    const forceOcr = Boolean(state.get('forceOcr'));
    const parseMethod = forceOcr ? 'ocr' : state.get('parseMethod');
    return {
      // Input
      file_name:           file?.name ?? '',
      parse_method:        parseMethod,
      force_ocr:           forceOcr,
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

      // Orientation
      orientation_config:  state.orientationConfig,

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
      dump_md_docx:        state.get('dumpMdDocx'),
      make_mode:           state.get('makeMode'),
      pdf_pages_batch:     getDefaultPdfPagesBatch(state),

      // Execution
      execution_provider:  executionProvider,

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
    const keepMiddleJson = Boolean(config.dump_middle_json);
    const keepModelOutput = Boolean(config.dump_model_output);
    const sourceMarkdown = raw.markdown ?? raw.md_content ?? raw.md ?? '';
    const keepImages = Boolean(
      markdownHasImageRefs(sourceMarkdown)
      || config.dump_middle_json
      || config.dump_model_output
      || config.dump_md_html
      || config.dump_md_docx
    );

    return {
      // Core outputs
      markdown:      sourceMarkdown,
      raw_text:      raw.raw_text    ?? raw.text_content   ?? raw.text     ?? markdownToPlainText(sourceMarkdown),
      content_list:  raw.content_list ?? raw.contentList ?? raw.content_list_json ?? null,
      middle_json:   keepMiddleJson ? (raw.middle_json  ?? raw.middleJson ?? raw.layout_info ?? null) : null,
      model_output:  keepModelOutput ? (raw.model_output ?? raw.modelOutput ?? raw.modelJson ?? null) : null,
      layout_label_blocks: raw.layout_label_blocks ?? raw.layoutLabelBlocks ?? [],

      // Bbox overlays (per-page arrays)
      layout_bboxes: raw.layout_bboxes ?? raw.layoutBboxes ?? [],
      span_bboxes:   raw.span_bboxes   ?? raw.spanBboxes   ?? [],
      layout_dets:   raw.layout_dets    ?? [],
      page_info:     raw.page_info      ?? null,

      // Meta
      page_count:    raw.page_count   ?? raw.pageCount     ?? 1,
      images:        keepImages ? (raw.images ?? {}) : {},

      // Pass-through for downstream use
      _config: config,
      _file:   { name: file.name, size: file.size },
      _timingBreakdown: raw._timingBreakdown ?? null,
      _raw:    keepModelOutput ? raw : null,
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
