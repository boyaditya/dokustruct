/**
 * ui/utils/pipelineAdapter.js
 * Bridge between the UI state and the browser pipeline engine.
 *
 * Responsibilities:
 *  1. Build pipeline config from AppState
 *  2. Drive AppState stages/progress/timings during execution
 *  3. Forward results to AppState on completion
 *  4. Manage asset downloads and abort/cancel signals
 *
 * The actual inference is delegated to the browser engine entry point
 * (rapid_doc/index.js). This adapter translates between the UI contract and the
 * engine API without embedding inference logic.
 */

import { appState } from '../state/appState.js';
import {
  downloadAssetGroup,
  getAssetsStatus,
} from '../../rapid_doc/utils/download_file.js';
import { getFormulaAssets, summarizeAssets } from '../../rapid_doc/utils/model_url_map.js';
import { PDF_PAGES_BATCH, startKeepAlive, stopKeepAlive, yieldToBrowser } from '../../rapid_doc/utils/browser_utils.js';
import {
  setGlobalAbortSignal,
  clearGlobalAbortSignal,
} from '../../rapid_doc/utils/abort_registry.js';
import {
  loadOpenCVScript,
  waitForOpenCV,
} from '../../rapid_doc/utils/opencv_loader.js';

/** Pages per chunk — hard-reset on GPU buffer saturation (~138 pages). */
const VRAM_CHUNK_SIZE = 8;

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
let ortRuntimeConfigPromise = null;

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('Operation aborted', 'AbortError');
  }
}

function isAbortError(error, signal = null) {
  return Boolean(signal?.aborted || error?.name === 'AbortError');
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
    _engineModule = await import('../../rapid_doc/index.js');
  } catch (e) {
    console.error('[pipelineAdapter] rapid_doc/index.js failed to load:', e);
    _engineModule = null;
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
// Resume helpers — save state via IndexedDB + sessionStorage before reload.
// ---------------------------------------------------------------------------

const RESUME_DB = 'DokuStructResume';
const RESUME_DB_LEGACY = 'RapidDocResume'; // pre-rename DB, read-fallback only
const RESUME_STORE = 'state';
const RESUME_KEY = 'dokustruct_resume';
const RESUME_KEY_LEGACY = 'rapiddoc_resume'; // pre-rename key, read-fallback only
let _resumeDb = null;

/** Read the resume marker from sessionStorage, falling back to the legacy key. */
function readResumeMarker() {
  return sessionStorage.getItem(RESUME_KEY) ?? sessionStorage.getItem(RESUME_KEY_LEGACY);
}

/** Remove both current and legacy resume markers. */
function clearResumeMarker() {
  sessionStorage.removeItem(RESUME_KEY);
  sessionStorage.removeItem(RESUME_KEY_LEGACY);
}

async function getResumeDb() {
  if (_resumeDb) return _resumeDb;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RESUME_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(RESUME_STORE); };
    req.onsuccess = () => { _resumeDb = req.result; resolve(req.result); };
    req.onerror = () => reject(req.error);
  });
}

/** Open the legacy resume DB (read-only fallback). Returns null if absent. */
async function getLegacyResumeDb() {
  return new Promise((resolve) => {
    const req = indexedDB.open(RESUME_DB_LEGACY, 1);
    req.onupgradeneeded = () => { /* legacy schema v1 only */ };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

/**
 * Save resume state to IndexedDB + sessionStorage before page reload.
 * sessionStorage holds a lightweight marker; IndexedDB holds the
 * file bytes AND large accumulated objects (content list, images).
 */
async function saveResumeState(state) {
  try {
    const db = await getResumeDb();
    const tx = db.transaction(RESUME_STORE, 'readwrite');

    // Large data → IndexedDB (no size limit).
    tx.objectStore(RESUME_STORE).put(state.fileBytes, 'fileBytes');
    if (state.accumulatedContentList && state.accumulatedContentList.length) {
      tx.objectStore(RESUME_STORE).put(state.accumulatedContentList, 'contentList');
    }
    if (state.accumulatedImages && Object.keys(state.accumulatedImages).length) {
      tx.objectStore(RESUME_STORE).put(state.accumulatedImages, 'images');
    }
    // Persist accumulated pdfInfo so overlay blocks from pre-resume pages survive.
    if (state.accumulatedPdfInfo && state.accumulatedPdfInfo.length) {
      tx.objectStore(RESUME_STORE).put(state.accumulatedPdfInfo, 'pdfInfo');
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });

    // Lightweight marker → sessionStorage (small, survives page reload).
    sessionStorage.setItem(RESUME_KEY, JSON.stringify({
      fileName: state.fileName,
      fileSize: state.fileSize,
      fileType: state.fileType,
      config: state.config,
      startPage: state.startPage,
      totalPages: state.totalPages,
      chunkSize: state.chunkSize,
      accumulatedMarkdown: state.accumulatedMarkdown,
      accumulatedLayoutBlocks: state.accumulatedLayoutBlocks,
      accumulatedPageCount: state.accumulatedPageCount,
      // Tracking elapsed time for resuming timer.
      elapsedSeconds: Math.round((performance.now() - (state._startTime || 0)) / 1000),
    }));
  } catch (e) {
    console.error('[pipelineAdapter] Failed to save resume state:', e.name, e.message);
  }
}

/**
 * Check for saved resume state on page load. Restores from IndexedDB + sessionStorage.
 * @returns {Promise<object|null>}
 */
async function loadResumeState() {
  try {
    const raw = readResumeMarker();
    if (!raw) return null;
    const meta = JSON.parse(raw);

    // Restore from IndexedDB (current DB; falls back to legacy pre-rename DB).
    let db = await getResumeDb();
    let fileBytes, contentList, images, pdfInfo;
    const readAll = (database) => new Promise((resolve) => {
      try {
        const tx = database.transaction(RESUME_STORE, 'readonly');
        const store = tx.objectStore(RESUME_STORE);
        const r1 = store.get('fileBytes');
        const r2 = store.get('contentList');
        const r3 = store.get('images');
        const r4 = store.get('pdfInfo');
        r1.onsuccess = () => { r2.onsuccess = () => { r3.onsuccess = () => { r4.onsuccess = () => {
          resolve([r1.result, r2.result, r3.result, r4.result]);
        }; }; }; };
        r1.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    [fileBytes, contentList, images, pdfInfo] = (await readAll(db)) || [];
    if (!fileBytes) {
      const legacy = await getLegacyResumeDb();
      if (legacy) {
        [fileBytes, contentList, images, pdfInfo] = (await readAll(legacy)) || [];
      }
    }

    if (!fileBytes) return null;

    return {
      ...meta,
      fileBytes,
      accumulatedContentList: contentList || meta.accumulatedContentList || [],
      accumulatedImages: images || {},
      accumulatedPdfInfo: pdfInfo || null,
    };
  } catch {
    return null;
  }
}

/**
 * Clear resume state after successful completion or user cancellation.
 */
async function clearResumeState() {
  clearResumeMarker();
  try {
    const db = await getResumeDb();
    const tx = db.transaction(RESUME_STORE, 'readwrite');
    tx.objectStore(RESUME_STORE).delete('fileBytes');
    tx.objectStore(RESUME_STORE).delete('contentList');
    tx.objectStore(RESUME_STORE).delete('images');
    tx.objectStore(RESUME_STORE).delete('pdfInfo');
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// VRAM chunking helpers — used by _runFullAnalysis to split large PDFs
// into sequential chunks, resetting the GPU device between chunks.
// ---------------------------------------------------------------------------

/** Human-readable labels for each processingStage value emitted by the engine. */
const STAGE_LABELS = {
  preprocessing: 'Preparing document',
  orientation: 'Detecting orientation',
  layout: 'Detecting layout',
  region_collect: 'Collecting regions',
  ocr: 'Recognizing text',
  ocr_det: 'Detecting text regions',
  ocr_rec: 'Recognizing text',
  formula: 'Recognizing formulas',
  table: 'Recognizing tables',
  postprocessing: 'Assembling output',
  loading_models: 'Loading models',
  complete: 'Finishing up',
};

// ---------------------------------------------------------------------------
// Single-page cumulative stage progress
// ---------------------------------------------------------------------------

/**
 * Fixed stage execution order + weights (sum = 1) matching BatchAnalyze's
 * actual flow (orientation → layout → formula → ocr_det → table → ocr_rec).
 * The engine's weighted tracker reports non-monotonic percents because stages
 * are initialized lazily mid-run, so the adapter derives its own monotonic
 * cumulative percent from stage completion fractions. Skipped stages (e.g.
 * formula disabled) redistribute their weight to the remaining stages.
 */
const STAGE_PROGRESS_ORDER = [
  ['orientation', 0.04],
  ['layout', 0.16],
  ['region_collect', 0.02],
  ['formula', 0.16],
  ['ocr_det', 0.20],
  ['table', 0.14],
  ['ocr_rec', 0.20],
  ['complete', 0.08],
];

function createStageProgressAccumulator() {
  const stages = STAGE_PROGRESS_ORDER.map(([key, weight]) => ({
    key, weight, seen: false, done: false, skipped: false,
  }));
  let completedWeight = 0;

  const redistribute = (index) => {
    const stage = stages[index];
    if (!stage || stage.skipped || stage.done) return;
    stage.skipped = true;
    const weight = stage.weight;
    stage.weight = 0;
    const remaining = stages.slice(index + 1).filter((s) => !s.done && !s.skipped);
    if (!remaining.length) {
      stages[stages.length - 1].weight += weight;
      return;
    }
    const total = remaining.reduce((sum, s) => sum + s.weight, 0) || remaining.length;
    for (const s of remaining) s.weight += weight * (s.weight / total);
  };

  const finalize = (stage) => {
    if (!stage.done) {
      stage.done = true;
      completedWeight += stage.weight;
    }
  };

  return {
    /** Returns the new monotonic cumulative percent for this stage event. */
    onStageEvent(stage, current, total) {
      const index = stages.findIndex((s) => s.key === stage);
      if (index < 0) {
        return Math.round(Math.min(100, completedWeight * 100));
      }
      // Stages before this one: skipped if never seen, finalized if they
      // were seen but never reported complete (the pipeline moved on).
      for (let i = 0; i < index; i += 1) {
        const prev = stages[i];
        if (prev.seen && !prev.done && !prev.skipped) finalize(prev);
        else if (!prev.seen && !prev.done && !prev.skipped) redistribute(i);
      }
      const target = stages[index];
      target.seen = true;
      const fraction = total > 0
        ? Math.min(1, Math.max(0, Number(current) / Number(total)))
        : 1;
      if (fraction >= 1) {
        finalize(target);
        return Math.round(Math.min(100, completedWeight * 100));
      }
      const partial = target.done ? 0 : target.weight * fraction;
      return Math.round(Math.min(100, (completedWeight + partial) * 100));
    },
  };
}

/**
 * Lightweight page count — reads PDF metadata only, no rendering.
 * Returns Infinity for corrupt/unreadable PDFs (unchunkable fallback).
 * Image input always counts as a single page.
 * @param {File} file
 * @param {ArrayBuffer} pdfBytes
 * @returns {Promise<number>}
 */
async function getInputPageCount(file, pdfBytes) {
  if (file && isImageFile(file)) return 1;
  try {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    return doc.getPageCount();
  } catch {
    return Infinity;
  }
}

/** PDF-only page count for chunk detection (legacy call sites). */
async function countPdfPages(pdfBytes) {
  return getInputPageCount(null, pdfBytes);
}

/**
 * Offset page_idx in pdf_info and content_list to absolute page numbers
 * after a chunk. Mutates in-place.
 * @param {object[]} pdfInfo
 * @param {object[]} contentList
 * @param {number} offset
 */
function offsetPageIndices(pdfInfo, contentList, offset) {
  if (!offset) return;
  for (const page of pdfInfo || []) {
    if (typeof page.page_idx === 'number') page.page_idx += offset;
  }
  for (const entry of contentList || []) {
    if (typeof entry.page_idx === 'number') entry.page_idx += offset;
  }
}

/**
 * Sum timings keys from two stage-timing objects.
 * @param {object} a
 * @param {object} b
 * @returns {object}
 */
function mergeTimings(a, b) {
  if (!a) return b ? { ...b } : {};
  if (!b) return { ...a };
  const out = { ...a };
  for (const key of Object.keys(b)) {
    out[key] = (out[key] || 0) + (b[key] || 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PipelineAdapter class
// ---------------------------------------------------------------------------

export class PipelineAdapter {
  constructor() {
    this._abortController = null;
    this._lastModelConfigKey = null;
    this._preparedKey = null;
    this._prepareKey = null;
    this._preparePromise = null;
    // Optional UI notification hook: (msg: string, type: 'info'|'success'|'error'|'warning') => void.
    // Set by the app shell (e.g. to showLoading). Kept as a hook — never import
    // UI code here — so the engine stays UI-agnostic.
    this.onNotify = null;
  }

  /**
   * Surface a user-facing message via the onNotify hook (no-op when unset).
   * @param {string} msg
   * @param {'info'|'success'|'error'|'warning'} [type]
   */
  _notify(msg, type = 'info') {
    try {
      this.onNotify?.(msg, type);
    } catch { /* notification must never break the pipeline */ }
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


  // ── Main entry point ──────────────────────────────────────────────────────

  /**
   * Execute the full pipeline for all queued files, driven by appState.
   *
   * @param {import('../state/appState.js').AppState} [state] — defaults to singleton
   */
  async run(state = appState) {
    if (state.get('isProcessing')) return;

    // ── Auto-resume: if we have saved state, skip file check and rebuild file ──
    const resumeRaw = readResumeMarker();
    let file = state.currentFile;
    if (!file && resumeRaw) {
      try {
        const resume = JSON.parse(resumeRaw);
        const db = await getResumeDb();
        const tx = db.transaction(RESUME_STORE, 'readonly');
        const req = tx.objectStore(RESUME_STORE).get('fileBytes');
        const fb = await new Promise((resolve, reject) => {
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        if (fb) {
          file = new File([fb], resume.fileName || 'resume.pdf', {
            type: resume.fileType || 'application/pdf',
          });
          state.patch({ files: [file], currentFileIndex: 0 });
        }
      } catch (e) {
        console.warn('[pipelineAdapter] Failed to rebuild File from resume:', e);
      }
    }

    if (!file) {
      this._notify('No file selected.', 'error');
      return;
    }

    const abortCtrl = new AbortController();
    this._abortController = abortCtrl;
    state.set('abortController', abortCtrl);
    setGlobalAbortSignal(abortCtrl.signal);

    try {
      await this._runSingle(state, file, abortCtrl.signal);
    } finally {
      clearGlobalAbortSignal();
      if (this._abortController === abortCtrl) this._abortController = null;
      state.set('abortController', null);
    }
  }

  // ── Auto-resume after GPU crash + page reload ────────────────────────────

  /**
   * Reconstruct File from IndexedDB, warm up models, and resume chunked
   * processing from where the crash left off. Called by init() on page load
   * when sessionStorage indicates a pending resume.
   * @param {import('../state/appState.js').AppState} [state]
   */
  async _resumeFromCrash(state = appState) {
    const resumeRaw = readResumeMarker();
    if (!resumeRaw) return false;
    let resume;
    try { resume = JSON.parse(resumeRaw); } catch { return false; }
    if (!resume.startPage || resume.startPage <= 0) return false;

    console.debug(
      `[pipelineAdapter] Resuming from crash — page ${resume.startPage}, ` +
      `${resume.accumulatedPageCount} prior pages`
    );

    const db = await getResumeDb();
    const tx = db.transaction(RESUME_STORE, 'readonly');
    const req = tx.objectStore(RESUME_STORE).get('fileBytes');
    const fb = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!fb) {
      this._notify('Resume failed: file data not found.', 'error');
      clearResumeState();
      return false;
    }
    const file = new File([fb], resume.fileName || 'resume.pdf', {
      type: resume.fileType || 'application/pdf',
    });
    // currentFile is a getter deriving from files[currentFileIndex] —
    // we must populate the files array so appState.currentFile resolves.
    state.patch({ files: [file], currentFileIndex: 0 });

    // Re-prepare engine — essential after fresh reload (models not cached)
    startKeepAlive();
    try {
      const signal = new AbortController().signal;
      state.patch({ isProcessing: true, processingStage: 'loading_models' });
      setGlobalAbortSignal(signal);
      await this.prepare(state, file, signal);

      // Run chunked analysis — _runFullAnalysis detects resumeState,
      // restores accumulated content, and starts from the correct chunk.
      state.set('abortController', new AbortController());
      await this._runFullAnalysis(state, file, signal);
      return true;
    } finally {
      clearGlobalAbortSignal();
      stopKeepAlive();
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
      this._notify('Running Full Analysis on image input.', 'info');
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
      // OCR-only has no weighted tracker. For single-page runs the bar stays
      // indeterminate (no meaningful percent between stages); we only update
      // the stage label via direct DOM writes (no state patch, so the UI's
      // progressPercent subscriber never resets the indeterminate bar).
      const emitStageProgress = (stage) => {
        const overlay = document.getElementById('progressOverlay');
        const bar = document.getElementById('progressFill');
        const pct = document.getElementById('progressPercent');
        const title = document.getElementById('progressTitle');
        const isSinglePage = totalPages <= 1;
        overlay?.classList.toggle('is-indeterminate', isSinglePage);
        if (bar) bar.style.width = isSinglePage ? '' : '0%';
        if (pct) pct.textContent = isSinglePage ? '...' : '0%';
        if (title) title.textContent = STAGE_LABELS[stage] || 'Processing...';
      };
      emitStageProgress('ocr');
      for (let i = 0; i < totalPages; i++) {
        throwIfAborted(signal);
        state.updateProgress(i + 1, totalPages);
        state.updateMemory();
        await yieldToBrowser();

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
      emitStageProgress('postprocessing');
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
      this._notify(`OCR complete — ${totalPages} page(s) in ${(total / 1000).toFixed(1)}s`, 'success');

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
      this._notify(`OCR failed: ${err.message ?? err}`, 'error');
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
    /** @type {Array<{imageWriter: any, chunkStart: number}>|null} */
    let _chunkImageWriters = null;

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

      let fileBytes = rawFileBytes.buffer.slice(
        rawFileBytes.byteOffset,
        rawFileBytes.byteOffset + rawFileBytes.byteLength
      );

      // ── Chunk detection for large PDFs ────────────────────────────────────
      const pdfPagesBatch = getDefaultPdfPagesBatch(state);
      const shouldDetectPages = pdfPagesBatch > 0 && !isImageFile(file);
      let totalPages = null;

      if (shouldDetectPages) {
        totalPages = await countPdfPages(fileBytes);
      } else {
        // Image inputs (or windowed mode off) are always a single page, so
        // percent-only progress would jump 0% → 100%. Report the page count
        // anyway so the UI can display an indeterminate bar for these runs.
        totalPages = await getInputPageCount(file, fileBytes);
      }

      // ── Step 3: build pipeline config ─────────────────────────────────────
      const config = this._buildConfig(state, file);

      const chunkSize = config.vram_chunk_size ?? VRAM_CHUNK_SIZE;
      const useChunking = shouldDetectPages && Number.isFinite(totalPages) && totalPages > chunkSize;
      const totalChunks = useChunking ? Math.ceil(totalPages / chunkSize) : 1;

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

      // Progress callback from engine. 'pages' events are page counts for
      // multi-page windowed runs; per-stage events (layout/ocr/formula/...)
      // drive a monotonic cumulative percent for single-page documents via
      // a stage-order accumulator (the engine's weighted tracker is
      // non-monotonic because stages initialize lazily mid-run).
      const stageAccumulator = createStageProgressAccumulator();
      const onProgress = (stage, current, total, percent) => {
        const isPageProgress = stage === 'pages';
        if (isPageProgress && total > 1) {
          // Multi-page windowed run: simple page-based progress.
          if (typeof percent === 'number') {
            state.patch({
              progressPercent: percent,
              progressStage: stage,
              progressCurrent: current,
              progressTotal: total,
            });
          }
        } else if (isPageProgress) {
          // Single-page run finalization (or engine 'pages' echo): keep the
          // accumulated bar; only a numeric percent gets applied.
          if (typeof percent === 'number' && percent >= 100) {
            state.patch({ progressPercent: percent, progressStage: 'complete', progressCurrent: 1, progressTotal: 1 });
          }
        } else {
          // Per-stage event: compute monotonic cumulative percent.
          const cumulative = stageAccumulator.onStageEvent(stage, current, total);
          state.patch({
            progressPercent: cumulative,
            progressStage: stage,
            progressCurrent: current,
            progressTotal: total,
          });
        }
        state.updateMemory();
      };

      // Invoke engine. The API surface may differ; try multiple call styles:
      let rawResult = null;

      if (useChunking) {
        // ── Chunked path: sequential docAnalyze invocations with engineReset ──
        console.debug(
          `[pipelineAdapter] Chunked mode — ${totalPages} pages in ` +
          `${totalChunks} chunks of ≤${chunkSize} pages with engineReset between chunks`
        );

        let accumulatedMarkdown = '';
        let accumulatedContentList = [];
        let accumulatedLayoutBlocks = [];
        let accumulatedImages = {};
        let accumulatedTimings = null;
        let accumulatedPageCount = 0;
        let accumulatedPdfInfo = config.dump_middle_json ? [] : null;
        let lastPageInfo = null;
        let startChunkIdx = 0;
        const allImageWriters = [];

        // ── Resume: restore prior accumulated state after page reload ──
        const resumeState = await loadResumeState();
        if (resumeState) {
          accumulatedMarkdown = resumeState.accumulatedMarkdown || '';
          accumulatedContentList = resumeState.accumulatedContentList || [];
          accumulatedImages = resumeState.accumulatedImages || {};
          accumulatedLayoutBlocks = resumeState.accumulatedLayoutBlocks || [];
          accumulatedPageCount = resumeState.accumulatedPageCount || 0;
          if (resumeState.accumulatedPdfInfo) accumulatedPdfInfo = resumeState.accumulatedPdfInfo;
          if (resumeState.accumulatedTimings) accumulatedTimings = resumeState.accumulatedTimings;
          startChunkIdx = Math.floor(resumeState.startPage / chunkSize);
          // fileBytes are restored from IndexedDB — use them instead of the
          // File API bytes (which won't be available after a page reload).
          const fb = resumeState.fileBytes;
          fileBytes = fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.byteLength);
          // Re-build config from saved state for consistency.
          Object.assign(config, resumeState.config);
          console.debug(
            `[pipelineAdapter] Resumed from page ${resumeState.startPage} — ` +
            `${accumulatedPageCount} pages already accumulated`
          );
          await clearResumeState();
        }

        // Pre-slice sub-PDFs once from a single pdf-lib load. Each chunk
        // internally calls convertPdfBytesToBytesByPypdfium2 which loads
        // the full PDF. After ~15 loads, pdf-lib corrupts. Pre-slicing
        // avoids repeated full-document parsing.
        const subPdfList = [];
        {
          const { PDFDocument: PdfLib } = await import('pdf-lib');
          const src = await PdfLib.load(fileBytes, { ignoreEncryption: true });
          for (let ci = 0; ci < totalChunks; ci++) {
            const s = ci * chunkSize;
            const e = Math.min(s + chunkSize - 1, totalPages - 1);
            const idx = [];
            for (let i = s; i <= e; i++) idx.push(i);
            const out = await PdfLib.create();
            const pages = await out.copyPages(src, idx);
            for (const p of pages) out.addPage(p);
            subPdfList.push(await out.save());
          }
        }

        // Per-chunk streaming accumulator — concat across chunks so the UI
        // shows progressive total markdown, not just the current chunk's.
        let prevChunksMarkdown = '';
        let prevChunksContentList = [];

        for (let chunkIdx = startChunkIdx; chunkIdx < totalChunks; chunkIdx++) {
          throwIfAborted(signal);
          const chunkStart = chunkIdx * chunkSize;
          const chunkEnd = Math.min(chunkStart + chunkSize - 1, totalPages - 1);
          const chunkPages = chunkEnd - chunkStart + 1;

          console.debug(
            `[pipelineAdapter] Chunk ${chunkIdx + 1}/${totalChunks} — ` +
            `pages ${chunkStart}-${chunkEnd} (${chunkPages} pages)`
          );

          const chunkOnProgress = (stage, current, _total, _percent) => {
            // Stage events only flow from 1-page chunks (singlePageDocument).
            // Map them to an end-of-chunk page count so the overall bar stays
            // monotonic instead of resetting to small stage percents.
            if (stage !== 'pages') {
              const donePages = chunkStart + chunkPages;
              onProgress('pages', donePages, totalPages, Math.round((donePages / Math.max(1, totalPages)) * 100));
              return;
            }
            const overallCurrent = chunkStart + current;
            const overallTotal = totalPages;
            const overallPct = Math.round((overallCurrent / overallTotal) * 100);
            onProgress(stage, overallCurrent, overallTotal, overallPct);
          };

          // ── Execute this chunk ──
          let docResult;
          try {
            docResult = await engine.docAnalyze(
            [subPdfList[chunkIdx]],
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
              start_page_id:  0,  // sub-PDF already sliced to this chunk
              end_page_id:    null,
              pdf_pages_batch: pdfPagesBatch,
              on_progress:    chunkOnProgress,
              // Let the engine fire per-window streaming callbacks so the UI
              // updates incrementally within each chunk. The adapter's
              // streamingImageWriter is chunk-scoped — each chunk gets its own.
              on_window_result: async ({ markdown: wMarkdown, contentList: wContentList, pageCount: wPageCount, imageWriter }) => {
                const chunkImages = imageWriter
                  ? await this._collectImageMap(imageWriter)
                  : {};
                Object.assign(accumulatedImages, chunkImages);
                // Prepend previous chunks' markdown so streaming shows full
                // document so far, not just current chunk's pages.
                const fullMarkdown = prevChunksMarkdown
                  ? prevChunksMarkdown + '\n\n' + wMarkdown
                  : wMarkdown;
                const fullContentList = prevChunksContentList
                  ? [...prevChunksContentList, ...wContentList]
                  : [...wContentList];
                const absolutePageCount = chunkStart + wPageCount;
                state.updatePartialResults({
                  markdown: fullMarkdown,
                  contentList: fullContentList,
                  pageCount: absolutePageCount,
                  images: accumulatedImages,
                });
                state.updateMemory();
              },
            }
          );
          } catch (chunkErr) {
            if (isAbortError(chunkErr, signal)) throw chunkErr;
            console.warn(
              `[pipelineAdapter] Chunk ${chunkIdx + 1} crashed: ` +
              formatPipelineError(chunkErr)
            );
            // Save resume state and reload the page.
            // The GPU device is permanently dead after a native ORT crash —
            // only a browser page reload can get a fresh GPU adapter + WASM
            // heap. sessionStorage survives the reload.
            await saveResumeState({
              fileBytes: new Uint8Array(fileBytes.slice(0)),
              fileName: file.name,
              fileSize: file.size,
              fileType: file.type,
              config: this._buildConfig(state, file),
              startPage: chunkStart,
              totalPages,
              chunkSize,
              accumulatedMarkdown,
              accumulatedContentList,
              accumulatedImages,
              accumulatedLayoutBlocks,
              accumulatedPageCount,
              accumulatedPdfInfo,
              accumulatedTimings,
              _startTime: this._resumeStartTime || 0,
            });
            location.reload();
            return null; // unreachable — reload stops execution
          }

          if (!docResult || !docResult._windowed) {
            throw new Error(
              `Chunk ${chunkIdx + 1} did not return windowed mode result. ` +
              `This is unexpected — all chunks should use windowed processing.`
            );
          }

          const { pdf_info: pdfInfo, imageWriter, pipelineTimings } = docResult;
          allImageWriters.push({ imageWriter, chunkStart });

          const tMarkdown0 = performance.now();
          let markdown = engine.unionMake(pdfInfo, 'mm_markdown', 'images') || '';
          postBreakdown.markdown_union_ms += performance.now() - tMarkdown0;

          const tContent0 = performance.now();
          const chunkContentList = engine.unionMake(pdfInfo, 'content_list', 'images') || [];
          postBreakdown.content_list_union_ms += performance.now() - tContent0;

          // Offset page_idx to absolute page numbers AFTER unionMake, so
          // unionMake reads chunk-relative pages and we offset the output.
          offsetPageIndices(pdfInfo, chunkContentList, chunkStart);

          const markdownHasContent = textHasContent(markdown);
          const contentListHasContent = hasMeaningfulContentList(chunkContentList);
          if (!markdownHasContent && !contentListHasContent) {
            const searchableFallback = extractSearchableTextFallback([]);
            if (searchableFallback.markdown) {
              markdown = searchableFallback.markdown;
              chunkContentList.length = 0;
              chunkContentList.push(...searchableFallback.contentList);
            }
          }

          const shouldKeepImages = Boolean(
            markdownHasImageRefs(markdown)
            || config.dump_middle_json
            || config.dump_model_output
            || config.dump_md_html
            || config.dump_md_docx
          );

          // ── Accumulate into merged result ──
          if (chunkIdx === 0) {
            accumulatedMarkdown = markdown;
          } else {
            accumulatedMarkdown += '\n\n' + markdown;
          }
          if (shouldKeepImages) {
            const chunkImages = await this._collectImageMap(imageWriter);
            Object.assign(accumulatedImages, chunkImages);
          }
          accumulatedContentList.push(...chunkContentList);
          accumulatedLayoutBlocks.push(...extractLayoutLabelBlocks({ pdf_info: pdfInfo }));
          accumulatedPageCount += pdfInfo.length;
          accumulatedTimings = mergeTimings(accumulatedTimings, pipelineTimings);
          if (accumulatedPdfInfo) accumulatedPdfInfo.push(...pdfInfo);
          if (!lastPageInfo && pdfInfo[0]?.page_size) {
            lastPageInfo = { width: pdfInfo[0].page_size[0], height: pdfInfo[0].page_size[1] };
          }

          // When a chunk returns 0 pages, the GPU device's internal buffer
          // pool is saturated. engineReset + model reload cannot revive a
          // damaged pool — subsequent chunks will trigger native ORT crashes
          // that kill the JS renderer process before we can save state.
          // Save now and reload to get a fresh GPU adapter.
          if (pdfInfo.length === 0 && chunkIdx > 0) {
            console.warn(
              `[pipelineAdapter] Chunk ${chunkIdx + 1} returned 0 pages — ` +
              `GPU pool saturated. Saving state and reloading for fresh GPU.`
            );
            await saveResumeState({
              fileBytes: new Uint8Array(fileBytes.slice(0)),
              fileName: file.name,
              fileSize: file.size,
              fileType: file.type,
              config: this._buildConfig(state, file),
              startPage: chunkStart,
              totalPages,
              chunkSize,
              accumulatedMarkdown,
              accumulatedContentList,
              accumulatedLayoutBlocks,
              accumulatedPageCount,
              accumulatedImages,
              accumulatedPdfInfo,
              accumulatedTimings,
              _startTime: this._resumeStartTime || 0,
            });
            location.reload();
            return null; // unreachable
          }

          // ── Snapshot for next chunk's streaming callback ──
          prevChunksMarkdown = accumulatedMarkdown;
          prevChunksContentList = [...accumulatedContentList];

          // ── Streaming: update UI incrementally after each chunk ──
          state.updatePartialResults({
            markdown: accumulatedMarkdown,
            contentList: accumulatedContentList,
            pageCount: accumulatedPageCount,
            images: accumulatedImages,
          });
        }

        // ── Build merged rawResult for downstream normalisation ──
        rawResult = {
          markdown: accumulatedMarkdown,
          content_list: accumulatedContentList,
          middle_json: config.dump_middle_json ? { pdf_info: accumulatedPdfInfo || [] } : null,
          model_output: config.dump_model_output ? [] : null,
          layout_label_blocks: accumulatedLayoutBlocks,
          page_count: accumulatedPageCount,
          images: accumulatedImages,
          layout_dets: [],
          page_info: lastPageInfo,
          _timings: accumulatedTimings,
        };

        // Preserve all imageWriters for cleanup in finally block
        _chunkImageWriters = allImageWriters;

        console.debug(
          `[pipelineAdapter] Chunked processing complete — ` +
          `${totalChunks} chunks, ${accumulatedPageCount} pages, ` +
          `${accumulatedMarkdown.length} chars markdown, ` +
          `${accumulatedContentList.length} content items`
        );
      } else {
        // ── Single-run path (unchunked, includes small PDFs and image files) ──
        // Streaming callback for windowed processing — updates UI incrementally
        let streamingImageWriter = null;
        const onWindowResult = pdfPagesBatch > 0
          ? async ({ markdown, contentList, pageCount, imageWriter }) => {
              streamingImageWriter = streamingImageWriter || imageWriter;
              console.debug(`[adapter] onWindowResult fired — markdown: ${(markdown || '').length} chars, pages: ${pageCount}, contentList: ${contentList?.length ?? 0} items`);
              const images = streamingImageWriter
                ? await this._collectImageMap(streamingImageWriter)
                : {};
              state.updatePartialResults({ markdown, contentList, pageCount, images });
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
      // Surface recoverable stage skips instead of silently degrading output
      //.
      const skipCount = results?._stageSkipWarnings?.length ?? 0;
      if (skipCount > 0) {
        this._notify(`Some content could not be extracted (${skipCount} issue(s) — see console).`, 'warning');
      } else {
        this._notify('Document processed successfully.', 'success');
      }

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
      this._notify(`Processing failed: ${message}`, 'error');
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
        // Clean up per-chunk imageWriters (chunked path)
        if (Array.isArray(_chunkImageWriters)) {
          for (const { imageWriter } of _chunkImageWriters) {
            if (imageWriter && imageWriter.files && typeof imageWriter.files === 'object') {
              for (const k of Object.keys(imageWriter.files)) delete imageWriter.files[k];
            }
          }
          _chunkImageWriters = null;
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
      const isWebGpu = String(state.get('activeExecutionProvider') || '').toLowerCase() === 'webgpu';
      // Reserve one CPU core for the main thread when running WASM: the pool
      // gets hardwareConcurrency-1 threads, leaving a core free for UI input/
      // rendering — this is what prevents the "laggy at 100% CPU" symptom
      // without reducing inference throughput.
      const { setReserveMainThreadCore } = await import('../../rapid_doc/utils/ort_runtime.js');
      setReserveMainThreadCore(!isWebGpu);
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

}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** @type {PipelineAdapter} */
export const pipelineAdapter = new PipelineAdapter();
