/**
 * ui/app.js
 * DocParsing UI - document processing workspace
 */

import { appState } from './state/appState.js';
import { pipelineAdapter } from './utils/pipelineAdapter.js';
import { getPdfjsLib } from '../rapid_doc/utils/pdfjs_loader.js';
import { getAssetDetailRows } from '../rapid_doc/utils/model_url_map.js';
import { sanitizeFormulaLatex } from '../rapid_doc/model/formula/fix_utils.js';
import { marked } from 'marked';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { createDisposerChain } from './lifecycle/disposerChain.js';
import { createListenerBag } from './lifecycle/listenerBag.js';
import { createSubscriptionBag } from './lifecycle/subscriptionBag.js';
import { createRafCoalescer } from './perf/rafCoalescer.js';
import { scheduleIdleWork } from './perf/idleScheduler.js';
import { ctx as linkingCtx, initLinkingContext } from './linking/index.js';
import {
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  FilePlus2,
  FileText,
  Folder,
  Image as ImageIcon,
  Maximize2,
  Menu,
  Play,
  Plus,
  Settings,
  Shield,
  Scan,
  ScanLine,
  Square,
  Timer,
  TriangleAlert,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
  createIcons,
} from 'lucide';
import 'katex/dist/katex.min.css';
import { initHistoryList, loadHistory as _loadHistoryList } from './history/list.js';
import { initHistoryReload, loadHistoryItem as _loadHistoryItemReload } from './history/reload.js';
import { initConnectorsRenderer, renderMergeConnectors as _renderMergeConnectors, scheduleRenderMergeConnectors as _scheduleRenderMergeConnectors, syncGlobalMergeConnectorLayer as _syncGlobalMergeConnectorLayer } from './render/connectors.js';
import { initStylingRenderer, applyLayoutBasedStyling as _applyLayoutBasedStyling } from './render/styling.js';
import { initActionsRenderer, attachBlockActions as _attachBlockActions, isMediaOutputBlock as _isMediaOutputBlock, isStandaloneDisplayFormulaBlock as _isStandaloneDisplayFormulaBlock, blockHasFormula as _blockHasFormula, extractBlockLinkText as _extractBlockLinkText, hoistDisplayFormulaPlaceholders as _hoistDisplayFormulaPlaceholders } from './render/actions.js';

const UI_LOG_PREFIX = '[DocParsing UI]';

function hasKatexRenderError(html) {
  return html.includes('katex-error')
    || html.includes('mathcolor="#cc0000"')
    || html.includes('<merror');
}

const lucideIcons = {
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  FilePlus2,
  FileText,
  Folder,
  Image: ImageIcon,
  Maximize2,
  Menu,
  Play,
  Plus,
  Scan,
  ScanLine,
  Settings,
  Shield,
  Square,
  Timer,
  TriangleAlert,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
};
const refreshIcons = () => {
  try {
    createIcons({ icons: lucideIcons });
  } catch (error) {
    console.warn(`${UI_LOG_PREFIX} Failed to render icons:`, error);
  }
};

let exportUtilsPromise = null;

async function getExportUtils() {
  if (!exportUtilsPromise) {
    exportUtilsPromise = import('./utils/exportUtils.js').then((module) => module.exportUtils);
  }
  return exportUtilsPromise;
}

// ===== HISTORY STORAGE =====
const LEGACY_STORAGE_PREFIX = ['rapid', 'doc'].join('');
const OLD_HISTORY_KEY = `${LEGACY_STORAGE_PREFIX}_history`;
const HISTORY_KEY = 'docparsing_history';
const OLD_HISTORY_ASSET_DB = `${LEGACY_STORAGE_PREFIX}_history_assets`;
const HISTORY_ASSET_DB = 'docparsing_history_assets';
const HISTORY_ASSET_STORE = 'assets';
const MAX_HISTORY = 50;
const KEEP_HISTORY_ARTIFACTS = true;
const OLD_OVERLAY_VISIBLE_KEY = `${LEGACY_STORAGE_PREFIX}_overlay_visible`;
const OVERLAY_VISIBLE_KEY = 'docparsing_overlay_visible';
const UI_PREFS_KEY = 'docparsing_ui_preferences';

function migrateUiStorage() {
  if (localStorage.getItem(HISTORY_KEY) == null) {
    const oldHistory = localStorage.getItem(OLD_HISTORY_KEY);
    if (oldHistory != null) localStorage.setItem(HISTORY_KEY, oldHistory);
  }
  if (localStorage.getItem(OVERLAY_VISIBLE_KEY) == null) {
    const oldOverlay = localStorage.getItem(OLD_OVERLAY_VISIBLE_KEY);
    if (oldOverlay != null) localStorage.setItem(OVERLAY_VISIBLE_KEY, oldOverlay);
  }
}

function getUiPrefs() {
  try {
    return JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}') || {};
  } catch (err) {
    console.warn('[getUiPrefs] Failed to parse UI prefs:', err);
    return {};
  }
}

function saveUiPrefs(patch) {
  localStorage.setItem(UI_PREFS_KEY, JSON.stringify({ ...getUiPrefs(), ...patch }));
}

function openHistoryAssetDb(dbName = HISTORY_ASSET_DB) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HISTORY_ASSET_STORE)) {
        db.createObjectStore(HISTORY_ASSET_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function writeHistoryAsset(key, value) {
  const db = await openHistoryAssetDb(HISTORY_ASSET_DB);
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_ASSET_STORE, 'readwrite');
      tx.objectStore(HISTORY_ASSET_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function readHistoryAsset(key) {
  let db = await openHistoryAssetDb(HISTORY_ASSET_DB);
  try {
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_ASSET_STORE, 'readonly');
      const req = tx.objectStore(HISTORY_ASSET_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (value !== undefined) return value;
  } finally {
    db.close();
  }

  db = await openHistoryAssetDb(OLD_HISTORY_ASSET_DB);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_ASSET_STORE, 'readonly');
      const req = tx.objectStore(HISTORY_ASSET_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function deleteHistoryAsset(key) {
  if (!key) return;
  for (const dbName of [HISTORY_ASSET_DB, OLD_HISTORY_ASSET_DB]) {
    const db = await openHistoryAssetDb(dbName);
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_ASSET_STORE, 'readwrite');
        tx.objectStore(HISTORY_ASSET_STORE).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
}

function getHistoryAssetKeys(item) {
  return [
    item?.imagesKey,
    item?.previewPagesKey,
    item?.middleJsonKey,
    item?.modelJsonKey,
    item?.markdownKey,
    item?.contentListKey,
    item?.overlayBlocksKey,
    item?.layoutLabelBlocksKey,
  ].filter(Boolean);
}

async function deleteHistoryAssets(item) {
  await Promise.allSettled(getHistoryAssetKeys(item).map(key => deleteHistoryAsset(key)));
}

function hasMarkdownImageRefs(markdown) {
  return /!\[[^\]]*\]\([^)]+\)|<img\b/i.test(String(markdown || ''));
}

function hasStoredImages(images) {
  return images && typeof images === 'object' && Object.keys(images).length > 0;
}

function canvasToHistoryDataUrl(canvas) {
  if (!canvas || !canvas.width || !canvas.height) return null;
  try {
    const maxSide = 1200;
    const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    if (scale >= 1) return canvas.toDataURL('image/jpeg', 0.72);

    const preview = document.createElement('canvas');
    preview.width = Math.max(1, Math.round(canvas.width * scale));
    preview.height = Math.max(1, Math.round(canvas.height * scale));
    const ctx = preview.getContext('2d');
    ctx.drawImage(canvas, 0, 0, preview.width, preview.height);
    return preview.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

function makeHistoryPreviewDataUrl() {
  return canvasToHistoryDataUrl(sourceCanvas) || canvasToHistoryDataUrl(el.pdfCanvas);
}

function makeHistoryPreviewPagesDataUrls() {
  const pages = renderedPages
    .map(record => canvasToHistoryDataUrl(record.canvas))
    .filter(Boolean);
  if (pages.length) return pages;
  const fallback = makeHistoryPreviewDataUrl();
  return fallback ? [fallback] : [];
}

function getResultArtifact(source, ...keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

async function persistHistoryJsonArtifact(historyKey, suffix, value) {
  if (value == null) return null;
  const key = `${suffix}:${historyKey}`;
  try {
    await writeHistoryAsset(key, value);
    return key;
  } catch (err) {
    console.warn(`${UI_LOG_PREFIX} Failed to persist ${suffix} artifact:`, err);
    return null;
  }
}

async function readHistoryStoredValue(item, keyProp, label, fallback) {
  if (!item?.[keyProp]) return fallback;
  try {
    const value = await readHistoryAsset(item[keyProp]);
    return value !== undefined && value !== null ? value : fallback;
  } catch (err) {
    console.warn(`${UI_LOG_PREFIX} Failed to load history ${label}:`, err);
    return fallback;
  }
}

function makeHistoryFileKey(file) {
  return [
    file.name || '',
    file.size || 0,
    file.type || '',
    file.lastModified || 0,
  ].join('|');
}

function isSameHistoryFile(item, file, historyKey) {
  if (item.historyKey && item.historyKey === historyKey) return true;
  return item.fileName === file.name && item.fileSize === file.size;
}

function isQuotaExceededError(err) {
  return err?.name === 'QuotaExceededError' ||
    err?.code === 22 ||
    err?.code === 1014 ||
    String(err?.message || '').toLowerCase().includes('quota');
}

function compactHistoryItemForMetadata(item) {
  const compact = { ...item };
  if (compact.markdownKey) delete compact.markdown;
  if (compact.contentListKey) delete compact.contentList;
  if (compact.overlayBlocksKey) delete compact.overlayBlocks;
  if (compact.layoutLabelBlocksKey) delete compact.layoutLabelBlocks;
  if (compact.imagesKey) delete compact.images;
  if (compact.previewPagesKey) delete compact.thumbnail;
  return compact;
}

function stripInlineHistoryPayload(item) {
  const compact = compactHistoryItemForMetadata(item);
  delete compact.markdown;
  delete compact.contentList;
  delete compact.overlayBlocks;
  delete compact.layoutLabelBlocks;
  delete compact.images;
  delete compact.thumbnail;
  return compact;
}

async function saveHistoryMetadata(history) {
  let working = history.map(compactHistoryItemForMetadata);
  let strippedInlinePayloads = false;

  while (working.length) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(working));
      return working;
    } catch (err) {
      if (!isQuotaExceededError(err)) throw err;
      if (!strippedInlinePayloads) {
        working = working.map(stripInlineHistoryPayload);
        strippedInlinePayloads = true;
        continue;
      }
      const removed = working.pop();
      await deleteHistoryAssets(removed);
    }
  }

  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch { /* ignore */ }
  console.warn(`${UI_LOG_PREFIX} History metadata exceeded storage quota; history was cleared.`);
  return [];
}

async function saveToHistory(file, results) {
  try {
    const history = getHistory();
    const historyKey = makeHistoryFileKey(file);
    const matching = history.filter(item => isSameHistoryFile(item, file, historyKey));
    const previous = matching[0] ?? null;
    const id = previous?.id ?? Date.now();
    const images = results.images || {};
    const contentList = getResultArtifact(results, 'content_list', 'contentList', 'content_list_json') || [];
    const middleJson = getResultArtifact(results, 'middle_json', 'middleJson', 'layout_info');
    const modelJson = getResultArtifact(results, 'model_output', 'modelOutput', 'modelJson');
    const blocksForHistory = linkedBlocks.length ? linkedBlocks : buildOverlayBlocks(results);
    const markdown = results.markdown || '';
    const overlayBlocks = blocksForHistory.map(block => ({
      id: block.id,
      mergeGroupId: block.mergeGroupId,
      pageIndex: block.pageIndex,
      bbox: block.bbox,
      sourceSize: block.sourceSize,
      label: block.label,
      type: block.type,
      originalLabel: block.originalLabel,
      category: block.category,
      text: block.text,
      source: block.source,
      contentIndex: block.contentIndex,
      middleOriginalOrder: block.middleOriginalOrder,
      middleIndex: block.middleIndex,
      sourcePageIndex: block.sourcePageIndex,
      sourcePreprocOrders: block.sourcePreprocOrders,
    }));
    const layoutLabelBlocks = results.layout_label_blocks || [];
    const markdownKey = await persistHistoryJsonArtifact(historyKey, 'markdown', markdown);
    const contentListKey = KEEP_HISTORY_ARTIFACTS
      ? await persistHistoryJsonArtifact(historyKey, 'content-list', contentList)
      : null;
    const middleJsonKey = await persistHistoryJsonArtifact(historyKey, 'middle-json', middleJson);
    const modelJsonKey = await persistHistoryJsonArtifact(historyKey, 'model-json', modelJson);
    const layoutLabelBlocksKey = await persistHistoryJsonArtifact(historyKey, 'layout-label-blocks', layoutLabelBlocks);
    const overlayBlocksKey = await persistHistoryJsonArtifact(historyKey, 'overlay-blocks', overlayBlocks);
    let imagesKey = null;
    let inlineImages = {};
    if (hasMarkdownImageRefs(results.markdown) && hasStoredImages(images)) {
      imagesKey = `images:${historyKey}`;
      try {
        await writeHistoryAsset(imagesKey, images);
      } catch (err) {
        console.warn(`${UI_LOG_PREFIX} Failed to persist history images:`, err);
        imagesKey = null;
        inlineImages = images;
      }
    }

    const previewPages = makeHistoryPreviewPagesDataUrls();
    let previewPagesKey = null;
    if (previewPages.length) {
      previewPagesKey = `preview-pages:${historyKey}`;
      try {
        await writeHistoryAsset(previewPagesKey, previewPages);
      } catch (err) {
        console.warn(`${UI_LOG_PREFIX} Failed to persist history preview pages:`, err);
        previewPagesKey = null;
      }
    }
    
    const item = {
      id,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      fileLastModified: file.lastModified || 0,
      historyKey,
      timestamp: new Date().toISOString(),
      markdown: markdownKey ? '' : markdown,
      markdownKey,
      contentList: contentListKey ? [] : (KEEP_HISTORY_ARTIFACTS ? contentList : []),
      contentListKey,
      pageCount: results.page_count || 1,
      processingTotalMs: Number(currentStageTimings?.total || appState.get('timings')?.total || results.timings?.total || results._timings?.total || results.processingTotalMs || 0),
      runConfig: currentRunConfig || getCurrentRunConfig(),
      stageTimings: currentStageTimings || getStageTimingsFromResults(results),
      thumbnail: previewPagesKey ? null : (previewPages[0] || makeHistoryPreviewDataUrl()),
      previewPagesKey,
      previewPageCount: previewPages.length || 0,
      images: inlineImages,
      imagesKey,
      middleJsonKey,
      modelJsonKey,
      layoutLabelBlocks: layoutLabelBlocksKey ? [] : layoutLabelBlocks,
      layoutLabelBlocksKey,
      overlayBlocks: overlayBlocksKey ? [] : overlayBlocks,
      overlayBlocksKey,
    };

    const duplicateAssets = matching
      .flatMap(getHistoryAssetKeys)
      .filter(key => !getHistoryAssetKeys(item).includes(key));
    await Promise.allSettled(duplicateAssets.map(key => deleteHistoryAsset(key)));

    for (let idx = history.length - 1; idx >= 0; idx--) {
      if (isSameHistoryFile(history[idx], file, historyKey)) {
        history.splice(idx, 1);
      }
    }
    history.unshift(item);
    const removed = history.splice(MAX_HISTORY);
    await Promise.allSettled(removed.map(entry => deleteHistoryAssets(entry)));
    
    const savedHistory = await saveHistoryMetadata(history);
    if (!savedHistory.some(entry => entry.id === item.id)) {
      await deleteHistoryAssets(item);
    }
    loadHistory();
  } catch (err) {
    if (isQuotaExceededError(err)) {
      console.warn(`${UI_LOG_PREFIX} Failed to save history due to storage quota:`, err);
    } else {
      console.error(`${UI_LOG_PREFIX} Failed to save history:`, err);
    }
  }
}

function getHistory() {
  try {
    const data = localStorage.getItem(HISTORY_KEY);
    return data ? JSON.parse(data) : [];
  } catch (err) {
    console.warn('[getHistory] Failed to parse history:', err);
    return [];
  }
}

function loadHistory() {
  _loadHistoryList();
}

async function loadHistoryItem(item) {
  return _loadHistoryItemReload(item);
}

function renderHistoryThumbnail(thumbnailDataUrl) {
  renderHistoryPreviewPages([thumbnailDataUrl]);
}

function renderHistoryPreviewPages(previewPageDataUrls) {
  if (!el.emptyViewer) return;
  const sources = Array.isArray(previewPageDataUrls) ? previewPageDataUrls.filter(Boolean) : [];
  if (!sources.length) {
    showEmptyViewer();
    return;
  }

  let loaded = 0;
  let failed = false;
  const images = sources.map(() => new window.Image());
  images.forEach((img, index) => {
    img.onload = () => {
      loaded += 1;
      if (loaded !== sources.length || failed) return;
      resetPageStack();
      images.forEach((pageImg, index) => {
        const record = index === 0 ? getPageRecord(0) : createDocumentPage(index);
        if (!record) return;
        const { canvas } = record;
        canvas.width = pageImg.width;
        canvas.height = pageImg.height;
        record.sourceSize = { width: pageImg.width, height: pageImg.height };
        canvas.getContext('2d').drawImage(pageImg, 0, 0);
        canvas.style.display = 'block';
      });
      showPageStack();
      applyZoom();
      renderLayoutOverlay();
    };
    img.onerror = () => {
      failed = true;
      showEmptyViewer();
    };
    img.src = sources[index];
  });
}

async function deleteHistoryItem(id) {
  const history = getHistory();
  const item = history.find(item => item.id === id);
  await deleteHistoryAssets(item);
  await saveHistoryMetadata(history.filter(item => item.id !== id));
  loadHistory();
  showLoading('Item deleted');
}

function requestHistoryDelete(id) {
  const item = getHistory().find(item => item.id === id);
  if (!item) return;
  pendingHistoryDeleteId = id;
  if (el.confirmMessage) {
    el.confirmMessage.textContent = `${item.fileName || 'This document'} will be removed from history.`;
  }
  el.confirmBackdrop?.classList.remove('hidden');
  el.confirmDialog?.classList.remove('hidden');
  refreshIcons();
  requestAnimationFrame(() => el.confirmCancelBtn?.focus());
}

function closeHistoryDeleteConfirm() {
  pendingHistoryDeleteId = null;
  el.confirmBackdrop?.classList.add('hidden');
  el.confirmDialog?.classList.add('hidden');
}

async function confirmHistoryDelete() {
  if (!pendingHistoryDeleteId) return;
  const id = pendingHistoryDeleteId;
  closeHistoryDeleteConfirm();
  await deleteHistoryItem(id);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function formatDuration(ms) {
  if (!ms || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function getSelectOptionLabel(selectEl) {
  return selectEl?.selectedOptions?.[0]?.textContent?.trim() || selectEl?.value || '-';
}

function getCurrentRunConfig() {
  return {
    layoutModel: el.layoutModel?.value || 'v2',
    layoutModelLabel: getSelectOptionLabel(el.layoutModel),
    ocrModel: el.ocrModel?.value || 'ch',
    ocrLabel: getSelectOptionLabel(el.ocrModel),
    executionProvider: el.executionProvider?.value || appState.get('activeExecutionProvider') || 'wasm',
    executionProviderLabel: getSelectOptionLabel(el.executionProvider),
    formulaEnable: Boolean(el.formulaEnable?.checked),
    formulaModel: el.formulaModel?.value || 'pp_formulanet_plus_s',
    formulaModelLabel: getSelectOptionLabel(el.formulaModel),
    tableEnable: Boolean(el.tableEnable?.checked),
    tableModel: el.tableModel?.value || 'unet_slanet_plus',
    tableModelLabel: getSelectOptionLabel(el.tableModel),
  };
}

function getStageTimingsFromResults(results = null) {
  const timings = appState.get('timings') || {};
  const startupTimings = appState.get('startupTimings') || {};
  const raw = results?.timings || results?._timings || {};
  const read = (...keys) => {
    for (const key of keys) {
      const value = Number(timings[key] ?? raw[key] ?? 0);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
  };
  return {
    models: Number(startupTimings.total || 0),
    preprocessing: read('preprocessing'),
    // Fall back to warmup model-warming time when engine reports 0 (model cached from warmup)
    model_init: read('model_init') || Number(startupTimings.layout || 0),
    pdf_load: read('pdf_load'),
    orientation: read('orientation'),
    layout: read('layout', 'layout'),
    region_collect: read('region_collect'),
    ocr_det: read('ocr_det'),
    ocr_rec: read('ocr_rec'),
    ocr: read('ocr'),
    formula: read('formula'),
    table: read('table'),
    reading_order: read('reading_order', 'reading_order'),
    postprocessing: read('postprocessing'),
    total_inference: read('total_inference'),
    other: read('other'),
    total: read('total') || Number(results?.timings?.total || results?._timings?.total || results?.processingTotalMs || 0),
  };
}

function normalizeHistoryStageTimings(stageTimings = null, processingTotalMs = 0) {
  const timings = { ...emptyTimingSet(), ...(stageTimings || {}) };
  const total = Number(timings.total || processingTotalMs || 0);
  timings.total = Number.isFinite(total) ? total : 0;
  return timings;
}

function formatRunConfigSummary(runConfig = currentRunConfig) {
  if (!runConfig) return '';
  return [
    runConfig.ocrLabel || '-',
    runConfig.executionProviderLabel || '-',
    runConfig.formulaLabel || '',
    runConfig.tableLabel || '',
  ].filter(Boolean).join(' · ');
}

// ===== STATE =====
let selectedFiles = [];
let currentFileIndex = 0;
let currentFile = null;
let currentFileType = null; // 'image' or 'pdf'
let sourceCanvas = null;
let pdfDocument = null;
let pdfLoadingTask = null;
let currentZoom = 0.3;
let currentPage = 1;
let totalPages = 1;
let isDraggingResize = false;
let resizeStartX = 0;
let resizeStartWidth = 0;
let processingStartTime = 0;
let elapsedTimeInterval = null;
const thumbnailObjectUrls = new Set();
const filePreviewUrls = new WeakMap();
let renderedPages = [];
let linkedBlocks = [];
let activeLinkId = null;
let activeGroupId = '';
let pinnedLinkId = null;
let pinnedGroupId = '';
let pinReleaseListener = null;
let scrollSyncFrame = null;
let isSyncingScroll = false;
let overlayVisible = true;
let syncedPageIndex = null;
let syncedLinkId = null;
let activeDrawerId = null;
let lastDrawerTrigger = null;
let exportCloseTimer = null;
let overlayRenderFrame = null;
let mergeConnectorFrame = null;let overlayResizeObserver = null;
let workspaceMode = 'setup';
let setupTab = 'upload';
let pendingHistoryDeleteId = null;
let currentRunConfig = null;
let currentStageTimings = null;
let warmupTimer = null;
let warmupAbortController = null;
let requiredAssetsReady = false;
let assetSummary = null;
let formulaAssetSummary = null;
let assetRefreshToken = 0;
let assetDownloadController = null;

// ===== DOM ELEMENTS =====
const el = {};

function getPreviewScrollEl() {
  return el.viewerScroll || el.viewerPane || null;
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch { /* ignore */ }
}

async function cleanupPdfPreview() {
  if (pdfLoadingTask) {
    try { await pdfLoadingTask.destroy?.(); } catch { /* ignore */ }
    pdfLoadingTask = null;
  }
  if (pdfDocument) {
    try { await pdfDocument.cleanup?.(); } catch { /* ignore */ }
    try { await pdfDocument.destroy?.(); } catch { /* ignore */ }
    pdfDocument = null;
  }
}

function revokeThumbnailObjectUrls() {
  for (const url of thumbnailObjectUrls) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  thumbnailObjectUrls.clear();
}

function getFilePreviewUrl(file) {
  if (!file || !isImageFile(file)) return '';
  const existing = filePreviewUrls.get(file);
  if (existing) return existing;
  const url = URL.createObjectURL(file);
  filePreviewUrls.set(file, url);
  thumbnailObjectUrls.add(url);
  return url;
}

// Revoke object URL when image file leaves queue
function revokeFilePreviewUrl(file) {
  const url = filePreviewUrls.get(file);
  if (!url) return;
  try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  thumbnailObjectUrls.delete(url);
  filePreviewUrls.delete(file);
}

// ===== INITIALIZATION =====
async function init() {
  migrateUiStorage();
  
  // Cache DOM elements
  el.sidebar = document.getElementById('sidebar');
  el.fileList = document.getElementById('fileList');
  el.uploadBtn = document.getElementById('uploadBtn');
  el.fileInput = document.getElementById('fileInput');
  el.setupWorkspace = document.getElementById('setupWorkspace');
  el.setupInputPane = document.querySelector('.setup-input-pane');
  el.setupUploadPanel = document.getElementById('setupUploadPanel');
  el.dropzoneUploadTarget = document.getElementById('dropzoneUploadTarget');
  el.setupPreviewDialog = document.getElementById('setupPreviewDialog');
  el.setupPreviewBackdrop = document.getElementById('setupPreviewBackdrop');
  el.setupPreviewMount = document.getElementById('setupPreviewMount');
  el.setupPreviewClose = document.getElementById('setupPreviewClose');
  el.setupPreviewPrev = document.getElementById('setupPreviewPrev');
  el.setupPreviewNext = document.getElementById('setupPreviewNext');
  el.setupPreviewZoomOut = document.getElementById('setupPreviewZoomOut');
  el.setupPreviewZoomIn = document.getElementById('setupPreviewZoomIn');
  el.setupPreviewFit = document.getElementById('setupPreviewFit');
  el.setupPreviewTitle = document.getElementById('setupPreviewTitle');
  el.setupPreviewMeta = document.getElementById('setupPreviewMeta');
  el.setupPreviewPageInfo = document.getElementById('setupPreviewPageInfo');
  el.setupFileCards = document.getElementById('setupFileCards');
  el.setupSettingsMount = document.getElementById('setupSettingsMount');
  el.taskDropzone = document.getElementById('taskDropzone');
  el.dropzoneTitle = document.getElementById('dropzoneTitle');
  el.dropzoneHint = document.getElementById('dropzoneHint');
  el.settingsToggle = document.getElementById('settingsToggle');
  el.settingsPanel = document.getElementById('settingsPanel');
  el.workspaceToolbar = document.querySelector('.workspace-toolbar');
  el.contentSplit = document.querySelector('.content-split');
  el.drawerBackdrop = document.getElementById('drawerBackdrop');
  el.confirmBackdrop = document.getElementById('confirmBackdrop');
  el.confirmDialog = document.getElementById('confirmDialog');
  el.confirmMessage = document.getElementById('confirmMessage');
  el.confirmCancelBtn = document.getElementById('confirmCancelBtn');
  el.confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
  el.optionsContent = document.getElementById('optionsContent');
  el.timingsToggle = document.getElementById('timingsToggle');
  el.timingsPanel = document.getElementById('timingsPanel');
  el.timingsContent = document.getElementById('timingsContent');
  el.assetGateCard = document.getElementById('assetGateCard');
  el.assetGateDot = document.getElementById('assetGateDot');
  el.assetGateBadge = document.getElementById('assetGateBadge');
  el.assetGateSummary = document.getElementById('assetGateSummary');
  el.assetProgressTrack = document.getElementById('assetProgressTrack');
  el.assetProgressFill = document.getElementById('assetProgressFill');
  el.assetProgressLabel = document.getElementById('assetProgressLabel');
  el.assetProgressPercent = document.getElementById('assetProgressPercent');
  el.assetDownloadBtn = document.getElementById('assetDownloadBtn');
  el.layoutModel = document.getElementById('layoutModel');
  el.ocrModel = document.getElementById('ocrModel');
  el.executionProvider = document.getElementById('executionProvider');
  el.formulaEnable = document.getElementById('formulaEnable');
  el.formulaModel = document.getElementById('formulaModel');
  el.tableEnable = document.getElementById('tableEnable');
  el.tableModel = document.getElementById('tableModel');
  el.startBtn = document.getElementById('startBtn');
  el.downloadBtn = document.getElementById('downloadBtn');
  el.toggleSidebar = document.getElementById('toggleSidebar');
  el.currentFileName = document.getElementById('currentFileName');
  el.currentFileMeta = document.getElementById('currentFileMeta');
  el.runSummary = document.getElementById('runSummary');
  el.timingStrip = document.getElementById('timingStrip');
  el.zoomOut = document.getElementById('zoomOut');
  el.zoomIn = document.getElementById('zoomIn');
  el.fitWidth = document.getElementById('fitWidth');
  el.zoomLevel = document.getElementById('zoomLevel');
  el.prevPage = document.getElementById('prevPage');
  el.nextPage = document.getElementById('nextPage');
  el.pageInfo = document.getElementById('pageInfo');
  el.viewerPane = document.getElementById('viewerPane');
  el.workspaceViewerMount = el.viewerPane?.parentElement || null;
  el.viewerScroll = document.getElementById('viewerScroll');
  el.viewerContainer = document.getElementById('viewerContainer');
  el.pageStack = document.getElementById('pageStack');
  el.emptyViewer = document.getElementById('emptyViewer');
  el.pdfCanvas = document.getElementById('pdfCanvas');
  el.layoutOverlay = document.getElementById('layoutOverlay');
  el.resizeHandle = document.getElementById('resizeHandle');
  el.markdownPane = document.getElementById('markdownPane');
  el.markdownContent = document.getElementById('markdownContent');
  el.contentJsonContent = document.getElementById('contentJsonContent');
  el.contentJsonViewer = document.getElementById('contentJsonViewer');
  el.copyMarkdown = document.getElementById('copyMarkdown');
  el.overlayToggle = document.getElementById('overlayToggle');
  el.exportOptions = document.getElementById('exportOptions');
  el.progressOverlay = document.getElementById('progressOverlay');
  el.progressTitle = document.getElementById('progressTitle');
  el.progressMessage = document.getElementById('progressMessage');
  el.progressFill = document.getElementById('progressFill');
  el.progressPercent = document.getElementById('progressPercent');
  el.progressCancelBtn = document.getElementById('progressCancelBtn');

  const storedOverlay = localStorage.getItem(OVERLAY_VISIBLE_KEY);
  if (storedOverlay !== null) {
    overlayVisible = storedOverlay === 'true';
  }
  const prefs = getUiPrefs();
  if (prefs.sidebarCollapsed) el.sidebar?.classList.add('collapsed');
  if (Number.isFinite(prefs.splitWidth) && el.markdownPane) {
    el.markdownPane.style.width = `${Math.max(320, Math.min(900, prefs.splitWidth))}px`;
  }
  updateToolbarSplitWidth();
  if (Number.isFinite(prefs.zoom)) {
    currentZoom = Math.max(0.1, Math.min(3.0, prefs.zoom));
  }
  mountSettingsPanelInline();
  updateOverlayToggleUI();
  updateModelStatusSummary();
  renderAssetGate();
  if (el.executionProvider) {
    el.executionProvider.value = appState.get('activeExecutionProvider') || 'wasm';
  }

  // Initialize appState with defaults
  appState.patch({
    parseMethod: 'auto',
    forceOcr: false,
    dumpMd: true,
    dumpContentList: true,
    dumpMiddleJson: true,
    dumpModelOutput: true,
    drawLayoutBbox: true,
    pipelineMode: 'full_analysis',
    layoutModelType: 'pp_doclayoutv2',
    language: 'ch',
    formulaEnable: false,
    tableEnable: false,
    tableModelType: el.tableModel?.value || 'unet_slanet_plus',
    formulaModelType: 'pp_formulanet_plus_s',
  });

  setupEventListeners();
  setupOverlayResizeObservers();
  switchViewerTab(prefs.activeOutputTab || 'rendered');

  initLinkingContext(el, {
    updatePageInfo,
    scrollOutputToLink,
    scrollOutputToNearestPageLink,
    scrollOutputToPagePosition,
    scrollPreviewToLink,
    scrollPreviewToPagePosition,
    getPreviewLinkPosition,
    getOutputLinkPosition,
  });
  // Sync linking context with module-level globals (proxy pattern)
  linkingCtx.el = el;
  // Proxy currentPage so pin.js writes propagate back to app.js module scope
  Object.defineProperty(linkingCtx, 'currentPage', {
    get: () => currentPage,
    set: (v) => { currentPage = v; },
    configurable: true,
  });

  initConnectorsRenderer({
    get renderedPages() { return renderedPages; },
    get pageStack() { return el.pageStack; },
  });
  initStylingRenderer({
    get markdownContent() { return el.markdownContent; },
    getResults: () => appState.get('results'),
    extractBlockLinkText,
    normalizeLayoutText,
    labelGroupKey,
    UI_LOG_PREFIX,
  });
  initActionsRenderer({
    get markdownContent() { return el.markdownContent; },
    normalizeLayoutText,
    refreshIcons,
  });

  window.addEventListener('beforeunload', () => {
    overlayResizeObserver?.disconnect();
    revokeThumbnailObjectUrls();
    releaseCanvas(sourceCanvas);
    try { pdfLoadingTask?.destroy?.(); } catch { /* ignore */ }
    try { pdfDocument?.destroy?.(); } catch { /* ignore */ }
  });
  subscribeToState();

  initHistoryList({
    el,
    getHistory,
    formatDuration,
    formatFileSize,
    formatDate,
    escapeHtml,
    refreshIcons,
    loadHistoryItem,
    requestHistoryDelete,
  });
  initHistoryReload({
    el,
    appState,
    thumbnailObjectUrls,
    get renderedPages() { return renderedPages; },
    get overlayResizeObserver() { return overlayResizeObserver; },
    setWorkspaceMode,
    cleanupPdfPreview,
    releaseCanvas,
    hasStoredImages,
    getResultArtifact,
    readHistoryStoredValue,
    normalizeHistoryStageTimings,
    emptyTimingSet,
    prepareLinkedBlocks,
    updatePageInfo,
    displayMarkdown,
    displayJSON,
    renderHistoryPreviewPages,
    renderHistoryThumbnail,
    showEmptyViewer,
    formatFileSize,
    formatDate,
    updateRunSummary,
    updateTimingsDisplay,
    updateUI,
    showLoading,
    getSourceCanvas: () => sourceCanvas,
    setSourceCanvas: (c) => { sourceCanvas = c; },
    setCurrentRunConfig: (cfg) => { currentRunConfig = cfg; },
    setCurrentStageTimings: (t) => { currentStageTimings = t; },
    setSelectedFiles: (f) => { selectedFiles = f; },
    setCurrentFileIndex: (i) => { currentFileIndex = i; },
    setCurrentFile: (f) => { currentFile = f; },
    setCurrentFileType: (t) => { currentFileType = t; },
    setRequiredAssetsReady: (r) => { requiredAssetsReady = r; },
    setTotalPages: (n) => { totalPages = n; },
    setCurrentPage: (n) => { currentPage = n; },
    setSyncedPageIndex: (i) => { syncedPageIndex = i; },
    setSyncedLinkId: (id) => { syncedLinkId = id; },
  });

  loadHistory();
  setWorkspaceMode('setup');
  setSetupTab('upload');
  updateUI();
  refreshAssetRequirements();
  
  marked.setOptions({
    gfm: true,
    breaks: true,
  });
  
  // Initialize Lucide icons
  refreshIcons();
}

// ===== EVENT LISTENERS =====
function setupEventListeners() {
  // Sidebar
  el.toggleSidebar?.addEventListener('click', toggleSidebar);
  
  // Task composer
  el.uploadBtn?.addEventListener('click', startNewTask);
  el.dropzoneUploadTarget?.addEventListener('click', () => el.fileInput?.click());
  el.taskDropzone?.addEventListener('click', handleTaskDropzoneClick);
  el.taskDropzone?.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target === el.taskDropzone) {
      event.preventDefault();
      el.fileInput?.click();
    }
  });
  el.fileInput?.addEventListener('change', handleFileSelect);
  [el.setupInputPane, el.taskDropzone, el.viewerScroll].forEach((target) => {
    target?.addEventListener('dragenter', handleViewerDragEnter);
    target?.addEventListener('dragover', handleViewerDragOver);
    target?.addEventListener('dragleave', handleViewerDragLeave);
    target?.addEventListener('drop', handleViewerDrop);
  });
  
  // Options
  el.settingsToggle?.addEventListener('click', toggleOptions);
  el.timingsToggle?.addEventListener('click', toggleTimings);
  el.layoutModel?.addEventListener('change', updateConfig);
  el.ocrModel?.addEventListener('change', updateConfig);
  el.executionProvider?.addEventListener('change', updateConfig);
  el.formulaEnable?.addEventListener('change', updateConfig);
  el.formulaModel?.addEventListener('change', updateConfig);
  el.tableEnable?.addEventListener('change', updateConfig);
  el.tableModel?.addEventListener('change', updateConfig);
  el.assetDownloadBtn?.addEventListener('click', downloadRequiredAssets);
  el.assetFormulaDownloadBtn?.addEventListener('click', downloadFormulaAssets);
  
  // Actions
  el.startBtn?.addEventListener('click', runPipeline);
  el.downloadBtn?.addEventListener('click', toggleExportMenu);
  el.downloadBtn?.addEventListener('focus', openExportMenu);
  el.exportOptions?.addEventListener('mouseenter', cancelExportMenuClose);
  el.exportOptions?.addEventListener('mouseleave', scheduleExportMenuClose);
  el.progressCancelBtn?.addEventListener('click', cancelProcessing);
  el.confirmCancelBtn?.addEventListener('click', closeHistoryDeleteConfirm);
  el.confirmBackdrop?.addEventListener('click', closeHistoryDeleteConfirm);
  el.confirmDeleteBtn?.addEventListener('click', confirmHistoryDelete);
  el.setupPreviewClose?.addEventListener('click', closeSetupPreviewDialog);
  el.setupPreviewBackdrop?.addEventListener('click', closeSetupPreviewDialog);
  el.setupPreviewPrev?.addEventListener('click', () => setPage(currentPage - 1));
  el.setupPreviewNext?.addEventListener('click', () => setPage(currentPage + 1));
  el.setupPreviewZoomOut?.addEventListener('click', () => setZoom(currentZoom - 0.1));
  el.setupPreviewZoomIn?.addEventListener('click', () => setZoom(currentZoom + 0.1));
  el.setupPreviewFit?.addEventListener('click', fitToWidth);
  
  // Toolbar
  el.zoomOut?.addEventListener('click', () => setZoom(currentZoom - 0.1));
  el.zoomIn?.addEventListener('click', () => setZoom(currentZoom + 0.1));
  el.fitWidth?.addEventListener('click', fitToWidth);
  el.overlayToggle?.addEventListener('click', toggleOverlayVisible);
  el.prevPage?.addEventListener('click', () => setPage(currentPage - 1));
  el.nextPage?.addEventListener('click', () => setPage(currentPage + 1));
  getPreviewScrollEl()?.addEventListener('scroll', handlePreviewScroll, { passive: true });
  el.pageStack?.addEventListener('scroll', handlePreviewScroll, { passive: true });
  el.pageStack?.addEventListener('mouseover', handlePreviewLinkHover);
  el.pageStack?.addEventListener('mouseout', handlePreviewLinkLeave);
  el.pageStack?.addEventListener('click', handlePreviewLinkClick);
  
  // Resize handle
  el.resizeHandle?.addEventListener('mousedown', startResize);
  document.addEventListener('mousemove', handleResize);
  document.addEventListener('mouseup', stopResize);
  window.addEventListener('resize', scheduleRenderMergeConnectors);
  document.addEventListener('keydown', handleGlobalShortcuts);
  
  // Markdown
  el.copyMarkdown?.addEventListener('click', copyMarkdown);
  el.markdownContent?.addEventListener('click', handleBlockAction);
  el.markdownContent?.addEventListener('mouseover', handleMarkdownLinkHover);
  el.markdownContent?.addEventListener('mouseout', handleMarkdownLinkLeave);
  el.markdownContent?.addEventListener('click', handleMarkdownLinkClick);
  el.markdownContent?.addEventListener('scroll', handleMarkdownScroll, { passive: true });
  el.exportOptions?.addEventListener('click', handleExportOption);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.export-menu')) {
      closeExportMenu();
    }
    if (!event.target.closest('.docparse-drawer')
      && !event.target.closest('#settingsToggle')
      && !event.target.closest('#timingsToggle')) {
      closeDrawers();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDrawers();
      closeExportMenu();
      closeHistoryDeleteConfirm();
      closeSetupPreviewDialog();
    }
  });
  document.querySelectorAll('[data-close-panel]').forEach(btn => {
    btn.addEventListener('click', () => {
      closePanel(btn.dataset.closePanel);
    });
  });
  
  // Markdown/JSON tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tab = e.target.dataset.tab;
      switchViewerTab(tab);
    });
  });
}

function setupOverlayResizeObservers() {
  if (typeof ResizeObserver !== 'function') return;
  overlayResizeObserver?.disconnect();
  overlayResizeObserver = new ResizeObserver(() => {
    scheduleRenderLayoutOverlay();
    scheduleRenderMergeConnectors();
  });
  [el.pageStack, el.viewerScroll, el.markdownPane, el.markdownContent, ...renderedPages.map(record => record.pageEl)].forEach(target => {
    if (target) overlayResizeObserver.observe(target);
  });

  // assignment or other out-of-band DOM mutations (Requirement 4.5).
  if (el.pageStack && typeof MutationObserver === 'function') {
    if (el.pageStack._auditMutationObserver) {
      el.pageStack._auditMutationObserver.disconnect();
    }
    const mo = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const removed of mutation.removedNodes) {
          if (removed.nodeType === 1) {
            try { overlayResizeObserver?.unobserve(removed); } catch { /* ignore */ }
            // Also unobserve any descendant page elements
            removed.querySelectorAll?.('.document-page').forEach(child => {
              try { overlayResizeObserver?.unobserve(child); } catch { /* ignore */ }
            });
          }
        }
      }
    });
    mo.observe(el.pageStack, { childList: true });
    el.pageStack._auditMutationObserver = mo;
  }
}

// ===== VIEWER TAB SWITCHING =====
function switchViewerTab(tab) {
  const activeTab = tab === 'content' ? 'content' : 'rendered';
  saveUiPrefs({ activeOutputTab: activeTab });
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === activeTab);
  });

  const panels = {
    rendered: el.markdownContent,
    content: el.contentJsonContent,
  };
  Object.entries(panels).forEach(([key, panel]) => {
    if (panel) panel.style.display = key === activeTab ? 'block' : 'none';
  });
}

function mountSettingsPanelInline() {
  if (!el.settingsPanel || !el.setupSettingsMount) return;
  el.settingsPanel.classList.remove('hidden');
  el.settingsPanel.classList.add('setup-inline-settings');
  el.settingsPanel.removeAttribute('aria-modal');
  el.setupSettingsMount.appendChild(el.settingsPanel);
}

function moveViewerToWorkspace() {
  if (!el.viewerPane || !el.workspaceViewerMount) return;
  if (el.viewerPane.parentElement !== el.workspaceViewerMount) {
    el.workspaceViewerMount.insertBefore(el.viewerPane, el.resizeHandle || null);
  }
}

function moveViewerToSetupPreview() {
  if (!el.viewerPane || !el.setupPreviewMount) return;
  if (el.viewerPane.parentElement !== el.setupPreviewMount) {
    el.setupPreviewMount.appendChild(el.viewerPane);
  }
}

function openSetupPreviewDialog() {
  if (!currentFile) return;
  moveViewerToSetupPreview();
  el.setupPreviewBackdrop?.classList.remove('hidden');
  el.setupPreviewDialog?.classList.remove('hidden');
  updateSetupPreviewMeta();
  updatePageInfo();
  requestAnimationFrame(() => {
    fitSetupPreviewInitial();
    refreshIcons();
  });
}

function closeSetupPreviewDialog() {
  el.setupPreviewBackdrop?.classList.add('hidden');
  el.setupPreviewDialog?.classList.add('hidden');
}

function updateSetupPreviewMeta() {
  if (el.setupPreviewTitle) {
    el.setupPreviewTitle.textContent = currentFile?.name || 'Preview document';
    el.setupPreviewTitle.title = currentFile?.name || '';
  }
  if (el.setupPreviewMeta) {
    const pageText = totalPages > 1 ? `${totalPages} pages` : '1 page';
    el.setupPreviewMeta.textContent = currentFile ? `${formatFileSize(currentFile.size)} • ${pageText}` : '';
  }
}

function setWorkspaceMode(mode) {
  workspaceMode = mode === 'workspace' ? 'workspace' : 'setup';
  const inWorkspace = workspaceMode === 'workspace';
  el.setupWorkspace?.classList.toggle('hidden', inWorkspace);
  el.workspaceToolbar?.classList.toggle('hidden', !inWorkspace);
  el.contentSplit?.classList.toggle('hidden', !inWorkspace);
  if (inWorkspace) {
    closeSetupPreviewDialog();
    moveViewerToWorkspace();
  }
  updateSetupTabs();
}

function setSetupTab(tab) {
  setupTab = 'upload';
  updateSetupTabs();
}

function updateSetupTabs() {
  setupTab = 'upload';
  el.setupUploadPanel?.classList.remove('hidden');
}

// ===== SIDEBAR =====
function toggleSidebar() {
  el.sidebar?.classList.toggle('collapsed');
  saveUiPrefs({ sidebarCollapsed: Boolean(el.sidebar?.classList.contains('collapsed')) });
}

function toggleOptions() {
  toggleDrawer('settingsPanel', el.settingsToggle);
}

function toggleTimings() {
  toggleDrawer('timingsPanel', el.timingsToggle);
}

function toggleDrawer(panelId, trigger = null) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const willOpen = panel.classList.contains('hidden');
  closeDrawers();
  if (willOpen) openDrawer(panelId, trigger);
}

function openDrawer(panelId, trigger = null) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.classList.remove('hidden');
  el.drawerBackdrop?.classList.remove('hidden');
  activeDrawerId = panelId;
  lastDrawerTrigger = trigger || document.activeElement;
  if (panelId === 'settingsPanel') {
    el.settingsToggle?.classList.add('is-active');
    el.settingsToggle?.setAttribute('aria-pressed', 'true');
  } else if (panelId === 'timingsPanel') {
    el.timingsToggle?.classList.add('is-active');
    el.timingsToggle?.setAttribute('aria-pressed', 'true');
  }
}

function closePanel(panelId, { restoreFocus = false } = {}) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  if (panel.classList.contains('setup-inline-settings')) return;
  panel.classList.add('hidden');
  if (panelId === 'settingsPanel') {
    el.settingsToggle?.classList.remove('is-active');
    el.settingsToggle?.setAttribute('aria-pressed', 'false');
  } else if (panelId === 'timingsPanel') {
    el.timingsToggle?.classList.remove('is-active');
    el.timingsToggle?.setAttribute('aria-pressed', 'false');
  }
  if (activeDrawerId === panelId) activeDrawerId = null;
  if (!activeDrawerId) el.drawerBackdrop?.classList.add('hidden');
  if (restoreFocus && lastDrawerTrigger?.focus) lastDrawerTrigger.focus();
}

function closeDrawers({ restoreFocus = false } = {}) {
  closePanel('settingsPanel', { restoreFocus });
  closePanel('timingsPanel', { restoreFocus });
}

function toggleOverlayVisible() {
  setOverlayVisible(!overlayVisible);
}

function setOverlayVisible(visible, { persist = true } = {}) {
  overlayVisible = Boolean(visible);
  if (persist) {
    localStorage.setItem(OVERLAY_VISIBLE_KEY, String(overlayVisible));
  }
  updateOverlayToggleUI();
  if (!overlayVisible) {
    if (scheduleRenderLayoutOverlay._coalescer) scheduleRenderLayoutOverlay._coalescer.cancel();
    if (scheduleRenderMergeConnectors._coalescer) scheduleRenderMergeConnectors._coalescer.cancel();
    overlayRenderFrame = null;
    mergeConnectorFrame = null;
    clearLayoutOverlay();
    return;
  }
  scheduleRenderLayoutOverlay();
}

function updateOverlayToggleUI() {
  if (!el.overlayToggle) return;
  el.overlayToggle.classList.toggle('is-active', overlayVisible);
  el.overlayToggle.setAttribute('aria-pressed', String(overlayVisible));
  el.overlayToggle.setAttribute('title', overlayVisible ? 'Hide overlay' : 'Show overlay');
  const icon = overlayVisible ? 'scan-line' : 'scan';
  const iconEl = el.overlayToggle.querySelector('i');
  if (iconEl) {
    iconEl.setAttribute('data-lucide', icon);
  }
  refreshIcons();
}

// ===== CONFIG UPDATE =====
function updateConfig() {
  const layoutMap = {
    'v2': 'pp_doclayoutv2',
    'v3': 'pp_doclayoutv3',
    'plus_l': 'pp_doclayout_plus_l',
    's': 'pp_doclayout_s',
  };
  
  const langMap = {
    'ch': 'ch',
    'en': 'en',
  };
  
  const layoutValue = el.layoutModel?.value || 'v2';
  const ocrValue = el.ocrModel?.value || 'en';
  const executionProviderValue = el.executionProvider?.value || appState.get('activeExecutionProvider') || 'wasm';
  const formulaEnabled = el.formulaEnable?.checked || false;
  const formulaModelValue = el.formulaModel?.value || 'pp_formulanet_plus_s';
  const tableEnabled = el.tableEnable?.checked || false;
  const tableModelValue = el.tableModel?.value || 'unet_slanet_plus';
   
  appState.patch({
    layoutModelType: layoutMap[layoutValue] || 'pp_doclayoutv2',
    language: langMap[ocrValue] || 'ch',
    activeExecutionProvider: executionProviderValue === 'webgpu' ? 'webgpu' : 'wasm',
    formulaEnable: formulaEnabled,
    formulaModelType: formulaModelValue,
    tableEnable: tableEnabled,
    tableModelType: tableModelValue,
    dumpMiddleJson: true,
    dumpModelOutput: true,
    warmupStatus: 'idle',
    warmupConfigKey: null,
    warmupError: null,
  });
  cancelPendingWarmup();
  requiredAssetsReady = false;
  refreshAssetRequirements();
}

function emptyTimingSet() {
  return {
    preprocessing: 0,
    model_init: 0,
    pdf_load: 0,
    orientation: 0,
    layout: 0,
    region_collect: 0,
    ocr_det: 0,
    ocr_rec: 0,
    ocr: 0,
    formula: 0,
    table: 0,
    reading_order: 0,
    postprocessing: 0,
    total_inference: 0,
    other: 0,
    total: 0,
  };
}

function isWarmupActive() {
  const status = appState.get('warmupStatus');
  return status === 'runtime_loading' || status === 'model_warming';
}

function isCurrentRuntimeReady() {
  return Boolean(
    currentFile
    && appState.get('warmupStatus') === 'ready'
    && pipelineAdapter.isPrepared(appState, currentFile)
  );
}

function canRunExtraction() {
  return selectedFiles.length > 0
    && !appState.get('isProcessing')
    && appState.get('warmupStatus') === 'ready';
}

function cancelPendingWarmup({ resetStatus = false } = {}) {
  if (warmupTimer) {
    clearTimeout(warmupTimer);
    warmupTimer = null;
  }
  if (warmupAbortController) {
    warmupAbortController.abort();
    warmupAbortController = null;
  }
  if (resetStatus) {
    appState.patch({
      warmupStatus: 'idle',
      warmupConfigKey: null,
      warmupError: null,
      startupTimings: emptyTimingSet(),
    });
  }
}

function scheduleBackgroundWarmup(delayMs = 600) {
  if (!currentFile || !selectedFiles.length || appState.get('isProcessing')) return;
  if (!requiredAssetsReady) return;
  if (pipelineAdapter.isPrepared(appState, currentFile)) {
    appState.patch({
      runtimeStatus: 'ready',
      warmupStatus: 'ready',
      warmupConfigKey: pipelineAdapter.getPreparationKey(appState, currentFile),
      warmupError: null,
    });
    updateModelStatusSummary();
    updateUI();
    return;
  }
  if (warmupTimer) clearTimeout(warmupTimer);
  warmupTimer = setTimeout(() => {
    warmupTimer = null;
    warmDocumentRuntime({ background: true }).catch((error) => {
      if (error?.name !== 'AbortError') {
        console.warn(`${UI_LOG_PREFIX} Background warmup failed:`, error);
      }
    });
  }, delayMs);
}

async function warmDocumentRuntime({ background = false } = {}) {
  if (!currentFile) return null;
  if (pipelineAdapter.isPrepared(appState, currentFile)) {
    appState.patch({
      runtimeStatus: 'ready',
      warmupStatus: 'ready',
      warmupConfigKey: pipelineAdapter.getPreparationKey(appState, currentFile),
      warmupError: null,
    });
    return appState.get('warmupConfigKey');
  }

  const controller = warmupAbortController || new AbortController();
  if (!warmupAbortController) warmupAbortController = controller;
  try {
    updateWarmupProgressUi();
    const key = await pipelineAdapter.prepare(appState, currentFile, controller.signal);
    return key;
  } catch (error) {
    if (error?.name === 'AbortError') return null;
    if (!background) throw error;
    return null;
  } finally {
    if (warmupAbortController === controller && !isWarmupActive()) warmupAbortController = null;
    updateModelStatusSummary();
    updateTimingsDisplay();
    updateUI();
  }
}

function updateWarmupProgressUi() {
  const status = appState.get('warmupStatus');
  if (!el.progressTitle || !el.progressMessage) return;
  if (!appState.get('isProcessing')) return;
  if (status === 'runtime_loading') {
    el.progressTitle.textContent = 'Preparing engine...';
    el.progressMessage.textContent = 'Loading models and setting up the processing engine.';
    updateProgress(4);
  } else if (status === 'model_warming') {
    el.progressTitle.textContent = 'Preparing engine...';
    el.progressMessage.textContent = 'Loading models and setting up the processing engine.';
    updateProgress(8);
  }
}

async function refreshAssetRequirements({ allowWarmup = true } = {}) {
  const token = ++assetRefreshToken;
  if (!assetSummary) {
    requiredAssetsReady = false;
    renderAssetGate();
  }
  try {
    const [summary, formulaSummary] = await Promise.all([
      pipelineAdapter.getRequiredAssetSummary(appState, currentFile),
      pipelineAdapter.getFormulaAssetSummary(appState, currentFile),
    ]);
    if (token !== assetRefreshToken) return;
    assetSummary = summary;
    formulaAssetSummary = formulaSummary;
    requiredAssetsReady = Boolean(summary.ready);
    appState.set('assetStatus', summary.status || {});
    renderAssetGate();
    updateUI();
    if (allowWarmup && requiredAssetsReady) {
      scheduleBackgroundWarmup();
    } else if (allowWarmup && !requiredAssetsReady && selectedFiles.length > 0 && !assetDownloadController) {
      downloadRequiredAssets().catch(() => {});
    }
  } catch (error) {
    if (token !== assetRefreshToken) return;
    requiredAssetsReady = false;
    console.warn(`${UI_LOG_PREFIX} Failed to inspect asset cache:`, error);
    renderAssetGate({ error });
    updateUI();
  }
}

function summarizeAssetPack(summary, ids = summary?.ids || []) {
  const statuses = summary?.status || {};
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  const cachedCount = uniqueIds.filter(id => statuses[id]?.cached).length;
  const sizeBytes = uniqueIds.reduce((sum, id) => {
    const asset = summary?.assets?.find(item => item.id === id);
    return sum + Number(asset?.sizeBytes || statuses[id]?.expectedSizeBytes || statuses[id]?.sizeBytes || 0);
  }, 0);
  return {
    cachedCount,
    missingCount: Math.max(0, uniqueIds.length - cachedCount),
    sizeBytes,
    totalCount: uniqueIds.length,
  };
}

function renderAssetGate({ error = null } = {}) {
  if (!el.assetGateCard) return;
  const summary = assetSummary;
  const ids = summary?.ids || [];
  const statuses = summary?.status || {};
  const cachedCount = ids.filter(id => statuses[id]?.cached).length;
  const totalCount = ids.length;
  const missingCount = Math.max(0, totalCount - cachedCount);
  const downloading = Boolean(assetDownloadController);
  const warmupStatus = appState.get('warmupStatus') || 'idle';
  const runtimeStatus = appState.get('runtimeStatus') || 'idle';
  const warmupError = appState.get('warmupError');
  const engineReady = warmupStatus === 'ready';
  const engineFailed = warmupStatus === 'error';
  const engineLoading = isWarmupActive();

  let dotClass = '';
  let badgeText = '';
  let summaryText = '';
  let showProgress = false;
  let showButton = false;

  if (error) {
    dotClass = 'error';
    badgeText = 'Failed';
    summaryText = 'Could not check required components';
    showButton = true;
  } else if (downloading) {
    dotClass = 'loading';
    badgeText = 'Downloading...';
    const size = formatFileSize(summary?.sizeBytes || 0);
    summaryText = missingCount
      ? `${missingCount} component(s) to download, ${size}`
      : 'Downloading...';
    showProgress = true;
  } else if (engineFailed) {
    dotClass = 'error';
    badgeText = 'Failed';
    summaryText = warmupError || 'Engine failed to start';
    showButton = true;
  } else if (engineReady && requiredAssetsReady) {
    dotClass = 'ready';
    badgeText = 'Ready';
    const size = formatFileSize(summary?.sizeBytes || 0);
    summaryText = `Engine ready · ${totalCount} component(s), ${size}`;
  } else if (engineLoading) {
    dotClass = 'loading';
    badgeText = 'Preparing...';
    summaryText = 'Starting engine...';
    showProgress = true;
  } else if (summary) {
    dotClass = missingCount ? '' : 'ready';
    badgeText = missingCount ? 'Needed' : 'Ready';
    const size = formatFileSize(summary.sizeBytes || 0);
    summaryText = missingCount
      ? `${missingCount} component(s) to download, ${size}`
      : `${totalCount} component(s) ready, ${size}`;
    showButton = Boolean(missingCount);
    showProgress = Boolean(missingCount);
  } else {
    dotClass = 'loading';
    badgeText = 'Initializing...';
    summaryText = '';
  }

  if (el.assetGateDot) {
    el.assetGateDot.className = 'status-dot' + (dotClass ? ' ' + dotClass : '');
  }
  if (el.assetGateBadge) {
    el.assetGateBadge.textContent = badgeText;
  }
  if (el.assetGateSummary) {
    el.assetGateSummary.textContent = summaryText;
  }

  if (el.assetProgressTrack) {
    el.assetProgressTrack.classList.toggle('hidden', !showProgress);
  }
  if (el.assetProgressLabel) {
    el.assetProgressLabel.classList.toggle('hidden', !showProgress);
  }
  if (el.assetProgressPercent) {
    el.assetProgressPercent.classList.toggle('hidden', !showProgress);
  }

  if (showProgress) {
    if (downloading) {
      updateAssetProgress({
        percent: 0,
        label: '',
        indeterminate: true,
      });
    } else if (engineLoading) {
      updateAssetProgress({
        percent: 0,
        label: 'Loading models...',
        indeterminate: true,
      });
    } else {
      const pct = totalCount ? (cachedCount / totalCount) * 100 : 0;
      updateAssetProgress({
        percent: pct,
        label: badgeText === 'Needed' ? 'Components need to download' : '',
        indeterminate: false,
      });
    }
  }

  if (el.assetDownloadBtn) {
    el.assetDownloadBtn.classList.toggle('hidden', !showButton);
    el.assetDownloadBtn.disabled = downloading || !totalCount;
    const label = el.assetDownloadBtn.querySelector('span');
    if (label) label.textContent = downloading ? 'Downloading...' : 'Retry';
  }

  refreshIcons();
}

function updateAssetProgress(event = {}) {
  event = event || {};
  const percent = Math.max(0, Math.min(100, Number(event.percent) || 0));
  if (el.assetProgressTrack) {
    el.assetProgressTrack.classList.toggle('is-indeterminate', Boolean(event.indeterminate));
  }
  if (el.assetProgressFill) {
    el.assetProgressFill.style.width = event.indeterminate ? '42%' : `${percent}%`;
  }
  if (el.assetProgressPercent) {
    el.assetProgressPercent.textContent = event.indeterminate ? '...' : `${Math.round(percent)}%`;
  }
  if (el.assetProgressLabel) {
    const loaded = event.loadedBytes ? `${formatFileSize(event.loadedBytes)} downloaded` : '';
    el.assetProgressLabel.textContent = event.label
      ? `${event.label}${loaded ? ` - ${loaded}` : ''}`
      : 'Preparing document processing components.';
  }
}

async function downloadRequiredAssets() {
  if (assetDownloadController) return;

  assetDownloadController = new AbortController();
  renderAssetGate();
  try {
    const summary = await pipelineAdapter.downloadRequiredAssets(
      appState,
      currentFile,
      (event) => {
        appState.set('assetProgress', event);
        updateAssetProgress(event);
        if (event.assetId) appState.setModelStatus(event.assetId, 'downloading', event.percent);
      },
      assetDownloadController.signal,
    );
    assetSummary = summary;
    requiredAssetsReady = Boolean(summary.ready);
    appState.set('assetStatus', summary.status || {});
    for (const id of summary.ids || []) appState.setModelStatus(id, summary.status?.[id]?.cached ? 'cached' : 'not_downloaded', summary.status?.[id]?.cached ? 100 : 0);
    renderAssetGate();
    updateUI();
    if (requiredAssetsReady) {
      showLoading('Components ready');
      scheduleBackgroundWarmup(0);
    }
  } catch (error) {
    console.error(`${UI_LOG_PREFIX} Asset download failed:`, error);
    showLoading(`Download failed: ${error.message}`, 3000);
    renderAssetGate({ error });
  } finally {
    assetDownloadController = null;
    await refreshAssetRequirements({ allowWarmup: false });
    // Auto-download formula assets if formula is enabled and they're missing
    if (!assetDownloadController && selectedFiles.length > 0) {
      const fSummary = formulaAssetSummary;
      if (fSummary?.enabled && fSummary?.ids?.length) {
        const fPack = summarizeAssetPack(fSummary, fSummary.ids);
        if (fPack.missingCount > 0) {
          downloadFormulaAssets().catch(() => {});
        }
      }
    }
  }
}

async function downloadFormulaAssets() {
  if (assetDownloadController) return;

  assetDownloadController = new AbortController();
  renderAssetGate();
  try {
    const summary = await pipelineAdapter.downloadFormulaAssets(
      appState,
      currentFile,
      (event) => {
        appState.set('assetProgress', event);
        updateAssetProgress(event);
        if (event.assetId) appState.setModelStatus(event.assetId, 'downloading', event.percent);
      },
      assetDownloadController.signal,
    );
    formulaAssetSummary = summary;
    for (const id of summary.ids || []) {
      appState.setModelStatus(id, summary.status?.[id]?.cached ? 'cached' : 'not_downloaded', summary.status?.[id]?.cached ? 100 : 0);
    }
    showLoading('Formula models ready');
    renderAssetGate();
  } catch (error) {
    console.error(`${UI_LOG_PREFIX} Formula asset download failed:`, error);
    showLoading(`Formula model download failed: ${error.message}`, 3000);
    renderAssetGate({ error });
  } finally {
    assetDownloadController = null;
    await refreshAssetRequirements({ allowWarmup: false });
  }
}

// ===== FILE HANDLING =====
function handleFileSelect(e) {
  const files = Array.from(e.target.files);
  if (files.length > 0) {
    addSelectedFiles(files);
  }
  e.target.value = ''; // Reset input
}

function handleTaskDropzoneClick(event) {
  if (appState.get('isProcessing')) {
    showLoading('Processing is still running');
    return;
  }
  const target = event.target;
  if (target?.closest?.('button, input, a, .setup-file-card')) return;
  el.fileInput?.click();
}

async function startNewTask() {
  if (appState.get('isProcessing')) {
    showLoading('Processing is still running');
    return;
  }
  if (isWarmupActive()) {
    cancelPendingWarmup({ resetStatus: true });
  }
  await resetWorkspaceForNewTask();
  setWorkspaceMode('setup');
  setSetupTab('upload');
  updateSetupUploadState();
  showLoading('New task ready');
}

function addSelectedFiles(files) {
  if (appState.get('isProcessing')) {
    showLoading('Processing is still running');
    return;
  }
  const validFiles = files.filter(file => {
    const name = String(file?.name || '').toLowerCase();
    return file?.type?.startsWith('image/') || /\.(pdf|png|jpe?g|webp|bmp|tiff?)$/i.test(name);
  });
  if (!validFiles.length) {
    showLoading('No supported document files found');
    return;
  }
  const newFileSet = new Set(validFiles);
  for (const prev of selectedFiles) {
    if (!newFileSet.has(prev)) revokeFilePreviewUrl(prev);
  }
  selectedFiles = validFiles;
  currentFileIndex = 0;
  setWorkspaceMode('setup');
  setSetupTab('upload');
  updateSetupUploadState();
  loadFile(validFiles[0], { replaceQueue: false });
}

function handleViewerDragEnter(event) {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  el.viewerScroll?.classList.add('is-dragging-file');
  el.taskDropzone?.classList.add('is-dragging-file');
}

function handleViewerDragOver(event) {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  el.viewerScroll?.classList.add('is-dragging-file');
  el.taskDropzone?.classList.add('is-dragging-file');
}

function handleViewerDragLeave(event) {
  if (event.relatedTarget && el.viewerScroll?.contains(event.relatedTarget)) return;
  el.viewerScroll?.classList.remove('is-dragging-file');
  el.taskDropzone?.classList.remove('is-dragging-file');
}

function handleViewerDrop(event) {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  el.viewerScroll?.classList.remove('is-dragging-file');
  el.taskDropzone?.classList.remove('is-dragging-file');
  addSelectedFiles(Array.from(event.dataTransfer.files));
}

async function loadFile(file, { replaceQueue = true } = {}) {
  if (appState.get('isProcessing')) {
    showLoading('Cannot load file while processing is running');
    return;
  }
  await cleanupPdfPreview();
  releaseCanvas(sourceCanvas);
  
  currentFile = file;
  currentFileType = isImageFile(file) ? 'image' : 'pdf';
  if (replaceQueue) {
    selectedFiles = [file];
    currentFileIndex = 0;
  } else {
    const index = selectedFiles.indexOf(file);
    currentFileIndex = index >= 0 ? index : currentFileIndex;
  }
  
  // Reset page info for new file
  currentPage = 1;
  totalPages = 1;
  
  // Clear previous results
  clearViewer();
  
  // Reset state
  appState.patch({
    files: [...selectedFiles],
    currentFileIndex,
    results: null,
    progress: { current: 0, total: 0 },
    timings: emptyTimingSet(),
    warmupStatus: 'idle',
    warmupConfigKey: null,
    warmupError: null,
  });
  requiredAssetsReady = false;
  renderFileList();
  updateUI();
  
  // Load preview
  try {
    if (currentFileType === 'pdf') {
      await loadPdfPreview(file);
    } else {
      sourceCanvas = await buildSourceCanvas(file);
      await loadFilePreview(file);
    }
    updateSetupPreviewMeta();
    refreshAssetRequirements();
    showLoading('File loaded successfully');
  } catch (err) {
    console.error(`${UI_LOG_PREFIX} Preview error:`, err);
    sourceCanvas = null;
    pdfDocument = null;
    showEmptyViewer();
    refreshAssetRequirements();
    showLoading('File loaded (preview unavailable)');
  }
}

function clearViewer() {
  clearLayoutOverlay();
  linkedBlocks = [];
  activeLinkId = null;
  activeGroupId = '';
  if (pinReleaseListener) {
    document.removeEventListener('click', pinReleaseListener, true);
    pinReleaseListener = null;
  }
  pinnedLinkId = null;
  pinnedGroupId = '';
  syncedPageIndex = null;
  syncedLinkId = null;
  // Clear markdown viewer
  if (el.markdownContent) {
    el.markdownContent.innerHTML = '<div class="empty-markdown"><p>Run extraction to view Markdown and JSON.</p></div>';
  }

  [el.contentJsonViewer].forEach((viewer) => {
    if (viewer) viewer.textContent = '';
  });
  
  // Reset to rendered tab
  switchViewerTab('rendered');
}

function resetPageStack() {
  if (!el.pageStack) return null;
  overlayResizeObserver?.disconnect();
  el.pageStack.innerHTML = '';
  renderedPages = [];
  const record = createDocumentPage(0);
  el.pdfCanvas = record.canvas;
  el.layoutOverlay = record.overlay;
  setupOverlayResizeObservers();
  return record;
}

function createDocumentPage(pageIndex) {
  const pageEl = document.createElement('div');
  pageEl.className = 'document-page';
  pageEl.dataset.pageIndex = String(pageIndex);

  const canvas = document.createElement('canvas');
  canvas.className = 'document-canvas';
  if (pageIndex === 0) canvas.id = 'pdfCanvas';

  const overlay = document.createElement('div');
  overlay.className = 'layout-overlay';
  if (pageIndex === 0) overlay.id = 'layoutOverlay';

  pageEl.appendChild(canvas);
  pageEl.appendChild(overlay);
  el.pageStack.appendChild(pageEl);

  const divider = document.createElement('div');
  divider.className = 'page-divider preview-page-divider';
  divider.dataset.pageIndex = String(pageIndex);
  divider.innerHTML = `<span>PAGE ${pageIndex + 1}</span>`;
  el.pageStack.appendChild(divider);

  const record = { pageIndex, pageEl, canvas, overlay, sourceSize: null };
  renderedPages.push(record);
  overlayResizeObserver?.observe?.(pageEl);
  return record;
}

function getPageRecord(pageIndex) {
  return renderedPages.find(record => record.pageIndex === pageIndex) || null;
}

function showPageStack() {
  el.emptyViewer?.classList.add('hidden');
  if (el.pageStack) el.pageStack.style.display = 'flex';
}

function hidePageStack() {
  if (el.pageStack) el.pageStack.style.display = 'none';
}

async function buildSourceCanvas(file) {
  if (isImageFile(file)) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  }
  throw new Error('Not an image file');
}

async function loadPdfPreview(file) {
  try {
    const pdfjsLib = await getPdfjsLib();
    const arrayBuffer = await file.arrayBuffer();
    const myTask = pdfjsLib.getDocument({ data: arrayBuffer });
    pdfLoadingTask = myTask;
    
    pdfDocument = await myTask.promise;
    // Guard: if a newer load replaced our task, bail out without touching state.
    if (pdfLoadingTask !== myTask) {
      try { await pdfDocument.destroy?.(); } catch { /* ignore */ }
      return;
    }
    totalPages = pdfDocument.numPages;
    currentPage = 1;

    resetPageStack();
    for (let pageNum = 1; pageNum <= totalPages; pageNum += 1) {
      const record = pageNum === 1 ? getPageRecord(0) : createDocumentPage(pageNum - 1);
      await renderPdfPage(pageNum, record);
    }
    showPageStack();
    updatePageInfo();
    
    if (el.currentFileName) {
      el.currentFileName.textContent = file.name;
    }
    if (el.currentFileMeta) {
      el.currentFileMeta.textContent = `${totalPages} pages`;
    }
  } catch (err) {
    console.error(`${UI_LOG_PREFIX} PDF load error:`, err);
    throw err;
  }
}

async function renderPdfPage(pageNum, record = null) {
  if (!pdfDocument) return;
  
  const page = await pdfDocument.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1.5 });
  
  const target = record || getPageRecord(pageNum - 1) || createDocumentPage(pageNum - 1);
  const canvas = target.canvas;
  if (!canvas) return;
  
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  target.sourceSize = { width: viewport.width, height: viewport.height };
  
  const ctx = canvas.getContext('2d');
  await page.render({
    canvasContext: ctx,
    viewport: viewport,
  }).promise;
  
  canvas.style.display = 'block';
  applyZoom();
}

function isImageFile(file) {
  const mime = String(file?.type || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(file?.name || '');
}

function renderFileList() {
  renderSetupFileCards();
}

function renderSetupFileCards() {
  if (!el.setupFileCards) return;
  el.setupFileCards.innerHTML = '';
  if (!selectedFiles.length) return;

  selectedFiles.forEach((file, index) => {
    const fileName = String(file.name || 'Untitled document');
    const isImage = isImageFile(file);
    const thumb = isImage
      ? `<img src="${getFilePreviewUrl(file)}" alt="" loading="lazy"/>`
      : `<i data-lucide="file-text"></i>`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `setup-file-card${index === currentFileIndex ? ' active' : ''}`;
    button.innerHTML = `
      <span class="setup-file-thumb ${isImage ? 'is-image' : 'is-pdf'}">${thumb}</span>
      <span class="setup-file-body">
        <strong title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</strong>
        <small>${formatFileSize(file.size)}</small>
      </span>
    `;
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      currentFileIndex = index;
      await loadFile(file, { replaceQueue: false });
      setWorkspaceMode('setup');
      openSetupPreviewDialog();
    });
    el.setupFileCards.appendChild(button);
  });
  refreshIcons();
}

async function selectFile(index) {
  currentFileIndex = index;
  const file = selectedFiles[index];
  if (file) {
    await loadFile(file, { replaceQueue: false });
    if (workspaceMode === 'setup') openSetupPreviewDialog();
  }
}

function removeFile(index) {
  const file = selectedFiles[index];
  if (file) revokeFilePreviewUrl(file);
  selectedFiles.splice(index, 1);
  if (currentFileIndex >= selectedFiles.length) {
    currentFileIndex = Math.max(0, selectedFiles.length - 1);
  }
  renderFileList();
  updateUI();
  
  if (selectedFiles.length === 0) {
    currentFile = null;
    sourceCanvas = null;
    requiredAssetsReady = false;
    showEmptyViewer();
    appState.patch({ files: [], currentFileIndex: 0, results: null });
    setSetupTab('upload');
    refreshAssetRequirements({ allowWarmup: false });
  } else {
    selectFile(currentFileIndex);
  }
}

function formatFileSize(bytes) {
  if (!Number.isFinite(Number(bytes))) return '-';
  bytes = Number(bytes);
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ===== FILE PREVIEW =====
async function loadFilePreview(file) {
  if (!file || !sourceCanvas) return;
  
  const record = resetPageStack();
  if (!record) return;
  const canvas = record.canvas;
  
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  record.sourceSize = { width: sourceCanvas.width, height: sourceCanvas.height };
  const ctx = canvas.getContext('2d');
  ctx.drawImage(sourceCanvas, 0, 0);
  canvas.style.display = 'block';
  showPageStack();
  
  updateZoomDisplay();
  applyZoom();
  
  // Update toolbar
  if (el.currentFileName) {
    el.currentFileName.textContent = file.name;
  }
  if (el.currentFileMeta) {
    el.currentFileMeta.textContent = `1 / 1`;
  }
}

function showEmptyViewer() {
  el.emptyViewer?.classList.remove('hidden');
  hidePageStack();
  clearLayoutOverlay();
  if (el.currentFileName) {
    el.currentFileName.textContent = '';
  }
}

// ===== PROCESSING =====
async function runPipeline() {
  if (!currentFile || selectedFiles.length === 0 || appState.get('isProcessing')) {
    showLoading('No file selected or already processing');
    return;
  }
  if (!requiredAssetsReady) {
    showLoading('Download required assets first');
    renderAssetGate();
    updateUI();
    return;
  }
  if (!isCurrentRuntimeReady()) {
    scheduleBackgroundWarmup(0);
    showLoading('Runtime is still preparing');
    updateUI();
    return;
  }
  
  currentRunConfig = getCurrentRunConfig();
  updateRunSummary(currentRunConfig);
  setWorkspaceMode('workspace');
  showProgress();
  
  try {
    if (warmupTimer) {
      clearTimeout(warmupTimer);
      warmupTimer = null;
    }
    await warmDocumentRuntime({ background: false });
    if (!pipelineAdapter.isPrepared(appState, currentFile)) {
      hideProgress();
      setWorkspaceMode('setup');
      showLoading('Runtime preparation cancelled');
      return;
    }

    const filesToRun = [...selectedFiles];
    for (let index = 0; index < filesToRun.length; index++) {
      currentFileIndex = index;
      currentFile = filesToRun[index];
      currentFileType = isImageFile(currentFile) ? 'image' : 'pdf';
      clearViewer();
      resetRunState(index);
      const runDisposer = createDisposerChain(`runPipeline[${index}]`);
      runDisposer.add(() => {
        // Release any OffscreenCanvas / image data held by the pipeline adapter
        if (typeof pipelineAdapter._releaseRunResources === 'function') {
          pipelineAdapter._releaseRunResources();
        }
      });
      try {
        await pipelineAdapter.run(appState);
      } finally {
        await runDisposer.runAll();
      }
      if (!appState.get('results')) {
        if (!appState.get('isProcessing') && appState.get('processingStage') == null) break;
        throw new Error('Processing finished without output');
      }
    }
    selectedFiles = [];
    currentFileIndex = 0;
    appState.patch({ files: [], currentFileIndex: 0 });
    renderSetupFileCards();
    updateSetupUploadState();
    updateSetupTabs();
    updateUI();
    showLoading(filesToRun.length > 1 ? 'Batch processing complete' : 'Processing complete');
  } catch (err) {
    console.error(`${UI_LOG_PREFIX} Pipeline failed:`, err);
    hideProgress();
    showLoading(`Processing failed: ${err.message}`, 3000);
  }
}

function resetRunState(index) {
  appState.patch({
    files: [...selectedFiles],
    currentFileIndex: index,
    timings: emptyTimingSet(),
    progress: { current: 0, total: 0 },
    results: null,
  });
  updateProgress(0);
  updateUI();
}

function showProgress() {
  el.progressOverlay?.classList.remove('hidden');
  if (el.startBtn) el.startBtn.disabled = true;
  if (el.downloadBtn) el.downloadBtn.disabled = true;
  if (el.progressTitle) el.progressTitle.textContent = 'Processing document';
  if (el.progressMessage) el.progressMessage.textContent = 'Extracting content from the current document.';
  updateProgress(0);
  
  // Start elapsed time counter
  processingStartTime = Date.now();
  updateElapsedTime();
  elapsedTimeInterval = setInterval(updateElapsedTime, 100);
}

function updateElapsedTime() {
  if (!processingStartTime) return;
  const elapsed = (Date.now() - processingStartTime) / 1000;
  const timeEl = document.getElementById('timeElapsed');
  if (timeEl) {
    timeEl.textContent = `${elapsed.toFixed(1)}s`;
  }
}

function hideProgress() {
  el.progressOverlay?.classList.add('hidden');
  if (elapsedTimeInterval) {
    clearInterval(elapsedTimeInterval);
    elapsedTimeInterval = null;
  }
  processingStartTime = 0;
}

// ===== RESULTS DISPLAY =====
function displayResults(results) {
  hideProgress();
  
  if (!results) return;
  if (currentFile) {
    results.fileName = currentFile.name;
    results.fileSize = currentFile.size;
  }
  setWorkspaceMode('workspace');
  prepareLinkedBlocks(results);
  syncedPageIndex = null;
  syncedLinkId = null;
  totalPages = results.page_count || totalPages || 1;
  currentPage = 1;
  updatePageInfo();
  
  // Display markdown with page separators
  if (results.markdown) {
    displayMarkdown(results.markdown, results.page_count || 1, results.content_list);
  }
  
  displayJSON(results.content_list, 'content');
  renderLayoutOverlay();
  currentStageTimings = getStageTimingsFromResults(results);
  results.processingTotalMs = Number(currentStageTimings.total || results.processingTotalMs || 0);
  updateTimingsDisplay(currentStageTimings);
  updateRunSummary(currentRunConfig);
  
  // Save to history
  if (currentFile) {
    saveToHistory(currentFile, results);
  }
  
  // Enable buttons
  if (el.downloadBtn) el.downloadBtn.disabled = false;
  updateUI();
  
  showLoading('Processing complete!');
}

function displayMarkdown(markdown, pageCount = 1, contentList = null) {
  if (!el.markdownContent) return;
  
  const emptyMd = el.markdownContent.querySelector('.empty-markdown');
  if (emptyMd) emptyMd.remove();

  // Render markdown while preserving LaTeX blocks before marked parses inline syntax.
  try {
    // Protect LaTeX blocks from being mangled by marked.parse()
    const latexBlocks = [];
    let protectedSource = markdown;

      // Protect display math ($$...$$) — must come before inline ($...$)
      protectedSource = protectedSource.replace(/\$\$([\s\S]*?)\$\$/g, (_, latex) => {
        const trimmed = sanitizeFormulaLatex(latex.trim());
        const idx = latexBlocks.length;
        latexBlocks.push({ latex: trimmed, display: true });
        const safe = trimmed.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        return `<div class="katex-display-placeholder" data-idx="${idx}" data-formula-source="${safe}"></div>`;
      });

      // Protect inline math ($...$)
      protectedSource = protectedSource.replace(/(?<!\$)\$(?!\$)([\s\S]+?)(?<!\$)\$(?!\$)/g, (_, latex) => {
        const trimmed = sanitizeFormulaLatex(latex.trim());
        if (!trimmed) return `$${latex}$`; // empty — skip
        const idx = latexBlocks.length;
        latexBlocks.push({ latex: trimmed, display: false });
        const safe = trimmed.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        return `<span class="katex-inline-placeholder" data-idx="${idx}" data-formula-source="${safe}"></span>`;
      });

    const rendered = marked.parse(protectedSource);
    el.markdownContent.innerHTML = DOMPurify.sanitize(rendered, {
      ADD_ATTR: ['data-idx', 'data-formula-source', 'target'],
    });

    // Hoist every display-math placeholder out of inline wrappers (typically <p>)
    // so it always renders as a top-level block. PDF markdown frequently emits `$$..$$`
    // without surrounding blank lines, which marked wraps in <p>; CSS centering on the
    // placeholder alone can't beat the inline flow of its parent <p>.
    hoistDisplayFormulaPlaceholders(el.markdownContent);

    const macros = {
      '\\rmathrm': '\\mathrm',
      '\\rmath': '\\mathrm',
      '\\mbox': '\\text',
    };

    for (const mathEl of el.markdownContent.querySelectorAll('[data-idx]')) {
      const block = latexBlocks[parseInt(mathEl.dataset.idx)];
      if (!block) continue;
      try {
        const renderedMath = katex.renderToString(block.latex, {
          displayMode: block.display,
          throwOnError: false,
          strict: false,
          trust: false,
          macros,
        });
        if (hasKatexRenderError(renderedMath)) throw new Error('KaTeX render contained error markup');
        mathEl.innerHTML = renderedMath;
      } catch {
        const code = document.createElement('code');
        code.style.cssText = 'background:rgba(0,0,0,.05);padding:2px 4px;border-radius:3px;font-size:.9em;';
        code.textContent = block.display ? `$$${block.latex}$$` : `$${block.latex}$`;
        mathEl.replaceWith(code);
      }
    }

    applyMarkdownImageSources();
    applyLayoutBasedStyling();
    attachBlockActions();
    linkMarkdownBlocks(pageCount, contentList);
    updateQuickNavVisibility();
  } catch (err) {
    console.error('[Markdown] Render error:', err);
    el.markdownContent.textContent = markdown;
  }
}

function applyMarkdownImageSources() {
  if (!el.markdownContent) return;
  
  // Get image map from results if available
  const results = appState.get('results');
  
  if (!results) {
    console.warn(`${UI_LOG_PREFIX} No results available for image sources`);
    return;
  }
  
  const imageMap = results.images || results.image_map || results.imageMap;
  if (!imageMap) {
    console.warn(`${UI_LOG_PREFIX} No images in results`);
    return;
  }
  
  const lookup = buildImageLookup(imageMap);
  
  if (!lookup.size) return;

  for (const img of el.markdownContent.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    
    if (!src || /^(https?:|data:|blob:)/i.test(src)) continue;
    
    const clean = normalizeImageKey(src);
    const direct = lookup.get(clean)
      || lookup.get(clean.replace(/^images\//, ''))
      || lookup.get(`images/${clean}`);
    
    if (direct) {
      img.src = direct;
    } else {
      console.warn(`${UI_LOG_PREFIX} Image not found in map:`, clean);
    }
  }
}

function buildImageLookup(imageMap) {
  const lookup = new Map();
  const entries = imageMap instanceof Map
    ? imageMap.entries()
    : Object.entries(imageMap);

  for (const [key, value] of entries) {
    if (typeof value !== 'string') continue;
    const clean = normalizeImageKey(key);
    if (!clean) continue;
    lookup.set(clean, value);
    if (!clean.startsWith('images/')) {
      lookup.set(`images/${clean}`, value);
    }
  }
  return lookup;
}

function normalizeImageKey(value) {
  return String(value || '').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function normalizeLayoutText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function shortHash(value) {
  const text = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function makeStableLinkId(source, pageIndex, order, rect, type, text) {
  const box = rect
    ? [rect.x0, rect.y0, rect.x1, rect.y1].map(v => Math.round(Number(v) || 0)).join(',')
    : 'none';
  const signature = [
    source || 'block',
    pageIndex,
    order,
    String(type || 'block').toLowerCase(),
    box,
    normalizeLayoutText(text).slice(0, 120),
  ].join('|');
  return `link-${pageIndex}-${order}-${shortHash(signature)}`;
}

function buildLayoutLabelLookup(results) {
  const lookup = new Map();
  const blocks = Array.isArray(results?.layout_label_blocks) ? results.layout_label_blocks : [];
  blocks.forEach((item) => {
    const text = normalizeLayoutText(item?.text);
    if (!text) return;
    const pageIndex = Number(item?.pageNo ?? item?.page_index ?? item?.pageIndex ?? item?.page_idx ?? 0);
    if (!Number.isFinite(pageIndex)) return;
    lookup.set(`${pageIndex}:${text}`, {
      originalLabel: item?.originalLabel ?? item?.original_label ?? null,
      blockType: item?.blockType ?? item?.block_type ?? null,
    });
  });
  return lookup;
}

function getOverlayLabel({ originalLabel, type }) {
  if (originalLabel) return originalLabel;
  const safeType = String(type || 'layout');
  return safeType;
}

function classifyOverlayCategory({ type, label, originalLabel }) {
  const rawType = String(type || '').toLowerCase();
  const rawLabel = String(originalLabel || label || '').toLowerCase();
  if (rawType === 'discarded' || rawLabel.includes('discarded')) return 'discarded';
  if (/formula|equation/.test(rawLabel) || /equation/.test(rawType)) return 'formula';
  if (/caption|footnote/.test(rawLabel)) return 'caption';
  if (/figure|image|table|chart/.test(rawLabel) || /image|table/.test(rawType)) return 'figure';
  return 'text';
}

function buildOverlayBlocks(results) {
  if (!results) return [];

  const middleParaBlocks = buildOverlayBlocksFromMiddlePdfInfo(results);
  if (middleParaBlocks.length) return middleParaBlocks;

  const stored = Array.isArray(results.overlay_blocks) ? results.overlay_blocks : [];
  if (stored.length) {
    return stored.map((block, index) => {
      const type = String(block?.type || block?.block_type || 'block');
      const originalLabel = block?.originalLabel ?? block?.original_label ?? null;
      const label = block?.label || getOverlayLabel({ originalLabel, type });
      return {
        ...block,
        id: block?.id || `history-${block?.pageIndex ?? 0}-${index}`,
        type,
        label,
        originalLabel,
        category: block?.category || classifyOverlayCategory({ type, label, originalLabel }),
        sourceSize: block?.sourceSize || block?.source_size || { width: 1000, height: 1000 },
      };
    });
  }

  const labelLookup = buildLayoutLabelLookup(results);
  const contentBlocks = buildContentOverlayBlocks(results, labelLookup);
  const middleBlocks = buildMiddleOverlayBlocks(results);

  if (contentBlocks.length && middleBlocks.length) {
    return mergeContentWithMiddleBlocks(contentBlocks, middleBlocks);
  }
  if (contentBlocks.length) return contentBlocks;
  if (middleBlocks.length) return middleBlocks;

  return buildRawOverlayBlocks(results);
}

function buildContentOverlayBlocks(results, labelLookup = new Map()) {
  const contentList = Array.isArray(results?.content_list) ? results.content_list : [];
  return contentList.reduce((acc, item, index) => {
    const rect = normalizeBox(item?.bbox);
    if (!rect) return acc;
    const pageIndex = getItemPageIndex(item);
    const type = String(item?.type || item?.block_type || 'block');
    const text = getContentItemText(item);
    if (type.toLowerCase() === 'text' && !text) return acc;
    const labelInfo = text ? labelLookup.get(`${pageIndex}:${text}`) : null;
    const originalLabel = labelInfo?.originalLabel ?? item?.original_label ?? null;
    const label = getOverlayLabel({ originalLabel, type });
    acc.push({
      id: makeStableLinkId('content', pageIndex, index, rect, type, text),
      pageIndex,
      bbox: rect,
      sourceSize: { width: 1000, height: 1000 },
      label,
      type,
      originalLabel,
      category: classifyOverlayCategory({ type, label, originalLabel }),
      text,
      source: 'content',
      item,
      contentIndex: index,
      contentOrder: index,
    });
    return acc;
  }, []);
}

function buildOverlayBlocksFromMiddlePdfInfo(results) {
  const pages = Array.isArray(results?.middle_json?.pdf_info) ? results.middle_json.pdf_info : [];
  if (!pages.length) return [];
  const contentByPage = groupContentListByPage(results?.content_list);
  const blocks = [];
  const globalPreprocBlocks = buildGlobalPreprocBlocks(pages, results);

  pages.forEach((page, pageIndex) => {
    const sourceSize = getMiddlePageSize(page) || getOverlaySourceSize(results, pageIndex, []);
    const paraBlocks = Array.isArray(page?.para_blocks) ? page.para_blocks : [];
    const discardedBlocks = Array.isArray(page?.discarded_blocks) ? page.discarded_blocks : [];
    const pageContent = contentByPage.get(pageIndex) || [];
    let contentCursor = 0;

    paraBlocks.forEach((paraBlock, paraIndex) => {
      const paraText = extractParaOutputText(paraBlock);
      if (isDeletedOrEmptyTextBlock(paraBlock, paraText)) return;
      const contentIndex = findMatchingContentIndex(pageContent, paraText, contentCursor);
      if (contentIndex >= 0) contentCursor = contentIndex + 1;
      const physicalBlocks = findPreprocBlocksForPara(paraBlock, paraText, globalPreprocBlocks, pageIndex);
      const overlayParts = physicalBlocks.length ? physicalBlocks : [paraBlock];
      const baseId = makeStableLinkId('para', pageIndex, paraIndex, normalizeBox(paraBlock), paraBlock?.type, paraText);
      const mergeGroupId = overlayParts.length > 1
        ? `merge-${pageIndex}-${shortHash(`${baseId}:${overlayParts.map(block => getMiddleBlockSortKey(block)).join('|')}`)}`
        : '';

      overlayParts.forEach((part, partIndex) => {
        const rect = normalizeBox(part);
        if (!rect) return;
        const type = String(part?.type || paraBlock?.type || part?.original_label || 'block');
        const originalLabel = part?.original_label ?? paraBlock?.original_label ?? null;
        const label = getOverlayLabel({ originalLabel, type });
        blocks.push({
          id: overlayParts.length > 1
            ? `${baseId}-part-${partIndex}-${shortHash(getMiddleBlockSortKey(part))}`
            : baseId,
          mergeGroupId,
          pageIndex: Number(part?.sourcePageIndex ?? pageIndex),
          sourcePageIndex: Number(part?.sourcePageIndex ?? pageIndex),
          bbox: rect,
          sourceSize: part?.sourceSize || sourceSize,
          label,
          type,
          originalLabel,
          category: classifyOverlayCategory({ type, label, originalLabel }),
          text: paraText,
          contentText: paraText,
          source: overlayParts.length > 1 ? 'para-merge' : 'para',
          contentIndex: contentIndex >= 0 ? pageContent[contentIndex].index : undefined,
          contentOrder: contentIndex >= 0 ? pageContent[contentIndex].index : paraIndex,
          middleOriginalOrder: Number(part?.original_order ?? paraBlock?.original_order ?? paraIndex),
          middleIndex: Number(part?.index ?? paraBlock?.index ?? partIndex),
          sourcePreprocOrders: overlayParts
            .map(block => Number(block?.original_order))
            .filter(Number.isFinite),
          item: part,
        });
      });
    });

    discardedBlocks.forEach((block, index) => {
      const rect = normalizeBox(block);
      if (!rect) return;
      const text = extractParaOutputText(block);
      const type = String(block?.type || block?.original_label || 'discarded');
      const originalLabel = block?.original_label ?? null;
      const label = getOverlayLabel({ originalLabel, type });
      blocks.push({
        id: makeStableLinkId('discarded', pageIndex, index, rect, type, text),
        pageIndex,
        bbox: rect,
        sourceSize,
        label,
        type,
        originalLabel,
        category: classifyOverlayCategory({ type, label, originalLabel }),
        text,
        source: 'discarded',
        middleOriginalOrder: Number(block?.original_order ?? index),
        middleIndex: Number(block?.index ?? index),
        item: block,
      });
    });
  });

  return blocks;
}

function groupContentListByPage(contentList) {
  const grouped = new Map();
  if (!Array.isArray(contentList)) return grouped;
  contentList.forEach((item, index) => {
    const text = getContentItemText(item);
    if (String(item?.type || '').toLowerCase() === 'text' && !text) return;
    const pageIndex = getItemPageIndex(item);
    if (!grouped.has(pageIndex)) grouped.set(pageIndex, []);
    grouped.get(pageIndex).push({ item, index, text });
  });
  return grouped;
}

function buildGlobalPreprocBlocks(pages, results) {
  const blocks = [];
  pages.forEach((page, pageIndex) => {
    const sourceSize = getMiddlePageSize(page) || getOverlaySourceSize(results, pageIndex, []);
    const pageBlocks = Array.isArray(page?.preproc_blocks) ? page.preproc_blocks : [];
    pageBlocks.forEach((block, index) => {
      blocks.push({
        ...block,
        sourcePageIndex: pageIndex,
        sourceSize,
        sourcePageOrder: index,
      });
    });
  });
  return blocks;
}

function findMatchingContentIndex(pageContent, paraText, startIndex = 0) {
  const target = normalizeComparableText(paraText);
  if (!target) return -1;
  for (let index = Math.max(0, startIndex); index < pageContent.length; index += 1) {
    const candidate = normalizeComparableText(pageContent[index]?.text);
    if (!candidate) continue;
    if (candidate === target || candidate.includes(target) || target.includes(candidate)) return index;
    if (orderedTokenCoverage(target, candidate) >= 0.88) return index;
  }
  return -1;
}

function findPreprocBlocksForPara(paraBlock, paraText, preprocBlocks, paraPageIndex = 0) {
  const target = normalizeComparableText(paraText);
  if (!target || !Array.isArray(preprocBlocks) || !preprocBlocks.length) return [];

  const paraLabelGroup = labelGroupKey(paraBlock?.original_label, paraBlock?.type);

  const candidates = preprocBlocks
    .filter(block => {
      const text = normalizeComparableText(extractBlockText(block));
      if (!text) return false;
      if (block?.lines_deleted) return false;
      if (!isCompatibleOverlayType(paraBlock, block)) return false;
      const blockLabelGroup = labelGroupKey(block?.original_label, block?.type);
      return paraLabelGroup === blockLabelGroup;
    })
    .sort(compareMiddleSourceBlocks);
  if (!candidates.length) return [];

  const preferredOrder = Number(paraBlock?.original_order ?? paraBlock?.index);
  const startCandidates = Number.isFinite(preferredOrder)
    ? candidates
        .map((block, index) => ({ block, index }))
        .filter(({ block }) => Number(block?.sourcePageIndex ?? paraPageIndex) === paraPageIndex
          && Number(block?.original_order ?? block?.index) === preferredOrder)
    : [];
  const starts = startCandidates.length
    ? startCandidates
    : candidates.map((block, index) => ({ block, index }));

  let best = { group: [], coverage: 0, extra: 1 };
  for (const { index: start } of starts) {
    const group = [];
    let combined = '';
    let cursor = 0;
    for (let index = start; index < candidates.length; index += 1) {
      const block = candidates[index];
      const text = normalizeComparableText(extractBlockText(block));
      const pos = findOrderedTextPosition(target, text, cursor);
      if (pos < 0) break;
      group.push(block);
      combined = normalizeComparableText(`${combined} ${text}`);
      cursor = pos + Math.min(text.length, 80);
      const coverage = orderedTokenCoverage(target, combined);
      const extra = Math.max(0, combined.length - target.length) / Math.max(1, combined.length);
      if (coverage > best.coverage || (coverage === best.coverage && extra < best.extra)) {
        best = { group: [...group], coverage, extra };
      }
      if (coverage >= 0.98) break;
    }
  }

  if (!best.group.length) return [];
  if (best.group.length > 1 && best.coverage >= 0.82 && best.extra <= 0.18) return best.group;
  if (best.group.length === 1 && best.coverage >= 0.82) return best.group;
  return [];
}

function isDeletedOrEmptyTextBlock(block, text) {
  if (block?.lines_deleted) return true;
  const type = String(block?.type || '').toLowerCase();
  return ['text', 'list', 'index', 'title', 'discarded'].includes(type) && !normalizeLayoutText(text);
}

function isCompatibleOverlayType(paraBlock, sourceBlock) {
  const paraType = String(paraBlock?.type || '').toLowerCase();
  const sourceType = String(sourceBlock?.type || '').toLowerCase();
  if (!paraType || !sourceType) return true;
  if (paraType === sourceType) return true;
  if (['text', 'list', 'index'].includes(paraType) && sourceType === 'text') return true;
  if (paraType === 'title' && /title|text/.test(sourceType)) return true;
  return false;
}

/**
 * Compress original_label / block type into a coarse semantic group.
 * Used to prevent cross-category block merging in findPreprocBlocksForPara.
 */
function labelGroupKey(originalLabel, blockType) {
  const label = String(originalLabel || '').toLowerCase();
  const type = String(blockType || '').toLowerCase();
  // Hard categories first by original_label (most specific signal from the layout model).
  if (/doc[_-]?title/.test(label)) return 'doc_title';
  if (/figure[_-]?title|chart[_-]?title|image[_-]?caption/.test(label)) return 'figure_caption';
  if (/table[_-]?title|table[_-]?caption/.test(label)) return 'table_caption';
  if (/image[_-]?footnote/.test(label)) return 'figure_footnote';
  if (/table[_-]?footnote/.test(label)) return 'table_footnote';
  if (/footnote/.test(label)) return 'footnote';
  if (/paragraph[_-]?title|section[_-]?title|sub[_-]?title|heading|^title$/.test(label)) return 'title';
  if (/header(?!_image)/.test(label)) return 'header';
  if (/footer(?!_image)/.test(label)) return 'footer';
  if (/aside/.test(label)) return 'aside';
  if (/header[_-]?image|footer[_-]?image/.test(label)) return 'aux_image';
  if (/abstract|reference|content/.test(label)) return 'text';
  // Fall back on block type when original_label is missing.
  if (type === 'title') return 'title';
  if (type === 'image' || type === 'figure') return 'media_image';
  if (type === 'table') return 'media_table';
  if (type === 'interline_equation' || type === 'inline_equation') return 'equation';
  if (type === 'list' || type === 'index' || type === 'discarded') return type;
  // Default for plain body text-like blocks.
  return 'text';
}

function findOrderedTextPosition(target, candidate, cursor = 0) {
  if (!target || !candidate) return -1;
  const direct = target.indexOf(candidate, Math.max(0, cursor - 24));
  if (direct >= 0) return direct;
  const probe = candidate.slice(0, Math.min(96, candidate.length));
  if (probe.length >= 24) {
    return target.indexOf(probe, Math.max(0, cursor - 24));
  }
  return -1;
}

function orderedTokenCoverage(targetText, candidateText) {
  const targetTokens = normalizeComparableText(targetText).split(/\s+/).filter(Boolean);
  const candidateTokens = normalizeComparableText(candidateText).split(/\s+/).filter(Boolean);
  if (!targetTokens.length || !candidateTokens.length) return 0;
  let hits = 0;
  let cursor = 0;
  for (const token of candidateTokens) {
    const found = targetTokens.indexOf(token, cursor);
    if (found >= 0) {
      hits += 1;
      cursor = found + 1;
    }
  }
  return hits / targetTokens.length;
}

function compareMiddleSourceBlocks(a, b) {
  const pageA = Number(a?.sourcePageIndex ?? 0);
  const pageB = Number(b?.sourcePageIndex ?? 0);
  if (pageA !== pageB) return pageA - pageB;
  const orderA = Number(a?.original_order ?? a?.index ?? 0);
  const orderB = Number(b?.original_order ?? b?.index ?? 0);
  if (orderA !== orderB) return orderA - orderB;
  return Number(a?.index ?? 0) - Number(b?.index ?? 0);
}

function getMiddleBlockSortKey(block) {
  return `${Number(block?.original_order ?? -1)}:${Number(block?.index ?? -1)}`;
}

function buildMiddleOverlayBlocks(results) {
  const pages = Array.isArray(results?.middle_json?.pdf_info) ? results.middle_json.pdf_info : [];
  const middleBlocks = [];
  pages.forEach((page, pageIndex) => {
    const sourceSize = getMiddlePageSize(page) || getOverlaySourceSize(results, pageIndex, []);
    const blocks = Array.isArray(page?.preproc_blocks) ? page.preproc_blocks : [];
    blocks.forEach((block, index) => {
      const rect = normalizeBox(block);
      if (!rect) return;
      const type = String(block?.type || block?.original_label || 'layout');
      const originalLabel = block?.original_label ?? null;
      const label = getOverlayLabel({ originalLabel, type });
      const text = extractBlockText(block);
      middleBlocks.push({
        id: makeStableLinkId('middle', pageIndex, index, rect, type, text),
        pageIndex,
        bbox: rect,
        sourceSize,
        label,
        type,
        originalLabel,
        category: classifyOverlayCategory({ type, label, originalLabel }),
        text,
        source: 'middle',
        item: block,
        middleIndex: Number(block?.index ?? index),
        middleOriginalOrder: Number(block?.original_order ?? index),
        sourceOrder: Number(block?.original_order ?? index),
      });
    });
  });
  return middleBlocks;
}

function mergeContentWithMiddleBlocks(contentBlocks, middleBlocks) {
  const byPage = new Map();
  middleBlocks.forEach((block) => {
    if (!byPage.has(block.pageIndex)) byPage.set(block.pageIndex, []);
    byPage.get(block.pageIndex).push(block);
  });
  byPage.forEach((blocks) => blocks.sort(compareMiddleOverlayBlocks));

  const merged = [];
  contentBlocks.forEach((contentBlock) => {
    const pageMiddleBlocks = byPage.get(contentBlock.pageIndex) || [];
    const group = findSourceGroundedMergeGroup(contentBlock, pageMiddleBlocks);
    if (!group.length) {
      merged.push(contentBlock);
      return;
    }

    if (group.length === 1) {
      const match = group[0];
      merged.push({
        ...match,
        id: contentBlock.id,
        text: contentBlock.text || match.text,
        contentText: contentBlock.text,
        contentIndex: contentBlock.contentIndex,
        contentOrder: contentBlock.contentOrder,
        middleOriginalOrder: match.middleOriginalOrder,
        middleIndex: match.middleIndex,
        source: 'middle-content',
      });
      return;
    }

    const groupId = `merge-${contentBlock.pageIndex}-${shortHash(`${contentBlock.id}:${group.map(item => item.id).join('|')}`)}`;
    group.forEach((match, groupIndex) => {
      merged.push({
        ...match,
        id: `${contentBlock.id}-part-${groupIndex}-${shortHash(match.id)}`,
        mergeGroupId: groupId,
        text: contentBlock.text || match.text,
        contentText: contentBlock.text,
        contentIndex: contentBlock.contentIndex,
        contentOrder: contentBlock.contentOrder,
        middleOriginalOrder: match.middleOriginalOrder,
        middleIndex: match.middleIndex,
        source: 'middle-merge',
      });
    });
  });
  return merged;
}

function compareMiddleOverlayBlocks(a, b) {
  const orderA = Number.isFinite(a?.middleOriginalOrder) ? a.middleOriginalOrder : (a?.sourceOrder ?? 0);
  const orderB = Number.isFinite(b?.middleOriginalOrder) ? b.middleOriginalOrder : (b?.sourceOrder ?? 0);
  if (orderA !== orderB) return orderA - orderB;
  return (a?.middleIndex ?? 0) - (b?.middleIndex ?? 0);
}

function findSourceGroundedMergeGroup(contentBlock, middleBlocks) {
  const targetText = normalizeLayoutText(contentBlock?.text);
  if (!targetText || !middleBlocks.length) return [];

  const targetLabelGroup = labelGroupKey(contentBlock?.originalLabel, contentBlock?.type);
  const compatibleBlocks = middleBlocks.filter(block =>
    labelGroupKey(block?.originalLabel, block?.type) === targetLabelGroup
  );
  if (!compatibleBlocks.length) return [];

  let bestGroup = [];
  let bestCoverage = 0;
  const sortedBlocks = [...compatibleBlocks].sort(compareMiddleOverlayBlocks);
  let run = [];
  const finishRun = () => {
    if (!run.length) return;
    const coverage = textTokenCoverage(targetText, run.map(item => item.text).join(' '));
    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      bestGroup = [...run];
    }
    run = [];
  };

  for (const candidate of sortedBlocks) {
    const candidateText = normalizeLayoutText(candidate.text);
    if (!candidateText) {
      finishRun();
      continue;
    }
    if (isMiddleBlockPartOfContent(targetText, candidateText)) {
      run.push(candidate);
    } else {
      finishRun();
    }
  }
  finishRun();

  if (!bestGroup.length) return [];
  if (bestGroup.length > 1 && bestCoverage >= 0.82) return bestGroup;
  if (bestGroup.length === 1 && bestCoverage >= 0.82) return bestGroup;
  return [];
}

function isMiddleBlockPartOfContent(targetText, candidateText) {
  if (!targetText || !candidateText) return false;
  if (targetText.includes(candidateText)) return true;
  const probe = candidateText.slice(0, Math.min(56, candidateText.length));
  if (probe.length >= 16 && targetText.includes(probe)) return true;
  return textTokenCoverage(candidateText, targetText) >= 0.72;
}

function textTokenCoverage(targetText, candidateText) {
  const targetTokens = normalizeLayoutText(targetText).split(/\s+/).filter(token => token.length > 1);
  const candidateTokens = normalizeLayoutText(candidateText).split(/\s+/).filter(token => token.length > 1);
  if (!targetTokens.length || !candidateTokens.length) return 0;
  const candidateSet = new Set(candidateTokens);
  const hits = targetTokens.filter(token => candidateSet.has(token)).length;
  return hits / targetTokens.length;
}

function prepareLinkedBlocks(results) {
  linkedBlocks = [];
  activeLinkId = null;
  activeGroupId = '';
  if (pinReleaseListener) {
    document.removeEventListener('click', pinReleaseListener, true);
    pinReleaseListener = null;
  }
  pinnedLinkId = null;
  pinnedGroupId = '';
  syncedLinkId = null;
  if (!results) return linkedBlocks;
  if (
    Array.isArray(results.overlay_blocks) &&
    results.overlay_blocks.length > 0 &&
    results.overlay_blocks.every(block => block.id && String(block.id).length > 0)
  ) {
    linkedBlocks = results.overlay_blocks.map((block, order) => ({ ...block, order }));
  } else {
    linkedBlocks = buildOverlayBlocks(results).map((block, order) => ({ ...block, order }));
  }
  linkingCtx.linkedBlocks = linkedBlocks;
  return linkedBlocks;
}

function getItemPageIndex(item) {
  const raw = item?.page_idx ?? item?.pageIndex ?? item?.page_no ?? item?.pageNo ?? item?.page_num ?? 0;
  const num = Number(raw);
    return Number.isFinite(num) ? Math.max(0, Math.trunc(num)) : 0;
}

function getContentItemText(item) {
  if (!item || typeof item !== 'object') return '';
  const parts = [];
  if (item.text) parts.push(item.text);
  if (item.image_caption) parts.push(...[].concat(item.image_caption));
  if (item.image_footnote) parts.push(...[].concat(item.image_footnote));
  if (item.table_caption) parts.push(...[].concat(item.table_caption));
  if (item.table_footnote) parts.push(...[].concat(item.table_footnote));
  if (item.table_body && typeof item.table_body === 'string') {
    parts.push(item.table_body.replace(/<[^>]+>/g, ' '));
  }
  return normalizeLayoutText(parts.join(' '));
}

function getMiddlePageSize(page) {
  const size = page?.page_size || page?.pageSize;
  if (Array.isArray(size) && size.length >= 2) {
    const width = Number(size[0]);
    const height = Number(size[1]);
    if (Number.isFinite(width) && Number.isFinite(height)) return { width, height };
  }
  const width = Number(page?.width ?? page?.w ?? page?.page_width);
  const height = Number(page?.height ?? page?.h ?? page?.page_height);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
}

function extractBlockText(block) {
  const parts = [];
  for (const line of Array.isArray(block?.lines) ? block.lines : []) {
    for (const span of Array.isArray(line?.spans) ? line.spans : []) {
      const token = normalizeLayoutText(span?.content ?? span?.text ?? '');
      if (token) parts.push(token);
    }
  }
  return normalizeLayoutText(parts.join(' '));
}

function extractParaOutputText(block) {
  if (!block || typeof block !== 'object') return '';
  const parts = [];
  const collectLineText = (source) => {
    for (const line of Array.isArray(source?.lines) ? source.lines : []) {
      for (const span of Array.isArray(line?.spans) ? line.spans : []) {
        const type = String(span?.type || '').toLowerCase();
        if (type && !['text', 'inline_equation', 'interline_equation', 'checkbox'].includes(type)) continue;
        const token = normalizeLayoutText(span?.content ?? span?.text ?? '');
        if (token) parts.push(token);
      }
    }
  };

  collectLineText(block);
  for (const child of Array.isArray(block.blocks) ? block.blocks : []) {
    collectLineText(child);
  }
  return normalizeLayoutText(parts.join(' '));
}

function normalizeComparableText(value) {
  return normalizeLayoutText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function applyLayoutBasedStyling() {
  return _applyLayoutBasedStyling();
}

function centerAlignVisuals() {
  // Delegated to applyLayoutBasedStyling via styling.js — kept as no-op for call-site compatibility.
}

function attachBlockActions() {
  return _attachBlockActions();
}

function isMediaOutputBlock(block) {
  return _isMediaOutputBlock(block);
}

/**
 * Lift each display-math placeholder out of any inline wrapper so it renders as a
 * true block-level element. The original wrapper stays in place (now possibly empty
 * or with surrounding text); attachBlockActions wraps each new block separately.
 */
function hoistDisplayFormulaPlaceholders(root) {
  return _hoistDisplayFormulaPlaceholders(root);
}

// Returns true when the block's primary visible content is a single display formula.
function isStandaloneDisplayFormulaBlock(block) {
  return _isStandaloneDisplayFormulaBlock(block);
}

function linkMarkdownBlocks(pageCount = 1, contentList = null) {
  if (!el.markdownContent) return;
  el.markdownContent.querySelectorAll('.markdown-page-divider').forEach(node => node.remove());

  el.markdownContent.querySelectorAll('.block-shell').forEach(shell => {
    delete shell.dataset.linkId;
    delete shell.dataset.linkGroupId;
    delete shell.dataset.pageIndex;
    shell.classList.remove('is-linked', 'is-merged-block');
  });

  if (!linkedBlocks.length) {
    prepareLinkedBlocks(appState.get('results'));
  }

  const shells = Array.from(el.markdownContent.querySelectorAll('.block-shell'));
  const candidates = linkedBlocks.length
    ? linkedBlocks
    : buildPageOnlyLinks(pageCount, contentList);

  let cursor = 0;
  const lastShellByPage = new Map();
  shells.forEach((shell) => {
    const block = shell.firstElementChild;
    const link = findNextMarkdownLink(block, candidates, cursor);
    if (!link) return;

    cursor = Math.max(cursor, candidates.indexOf(link) + 1);
    shell.dataset.linkId = link.id;
    shell.dataset.pageIndex = String(link.pageIndex);
    shell.dataset.linkLabel = link.label || link.type || 'block';
    shell.dataset.linkOrder = String(link.order ?? candidates.indexOf(link));
    const mergedLinks = getPrebuiltMergeLinks(link, candidates) || [link];
    if (link.mergeGroupId != null) {
      shell.dataset.linkGroupId = link.mergeGroupId;
    }
    if (mergedLinks.length > 1) {
      shell.classList.add('is-merged-block');
      cursor = Math.max(cursor, candidates.indexOf(mergedLinks[mergedLinks.length - 1]) + 1);
    }
    lastShellByPage.set(link.pageIndex, shell);
  });

  Array.from(lastShellByPage.entries())
    .sort(([a], [b]) => a - b)
    .forEach(([pageIndex, shell]) => {
      shell.insertAdjacentElement('afterend', createMarkdownPageDivider(pageIndex));
    });
}

function getPrebuiltMergeLinks(link, candidates) {
  if (!link?.mergeGroupId) return null;
  const group = candidates.filter(candidate => candidate.mergeGroupId === link.mergeGroupId);
  return group.length > 1 ? group : null;
}

function buildPageOnlyLinks(pageCount = 1, contentList = null) {
  const count = Math.max(1, Number(pageCount) || 1);
  const items = Array.isArray(contentList) ? contentList : [];
  return Array.from({ length: count }, (_, index) => ({
    id: `page-${index}`,
    pageIndex: index,
    label: 'page',
    type: 'page',
    text: normalizeLayoutText(items.filter(item => getItemPageIndex(item) === index).map(getContentItemText).join(' ')),
  }));
}

function createMarkdownPageDivider(pageIndex) {
  const divider = document.createElement('div');
  divider.className = 'page-divider markdown-page-divider';
  divider.dataset.pageIndex = String(pageIndex);
  divider.innerHTML = `<span>PAGE ${pageIndex + 1}</span>`;
  return divider;
}

function findNextMarkdownLink(block, candidates, startIndex) {
  if (!block || !candidates.length) return null;
  const blockText = extractBlockLinkText(block);
  const hasFormula = blockHasFormula(block);
  const isStandaloneFormula = isStandaloneDisplayFormulaBlock(block);
  const hasImage = Boolean(block.querySelector?.('img'));
  const tagName = block.tagName?.toLowerCase();
  const isMedia = isMediaOutputBlock(block);
  const blockLabelGroup = getMarkdownBlockLabelGroup(block);
  let best = null;
  let bestScore = 0;
  const start = startIndex;
  const end = Math.min(candidates.length, startIndex + 30);

  for (let i = start; i < end; i += 1) {
    const candidate = candidates[i];
    const score = scoreMarkdownLink({ blockText, hasImage, hasFormula, isStandaloneFormula, isMedia, tagName, blockLabelGroup }, candidate, Math.abs(i - startIndex));
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  if (bestScore >= 44) return best;

  const pageOnly = candidates[startIndex];
  if (pageOnly?.type === 'page') return pageOnly;
  return null;
}

/**
 * Derive a markdown shell's label group from data-original-label and tag/descendant heuristics.
 * Returns null when unknown so the scorer only gates when both sides have a confident label.
 */
function getMarkdownBlockLabelGroup(block) {
  if (!block) return null;
  const ol = block.getAttribute?.('data-original-label');
  if (ol) return labelGroupKey(ol, block.getAttribute('data-block-type'));
  const tag = String(block.tagName || '').toLowerCase();
  // When table model is off, <table> elements in markdown may correspond to image-type
  // candidates (the pipeline treated the table region as an image). Return null so the
  // cross-category gate does not block the match — text scoring decides instead.
  if (tag === 'table') return null;
  if (tag === 'figure') return 'media_image';
  if (block.querySelector?.('img, picture')) return 'media_image';
  if (block.classList?.contains?.('katex-display-placeholder')) return 'equation';
  return null;
}

/**
 * Extract link-comparison text from a rendered markdown block.
 * Substitutes KaTeX placeholders with their original LaTeX source so the scorer
 * can match middle-json paragraphs that carry bare LaTeX.
 */
function extractBlockLinkText(block) {
  return _extractBlockLinkText(block);
}

function blockHasFormula(block) {
  return _blockHasFormula(block);
}

function scoreMarkdownLink(blockInfo, candidate, distance = 0) {
  const type = String(candidate?.type || candidate?.label || '').toLowerCase();
  const label = String(candidate?.originalLabel || candidate?.label || '').toLowerCase();
  const source = String(candidate?.source || '').toLowerCase();
  const candidateText = normalizeLayoutText(candidate?.text);
  let score = 0;

  const candidateLabelGroup = labelGroupKey(candidate?.originalLabel, candidate?.type);
  const blockLabelGroup = blockInfo.blockLabelGroup;
  if (blockLabelGroup && candidateLabelGroup && blockLabelGroup !== candidateLabelGroup) {
    const bothPlainText = blockLabelGroup === 'text' && candidateLabelGroup === 'text';
    // FIX LINK-STEAL: when table model is off, tables are rendered as images in the pipeline.
    // Treat media_image and media_table as the same group so a <table> block can match an
    // image-type candidate (and vice versa) without being blocked by the cross-category gate.
    const bothMedia = (blockLabelGroup === 'media_image' || blockLabelGroup === 'media_table')
                   && (candidateLabelGroup === 'media_image' || candidateLabelGroup === 'media_table');
    if (!bothPlainText && !bothMedia) return 0;
  }

  if ((blockInfo.hasImage || blockInfo.isMedia) && /image|figure|chart|picture/.test(`${type} ${label} ${source}`)) {
    score = Math.max(score, 66);
  }
  if (blockInfo.tagName === 'table' && /table/.test(type)) score = Math.max(score, 62);
  if (blockInfo.hasImage && !candidateText && /image|figure|chart|picture/.test(`${type} ${label}`)) {
    score = Math.max(score, 60);
  }
  // FIX LINK-STEAL: when table model is off, a <table> in markdown may correspond to an
  // image-type candidate (the table was treated as an image region by the pipeline).
  // Also allow an image block to match a table-type candidate for the same reason.
  if (blockInfo.tagName === 'table' && /image|figure|chart|picture/.test(`${type} ${label} ${source}`)) {
    score = Math.max(score, 58);
  }
  if ((blockInfo.hasImage || blockInfo.isMedia) && /table/.test(type)) {
    score = Math.max(score, 58);
  }

  if (blockInfo.isStandaloneFormula && !blockInfo.hasImage && /formula|equation/.test(`${type} ${label} ${source}`)) {
    score = Math.max(score, 64);
  }

  const blockText = blockInfo.blockText;
  if (blockText && candidateText) {
    if (candidateText === blockText) {
      score = Math.max(score, 100);
    } else {
      const shorter = candidateText.length < blockText.length ? candidateText : blockText;
      const longer = candidateText.length < blockText.length ? blockText : candidateText;
      const probe = shorter.slice(0, Math.min(120, shorter.length));
      if (shorter.length >= 18 && longer.includes(probe)) {
        const coverage = Math.min(shorter.length, longer.length) / Math.max(shorter.length, longer.length);
        score = Math.max(score, 72 + coverage * 18);
      } else if (shorter.length >= 18) {
        const prefix = commonPrefixLength(shorter, longer);
        if (prefix >= 18) score = Math.max(score, 48 + Math.min(22, prefix / 3));
      }
    }
  }

  return Math.max(0, score - Math.min(18, distance * 2));
}

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

function handleBlockAction(event) {
  const button = event.target.closest('.block-action-bar button');
  if (!button) return;
  const shell = button.closest('.block-shell');
  const block = shell?.firstElementChild;
  if (!block) return;

  const action = button.dataset.action;
  if (action === 'copy') {
    navigator.clipboard.writeText(block.innerText || block.textContent || '').then(
      () => showLoading('Block copied'),
      () => showLoading('Failed to copy block')
    );
  }
}

function displayJSON(contentList, target = 'content') {
  const viewerByTarget = {
    content: el.contentJsonViewer,
  };
  const jsonViewer = viewerByTarget[target] || el.contentJsonViewer;
  if (!jsonViewer) return;
  if (contentList == null) {
    jsonViewer.textContent = 'No artifact available for this run.';
    return;
  }
  
  try {
    const jsonStr = JSON.stringify(contentList, null, 2);
    const lines = jsonStr.split('\n');
    
    let html = '<div class="json-lines">';
    lines.forEach((line, index) => {
      const lineNum = index + 1;
      const indent = line.match(/^\s*/)[0].length;
      const content = line.trim();
      
      // Syntax highlighting
      let highlighted = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:')
        .replace(/: "([^"]*)"/g, ': <span class="json-string">"$1"</span>')
        .replace(/: (-?\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
        .replace(/: (true|false)/g, ': <span class="json-boolean">$1</span>')
        .replace(/: null/g, ': <span class="json-null">null</span>');
      
      html += `<div class="json-line">
        <span class="line-number">${lineNum}</span>
        <span class="line-content" style="padding-left: ${indent * 8}px">${highlighted}</span>
      </div>`;
    });
    html += '</div>';
    
    jsonViewer.innerHTML = html;
  } catch (err) {
    console.error('[JSON] Display error:', err);
    jsonViewer.textContent = JSON.stringify(contentList, null, 2);
  }
}

// ===== PROGRESS UPDATE =====
function updateProgress(progress) {
  const percent = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
  
  if (el.progressFill) {
    el.progressFill.style.width = `${percent}%`;
  }
  if (el.progressPercent) {
    el.progressPercent.textContent = `${Math.round(percent)}%`;
  }
}

// ===== TIMING DISPLAY =====
function updateTimingsDisplay(sourceTimings = null) {
  const timings = sourceTimings || appState.get('timings');
  if (!timings) return;
  const results = appState.get('results') || {};
  const totalMs = Number(timings.total || results.processingTotalMs || 0);
  
  const timingElements = {
    timingModelInit: timings.model_init,
    timingLayout: timings.layout,
    timingOcr: timings.ocr,
    timingFormula: timings.formula,
    timingTable: timings.table,
    timingPostprocessing: timings.postprocessing,
    timingOther: timings.other,
    timingTotal: totalMs,
  };
  
  Object.entries(timingElements).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = formatDuration(value);
    }
  });
}

function updateRunSummary(runConfig = currentRunConfig) {
  if (!el.runSummary) return;
  const text = formatRunConfigSummary(runConfig);
  el.runSummary.textContent = text;
  el.runSummary.classList.toggle('hidden', !text);
  el.runSummary.title = text ? `Run config: ${text}` : '';
}

function updateModelStatusSummary() {
  if (!el.modelStatusSummary) return;
  const statuses = appState.get('modelStatus') || {};
  const progress = appState.get('modelProgress') || {};
  const warmupStatus = appState.get('warmupStatus') || 'idle';
  const runtimeStatus = appState.get('runtimeStatus') || 'idle';
  const warmupError = appState.get('warmupError');
  const entries = Object.entries(statuses);
  if (!entries.length) {
    const statusText = warmupStatus === 'ready'
      ? 'Ready'
      : warmupStatus === 'runtime_loading'
        ? 'Starting engine...'
        : warmupStatus === 'model_warming'
          ? 'Preparing models...'
          : warmupStatus === 'error'
            ? 'Engine failed to start'
            : runtimeStatus === 'ready'
              ? 'Engine ready'
              : 'Engine not started';
    el.modelStatusSummary.innerHTML = `
      <span class="status-dot ${warmupStatus === 'ready' || runtimeStatus === 'ready' ? 'ready' : warmupStatus === 'error' ? 'error' : isWarmupActive() ? 'loading' : ''}"></span>
      <strong>Engine</strong>
      <span>${statusText}</span>
    `;
    el.modelStatusSummary.title = warmupError || statusText;
    return;
  }
  const downloading = entries.filter(([, value]) => value === 'downloading');
  const cached = entries.filter(([, value]) => value === 'cached');
  const failed = entries.filter(([, value]) => value === 'error');
  const cancelled = entries.filter(([, value]) => value === 'cancelled');
  const active = downloading[0];
  const warming = warmupStatus === 'runtime_loading' || warmupStatus === 'model_warming';
  const percent = active ? Math.round(progress[active[0]] || 0) : null;
  const statusText = failed.length
    ? 'Model download issue'
    : active
      ? `Downloading ${percent}%`
      : cancelled.length && !warming
        ? 'Cancelled'
      : warmupStatus === 'model_warming'
        ? `Preparing ${entries.length - cached.length} remaining model(s)`
        : warmupStatus === 'ready'
          ? 'Ready'
          : `${cached.length} of ${entries.length} models ready`;
  el.modelStatusSummary.innerHTML = `
    <span class="status-dot ${failed.length ? 'error' : (active || warming) ? 'loading' : 'ready'}"></span>
    <strong>Engine</strong>
    <span>${statusText}</span>
  `;
  el.modelStatusSummary.title = warmupError || statusText;
}

function clearLayoutOverlay() {
  renderedPages.forEach(record => {
    if (!record.overlay) return;
    record.overlay.innerHTML = '';
    record.overlay.style.display = 'none';
  });
  clearMergeConnectors();
}

function clearMergeConnectors() {
  const layer = el.pageStack?.querySelector(':scope > .merge-connector-global-layer');
  if (layer) layer.innerHTML = '';
}

function scheduleRenderLayoutOverlay() {
  if (!scheduleRenderLayoutOverlay._coalescer) {
    scheduleRenderLayoutOverlay._coalescer = createRafCoalescer(renderLayoutOverlay);
  }
  scheduleRenderLayoutOverlay._coalescer.schedule();
  // Keep overlayRenderFrame in sync for legacy cancel paths
  overlayRenderFrame = 1; // truthy sentinel
}

function renderLayoutOverlay() {
  if (!renderedPages.length) return;
  const results = appState.get('results');
  if (!overlayVisible) {
    clearLayoutOverlay();
    return;
  }
  if (!linkedBlocks.length) prepareLinkedBlocks(results);
  const overlayBlocks = linkedBlocks.length
    ? linkedBlocks
    : buildRawOverlayBlocks(results);

  renderedPages.forEach(record => {
    record.overlay.innerHTML = '';
    record.overlay.style.display = 'none';
  });

  if (!overlayBlocks.length) {
    clearLayoutOverlay();
    return;
  }

  const grouped = new Map();
  overlayBlocks.forEach(block => {
    const pageIndex = Number(block.pageIndex) || 0;
    if (!grouped.has(pageIndex)) grouped.set(pageIndex, []);
    grouped.get(pageIndex).push(block);
  });

  renderedPages.forEach(record => {
    const pageBlocks = grouped.get(record.pageIndex) || [];
    if (!pageBlocks.length) return;
    const displaySize = getDisplayedCanvasSize(record);
    record.overlay.style.display = 'block';
    record.overlay.style.width = `${displaySize.width}px`;
    record.overlay.style.height = `${displaySize.height}px`;

    pageBlocks.forEach((block) => {
      const rect = block.bbox || normalizeBox(block.item || block);
      if (!rect) return;
      const category = block.category || classifyOverlayCategory({
        type: block.type,
        label: block.label,
        originalLabel: block.originalLabel,
      });
      const sourceSize = block.sourceSize
        || getOverlaySourceSize(results, record.pageIndex, [block.item || block])
        || record.sourceSize
        || { width: record.canvas.width, height: record.canvas.height };
      const sx = displaySize.width / Math.max(1, sourceSize.width);
      const sy = displaySize.height / Math.max(1, sourceSize.height);
      const item = document.createElement('div');
      item.className = 'layout-box';
      item.classList.add(`layout-box--${category}`);
      item.style.left = `${rect.x0 * sx}px`;
      item.style.top = `${rect.y0 * sy}px`;
      item.style.width = `${Math.max(1, (rect.x1 - rect.x0) * sx)}px`;
      item.style.height = `${Math.max(1, (rect.y1 - rect.y0) * sy)}px`;
      const label = block.originalLabel || block.label || block.blockType || block.type || 'unknown';
      item.dataset.label = label;
      item.dataset.category = category;
      if (block.mergeGroupId) {
        item.dataset.linkGroupId = block.mergeGroupId;
        item.classList.add('is-merged');
      }
      if (block.originalLabel) {
        item.dataset.originalLabel = block.originalLabel;
      }
      if (rect.y0 * sy < 24) item.classList.add('is-near-top');
      if (displaySize.width - rect.x1 * sx < 180) item.classList.add('is-near-right');
      item.dataset.linkId = block.id;
      item.dataset.pageIndex = String(record.pageIndex);
      record.overlay.appendChild(item);
    });
  });

  syncOverlayToCanvas();
  scheduleRenderMergeConnectors();
}

function syncOverlayToCanvas() {
  renderedPages.forEach(record => {
    const displaySize = getDisplayedCanvasSize(record);
    record.pageEl.style.width = `${displaySize.width}px`;
    record.pageEl.style.height = `${displaySize.height}px`;
    record.overlay.style.width = `${displaySize.width}px`;
    record.overlay.style.height = `${displaySize.height}px`;
  });
  syncGlobalMergeConnectorLayer();
}

// Thin wrappers below preserve call-site compatibility.

function renderMergeConnectors() {
  return _renderMergeConnectors();
}

function scheduleRenderMergeConnectors() {
  _scheduleRenderMergeConnectors();
  mergeConnectorFrame = 1; // truthy sentinel
}

function getGlobalMergeConnectorLayer() {
  if (!el.pageStack) return null;
  let layer = el.pageStack.querySelector(':scope > .merge-connector-global-layer');
  if (layer) return layer;
  layer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  layer.classList.add('merge-connector-global-layer');
  el.pageStack.prepend(layer);
  return layer;
}

function syncGlobalMergeConnectorLayer(layer = null) {
  // Delegate to the imported helper from connectors.js
  const connectorLayer = layer || el.pageStack?.querySelector(':scope > .merge-connector-global-layer');
  if (!connectorLayer || !el.pageStack) return;
  const width = Math.max(el.pageStack.scrollWidth, el.pageStack.offsetWidth, 1);
  const height = Math.max(el.pageStack.scrollHeight, el.pageStack.offsetHeight, 1);
  connectorLayer.setAttribute('width', String(width));
  connectorLayer.setAttribute('height', String(height));
  connectorLayer.setAttribute('viewBox', `0 0 ${width} ${height}`);
}

function getDisplayedCanvasSize(record) {
  const width = Math.max(1, Math.round((record?.canvas?.width || 1) * currentZoom));
  const height = Math.max(1, Math.round((record?.canvas?.height || 1) * currentZoom));
  return { width, height };
}

function buildRawOverlayBlocks(results) {
  if (!results) return [];
  const blocks = [];
  const pageCount = Math.max(totalPages, results.page_count || 1);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageBoxes = getLayoutBoxesForPage(results, pageIndex);
    const sourceSize = getOverlaySourceSize(results, pageIndex, pageBoxes);
    pageBoxes.forEach((box, index) => {
      const rect = normalizeBox(box);
      if (!rect) return;
      const type = String(box?.type || box?.original_label || 'layout');
      const originalLabel = box?.original_label ?? null;
      const label = getOverlayLabel({ originalLabel, type });
      const text = extractBlockText(box);
      blocks.push({
        id: makeStableLinkId('raw', pageIndex, index, rect, type, text),
        pageIndex,
        bbox: rect,
        sourceSize,
        label: box.label || label,
        type,
        originalLabel,
        category: classifyOverlayCategory({ type, label, originalLabel }),
        text,
        item: box,
      });
    });
  }
  return blocks;
}

function getLayoutBoxesForPage(results, pageIndex) {
  if (!results) return [];
  const page = results.middle_json?.pdf_info?.[pageIndex];
  if (Array.isArray(page?.preproc_blocks)) return page.preproc_blocks;
  const modelPage = Array.isArray(results.model_output) ? results.model_output[pageIndex] : null;
  if (Array.isArray(modelPage?.layout_dets)) return modelPage.layout_dets;
  if (Array.isArray(results.layout_bboxes?.[pageIndex])) return results.layout_bboxes[pageIndex];
  if (pageIndex === 0 && Array.isArray(results.layout_dets)) return results.layout_dets;
  return [];
}

function getOverlaySourceSize(results, pageIndex, boxes) {
  const middlePage = results?.middle_json?.pdf_info?.[pageIndex];
  const middleSize = getMiddlePageSize(middlePage);
  if (middleSize) return middleSize;
  const pageInfo = results?.model_output?.[pageIndex]?.page_info || results?.page_info;
  const width = pageInfo?.width || pageInfo?.w || pageInfo?.img_width || pageInfo?.page_width;
  const height = pageInfo?.height || pageInfo?.h || pageInfo?.img_height || pageInfo?.page_height;
  if (width && height) return { width, height };
  let maxX = 0;
  let maxY = 0;
  boxes.forEach((box) => {
    const rect = normalizeBox(box);
    if (!rect) return;
    maxX = Math.max(maxX, rect.x1);
    maxY = Math.max(maxY, rect.y1);
  });
  return maxX > 0 && maxY > 0 ? { width: maxX, height: maxY } : null;
}

function normalizeBox(box) {
  const raw = box?.bbox || box?.box || box?.layout_bbox || box?.coordinate || box;
  if (Array.isArray(raw) && raw.length >= 4 && raw.every(Number.isFinite)) {
    return normalizeBoxArray(raw);
  }
  const poly = box?.poly || box?.polygon || box?.polygon_points || box?.points;
  if (Array.isArray(poly) && poly.length >= 4) {
    const points = Array.isArray(poly[0]) ? poly : chunkPairs(poly);
    const xs = points.map(p => Number(p[0])).filter(Number.isFinite);
    const ys = points.map(p => Number(p[1])).filter(Number.isFinite);
    if (xs.length && ys.length) {
      return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    }
  }
  if (raw && typeof raw === 'object') {
    const x0 = Number(raw.x0 ?? raw.left ?? raw.x);
    const y0 = Number(raw.y0 ?? raw.top ?? raw.y);
    const x1 = Number(raw.x1 ?? raw.right ?? (Number.isFinite(x0) ? x0 + Number(raw.width ?? raw.w) : NaN));
    const y1 = Number(raw.y1 ?? raw.bottom ?? (Number.isFinite(y0) ? y0 + Number(raw.height ?? raw.h) : NaN));
    if ([x0, y0, x1, y1].every(Number.isFinite)) return normalizeBoxArray([x0, y0, x1, y1]);
  }
  return null;
}

function normalizeBoxArray(values) {
  const [a, b, c, d] = values.map(Number);
  return { x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) };
}

function chunkPairs(values) {
  const out = [];
  for (let i = 0; i < values.length - 1; i += 2) out.push([values[i], values[i + 1]]);
  return out;
}

function handlePreviewLinkHover(event) {
  const box = event.target.closest?.('.layout-box');
  if (!box?.dataset.linkId) return;
  setLinkedHighlight(box.dataset.linkId, box.dataset.linkGroupId);
}

function handlePreviewLinkLeave(event) {
  if (!event.target.closest?.('.layout-box')) return;
  if (pinnedLinkId != null) return;
  const fromBox = event.target.closest('.layout-box');
  const toBox = event.relatedTarget?.closest?.('.layout-box');
  if (toBox && toBox === fromBox) return;
  clearLinkedHighlight();
}

function handlePreviewLinkClick(event) {
  const box = event.target.closest?.('.layout-box');
  if (!box?.dataset.linkId || event.button !== 0) return;
  event.preventDefault();
  pinLinkedBlock(box.dataset.linkId, { source: 'preview' });
}

function handleMarkdownLinkHover(event) {
  if (event.target.closest?.('.block-action-bar')) return;
  const shell = event.target.closest?.('.block-shell[data-link-id]');
  if (!shell?.dataset.linkId) return;
  setLinkedHighlight(shell.dataset.linkId, shell.dataset.linkGroupId);
}

function handleMarkdownLinkLeave(event) {
  if (!event.target.closest?.('.block-shell[data-link-id]')) return;
  if (pinnedLinkId != null) return;
  const sourceShell = event.target.closest('.block-shell[data-link-id]');
  const relatedShell = event.relatedTarget?.closest?.('.block-shell[data-link-id]');
  if (relatedShell && relatedShell === sourceShell) return;
  if (event.relatedTarget === null && el.markdownContent?.contains(event.target)) return;
  clearLinkedHighlight();
}

function handleMarkdownLinkClick(event) {
  if (event.target.closest?.('.block-action-bar')) return;
  const shell = event.target.closest?.('.block-shell[data-link-id]');
  if (!shell?.dataset.linkId || event.button !== 0) return;
  pinLinkedBlock(shell.dataset.linkId, { source: 'output' });
}

function pinLinkedBlock(linkId, { source = 'preview' } = {}) {
  if (pinReleaseListener) {
    document.removeEventListener('click', pinReleaseListener, true);
    pinReleaseListener = null;
  }
  pinnedLinkId = linkId;

  const groupId = getLinkGroupId(linkId);
  pinnedGroupId = groupId || '';
  activeLinkId = null;
  activeGroupId = '';
  setLinkedHighlight(linkId, groupId);

  // Attach a one-shot capture-phase click listener that releases the pin
  // when the user clicks outside the pinned element (or any merged sibling)
  const releaseFn = function onPinRelease(e) {
    const escapedId = cssEscape(linkId);
    const groupSelector = groupId ? `, [data-link-group-id="${cssEscape(groupId)}"]` : '';
    const pinnedNodes = document.querySelectorAll(`[data-link-id="${escapedId}"]${groupSelector}`);
    let clickedInsidePinned = false;
    for (const node of pinnedNodes) {
      if (node.contains(e.target)) { clickedInsidePinned = true; break; }
    }
    if (!clickedInsidePinned) {
      pinnedLinkId = null;
      pinnedGroupId = '';
      document.removeEventListener('click', releaseFn, true);
      if (pinReleaseListener === releaseFn) pinReleaseListener = null;
      clearLinkedHighlight();
    }
  };
  pinReleaseListener = releaseFn;
  document.addEventListener('click', releaseFn, true);

  if (source === 'preview') {
    const pos = getPreviewLinkPosition(linkId);
    if (pos) {
      currentPage = pos.pageIndex + 1;
      updatePageInfo();
      if (!scrollOutputToLink(linkId)) {
        scrollOutputToNearestPageLink(pos.pageIndex, linkId) || scrollOutputToPagePosition(pos.pageIndex, pos.ratio);
      }
    }
  } else if (source === 'output') {
    const pos = getOutputLinkPosition(linkId);
    if (pos) {
      currentPage = pos.pageIndex + 1;
      updatePageInfo();
      if (!scrollPreviewToLink(linkId)) {
        scrollPreviewToPagePosition(pos.pageIndex, pos.ratio);
      }
    }
  }
}

function scrollOutputToNearestPageLink(pageIndex, sourceLinkId) {
  if (!el.markdownContent) return false;
  const sourceOrder = linkedBlocks.find(block => block.id === sourceLinkId)?.order ?? 0;
  const shells = Array.from(el.markdownContent.querySelectorAll(`.block-shell[data-page-index="${pageIndex}"][data-link-order]`));
  if (!shells.length) return false;
  let best = null;
  let bestDistance = Infinity;
  shells.forEach((shell) => {
    const order = Number(shell.dataset.linkOrder);
    if (!Number.isFinite(order)) return;
    const distance = Math.abs(order - sourceOrder);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = shell;
    }
  });
  if (!best) return false;
  isSyncingScroll = true;
  el.markdownContent.scrollTop = Math.max(0, best.offsetTop - 72);
  requestAnimationFrame(() => { isSyncingScroll = false; });
  return true;
}

function getLinkGroupId(linkId) {
  return document.querySelector(`[data-link-id="${cssEscape(linkId)}"][data-link-group-id]`)?.dataset.linkGroupId
    || linkedBlocks.find(block => block.id === linkId)?.mergeGroupId
    || '';
}

function setLinkedHighlight(linkId, groupId = '') {
  const normalizedGroup = groupId || '';
  if (linkId === activeLinkId && normalizedGroup === activeGroupId) return;
  activeLinkId = linkId;
  activeGroupId = normalizedGroup;
  linkingCtx.activeLinkId = linkId;
  linkingCtx.activeGroupId = normalizedGroup;
  el.pageStack?.querySelectorAll('.layout-box.is-linked, .merge-connector.is-linked, .merge-connector-node.is-linked, .merge-connector-label.is-linked, .merge-connector-label-bg.is-linked').forEach(node => {
    node.classList.remove('is-linked');
  });
  el.markdownContent?.querySelectorAll('.block-shell.is-linked').forEach(node => {
    node.classList.remove('is-linked');
  });
  el.pageStack?.querySelectorAll(`[data-link-id="${cssEscape(linkId)}"]`).forEach(node => {
    if (node.classList.contains('layout-box')) {
      node.classList.add('is-linked');
    }
  });
  el.markdownContent?.querySelectorAll(`[data-link-id="${cssEscape(linkId)}"]`).forEach(node => {
    if (node.classList.contains('block-shell')) {
      node.classList.add('is-linked');
    }
  });
  if (groupId) {
    el.pageStack?.querySelectorAll(`[data-link-group-id="${cssEscape(groupId)}"]`).forEach(node => {
      if (node.classList.contains('layout-box')
        || node.classList.contains('merge-connector')
        || node.classList.contains('merge-connector-node')
        || node.classList.contains('merge-connector-label')
        || node.classList.contains('merge-connector-label-bg')) {
        node.classList.add('is-linked');
      }
    });
    el.markdownContent?.querySelectorAll(`[data-link-group-id="${cssEscape(groupId)}"]`).forEach(node => {
      if (node.classList.contains('block-shell')) {
        node.classList.add('is-linked');
      }
    });
  }
}

function clearLinkedHighlight() {
  if (pinnedLinkId != null) {
    if (activeLinkId !== pinnedLinkId || activeGroupId !== pinnedGroupId) {
      setLinkedHighlight(pinnedLinkId, pinnedGroupId);
    }
    return;
  }
  activeLinkId = null;
  activeGroupId = '';
  linkingCtx.activeLinkId = null;
  linkingCtx.activeGroupId = '';
  el.pageStack?.querySelectorAll('.layout-box.is-linked, .merge-connector.is-linked, .merge-connector-node.is-linked, .merge-connector-label.is-linked, .merge-connector-label-bg.is-linked').forEach(node => {
    node.classList.remove('is-linked');
  });
  el.markdownContent?.querySelectorAll('.block-shell.is-linked').forEach(node => {
    node.classList.remove('is-linked');
  });
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value));
  return String(value).replace(/"/g, '\\"');
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function getMarkdownPageSection(pageIndex) {
  if (!el.markdownContent) return null;
  const shells = Array.from(el.markdownContent.querySelectorAll(`.block-shell[data-page-index="${pageIndex}"]`));
  if (shells.length) {
    const first = shells[0];
    const last = shells[shells.length - 1];
    const divider = el.markdownContent.querySelector(`.markdown-page-divider[data-page-index="${pageIndex}"]`);
    const top = first.offsetTop;
    const bottom = divider
      ? divider.offsetTop
      : last.offsetTop + last.offsetHeight;
    const height = Math.max(1, bottom - top);
    return { divider, top, bottom, height };
  }

  const selector = `.markdown-page-divider[data-page-index="${pageIndex}"]`;
  const divider = el.markdownContent.querySelector(selector);
  if (!divider) return null;
  const allDividers = Array.from(el.markdownContent.querySelectorAll('.markdown-page-divider'));
  const idx = allDividers.indexOf(divider);
  const next = idx >= 0 ? allDividers[idx + 1] : null;
  const prev = idx > 0 ? allDividers[idx - 1] : null;
  const top = prev ? prev.offsetTop + prev.offsetHeight : 0;
  const bottom = next ? next.offsetTop : divider.offsetTop;
  const height = Math.max(1, bottom - top);
  return { divider, top, bottom, height };
}

function scrollOutputToPage(pageIndex) {
  const section = getMarkdownPageSection(pageIndex);
  if (!section || !el.markdownContent) return;
  isSyncingScroll = true;
  el.markdownContent.scrollTop = Math.max(0, section.top - 12);
  requestAnimationFrame(() => { isSyncingScroll = false; });
}

function scrollOutputToPagePosition(pageIndex, ratio = 0.5) {
  const section = getMarkdownPageSection(pageIndex);
  if (!section || !el.markdownContent) return;
  const target = section.top + section.height * clamp01(ratio);
  isSyncingScroll = true;
  el.markdownContent.scrollTop = Math.max(0, target - el.markdownContent.clientHeight * 0.5);
  requestAnimationFrame(() => { isSyncingScroll = false; });
}

function scrollPreviewToPagePosition(pageIndex, ratio = 0.5) {
  const page = getPageRecord(pageIndex);
  const scroller = getPreviewScrollEl();
  if (!page || !scroller) return;
  const target = page.pageEl.offsetTop + page.pageEl.offsetHeight * clamp01(ratio);
  isSyncingScroll = true;
  scroller.scrollTop = Math.max(0, target - scroller.clientHeight * 0.5);
  requestAnimationFrame(() => { isSyncingScroll = false; });
}

function getPreviewLinkPosition(linkId) {
  const groupId = getLinkGroupId(linkId);
  const box = el.pageStack?.querySelector(`.layout-box[data-link-id="${cssEscape(linkId)}"]`)
    || (groupId ? el.pageStack?.querySelector(`.layout-box[data-link-group-id="${cssEscape(groupId)}"]`) : null);
  if (!box) return null;
  const pageIndex = Number(box.dataset.pageIndex ?? 0);
  const page = getPageRecord(pageIndex);
  if (!page) return null;
  const boxRect = box.getBoundingClientRect();
  const pageRect = page.pageEl.getBoundingClientRect();
  const ratio = (boxRect.top - pageRect.top + boxRect.height * 0.5) / Math.max(1, pageRect.height);
  return { pageIndex, ratio: clamp01(ratio) };
}

function getOutputLinkPosition(linkId) {
  const shell = el.markdownContent?.querySelector(`.block-shell[data-link-id="${cssEscape(linkId)}"]`);
  if (!shell) return null;
  const pageIndex = Number(shell.dataset.pageIndex ?? 0);
  const section = getMarkdownPageSection(pageIndex);
  if (!section) return { pageIndex, ratio: 0.5 };
  const centerY = shell.offsetTop + shell.offsetHeight * 0.5;
  const ratio = (centerY - section.top) / Math.max(1, section.height);
  return { pageIndex, ratio: clamp01(ratio) };
}

function scrollPreviewToLink(linkId) {
  const groupId = getLinkGroupId(linkId);
  const box = el.pageStack?.querySelector(`.layout-box[data-link-id="${cssEscape(linkId)}"]`)
    || (groupId ? el.pageStack?.querySelector(`.layout-box[data-link-group-id="${cssEscape(groupId)}"]`) : null);
  const scroller = getPreviewScrollEl();
  if (!box || !scroller) return false;
  isSyncingScroll = true;
  const paneRect = scroller.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  scroller.scrollTop += boxRect.top - paneRect.top - Math.max(80, paneRect.height * 0.18);
  requestAnimationFrame(() => { isSyncingScroll = false; });
  return true;
}

function scrollOutputToLink(linkId) {
  const groupId = getLinkGroupId(linkId);
  const shell = el.markdownContent?.querySelector(`.block-shell[data-link-id="${cssEscape(linkId)}"]`)
    || (groupId ? el.markdownContent?.querySelector(`.block-shell[data-link-group-id="${cssEscape(groupId)}"]`) : null);
  if (!shell || !el.markdownContent) return false;
  isSyncingScroll = true;
  el.markdownContent.scrollTop = Math.max(0, shell.offsetTop - 72);
  requestAnimationFrame(() => { isSyncingScroll = false; });
  return true;
}

function scrollPreviewToPage(pageIndex) {
  const page = getPageRecord(pageIndex);
  const scroller = getPreviewScrollEl();
  if (!page || !scroller) return;
  isSyncingScroll = true;
  const paneRect = scroller.getBoundingClientRect();
  const pageRect = page.pageEl.getBoundingClientRect();
  scroller.scrollTop += pageRect.top - paneRect.top - 24;
  requestAnimationFrame(() => { isSyncingScroll = false; });
}

function handlePreviewScroll() {
  if (isSyncingScroll) return;
  queueScrollSync('preview');
}

function handleMarkdownScroll() {
  if (isSyncingScroll) return;
  queueScrollSync('output');
}

function queueScrollSync(source) {
  if (scrollSyncFrame) cancelAnimationFrame(scrollSyncFrame);
  scrollSyncFrame = requestAnimationFrame(() => {
    scrollSyncFrame = null;
    if (source === 'preview') syncOutputFromPreviewScroll();
    else syncPreviewFromMarkdownScroll();
  });
}

function syncOutputFromPreviewScroll() {
  const scroller = getPreviewScrollEl();
  const linkId = getClosestVisibleLinkId(scroller, '.layout-box[data-link-id]');
  if (linkId) {
    const pos = getPreviewLinkPosition(linkId);
    if (pos && pos.pageIndex + 1 !== currentPage) {
      currentPage = pos.pageIndex + 1;
      updatePageInfo();
    }
    syncedLinkId = linkId;
    syncedPageIndex = pos?.pageIndex ?? null;
    return;
  }

  const pageIndex = getClosestVisiblePageIndex();
  if (pageIndex === null) return;
  if (pageIndex !== null && pageIndex + 1 !== currentPage) {
    currentPage = pageIndex + 1;
    updatePageInfo();
  }
  syncedPageIndex = pageIndex;
  syncedLinkId = null;
}

function syncPreviewFromMarkdownScroll() {
  const linkId = getClosestVisibleLinkId(el.markdownContent, '.block-shell[data-link-id]');
  if (linkId) {
    const pos = getOutputLinkPosition(linkId);
    if (pos && pos.pageIndex + 1 !== currentPage) {
      currentPage = pos.pageIndex + 1;
      updatePageInfo();
    }
    syncedLinkId = linkId;
    syncedPageIndex = pos?.pageIndex ?? null;
    return;
  }

  const pageIndex = getClosestVisibleMarkdownPageIndex();
  if (pageIndex === null) return;
  if (pageIndex + 1 !== currentPage) {
    currentPage = pageIndex + 1;
    updatePageInfo();
  }
  syncedPageIndex = pageIndex;
  syncedLinkId = null;
}

function getClosestVisiblePageIndex() {
  const scroller = getPreviewScrollEl();
  if (!scroller || !renderedPages.length) return null;
  const paneRect = scroller.getBoundingClientRect();
  const targetY = paneRect.top + paneRect.height * 0.35;
  let best = null;
  let bestDistance = Infinity;
  renderedPages.forEach(record => {
    const rect = record.pageEl.getBoundingClientRect();
    const distance = Math.abs(rect.top - targetY);
    if (rect.bottom >= paneRect.top && rect.top <= paneRect.bottom && distance < bestDistance) {
      bestDistance = distance;
      best = record.pageIndex;
    }
  });
  return best;
}

function getClosestVisibleLinkId(container, selector) {
  if (!container) return null;
  const containerRect = container.getBoundingClientRect();
  const targetY = containerRect.top + containerRect.height * 0.35;
  let best = null;
  let bestDistance = Infinity;
  container.querySelectorAll(selector).forEach(node => {
    const linkId = node.dataset.linkId;
    if (!linkId) return;
    const rect = node.getBoundingClientRect();
    if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) return;
    const distance = Math.abs(rect.top - targetY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = linkId;
    }
  });
  return best;
}

function getClosestVisibleMarkdownPageIndex() {
  if (!el.markdownContent) return null;
  const containerRect = el.markdownContent.getBoundingClientRect();
  const targetY = containerRect.top + containerRect.height * 0.35;
  let best = null;
  let bestDistance = Infinity;
  el.markdownContent.querySelectorAll('.block-shell[data-page-index]').forEach(node => {
    const pageIndex = Number(node.dataset.pageIndex);
    if (!Number.isFinite(pageIndex)) return;
    const rect = node.getBoundingClientRect();
    if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) return;
    const distance = Math.abs(rect.top - targetY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = pageIndex;
    }
  });
  return best;
}

// ===== ZOOM & NAVIGATION =====
function setZoom(zoom, { preserveViewport = true } = {}) {
  const scroller = getPreviewScrollEl();
  const before = preserveViewport && scroller
    ? {
        x: (scroller.scrollLeft + scroller.clientWidth / 2) / Math.max(1, scroller.scrollWidth),
        y: (scroller.scrollTop + scroller.clientHeight / 2) / Math.max(1, scroller.scrollHeight),
      }
    : null;
  currentZoom = Math.max(0.1, Math.min(3.0, zoom));
  updateZoomDisplay();
  applyZoom();
  if (before && scroller) {
    requestAnimationFrame(() => {
      scroller.scrollLeft = Math.max(0, before.x * scroller.scrollWidth - scroller.clientWidth / 2);
      scroller.scrollTop = Math.max(0, before.y * scroller.scrollHeight - scroller.clientHeight / 2);
    });
  }
  saveUiPrefs({ zoom: currentZoom });
}

function updateZoomDisplay() {
  if (el.zoomLevel) {
    el.zoomLevel.textContent = `${Math.round(currentZoom * 100)}%`;
  }
}

function applyZoom() {
  renderedPages.forEach(record => {
    const displaySize = getDisplayedCanvasSize(record);
    record.canvas.style.width = `${displaySize.width}px`;
    record.canvas.style.height = `${displaySize.height}px`;
    record.canvas.style.transform = '';
    record.pageEl.style.width = `${displaySize.width}px`;
    record.pageEl.style.height = `${displaySize.height}px`;
  });
  scheduleRenderLayoutOverlay();
}

function fitToWidth() {
  const firstPage = renderedPages[0];
  const scroller = getPreviewScrollEl();
  if (!firstPage || !scroller) return;
  const containerWidth = scroller.clientWidth - 40;
  const canvasWidth = firstPage.canvas.width;
  if (canvasWidth > 0) {
    currentZoom = containerWidth / canvasWidth;
    updateZoomDisplay();
    applyZoom();
    saveUiPrefs({ zoom: currentZoom, zoomMode: 'fit-width' });
  }
}

function fitSetupPreviewInitial() {
  const firstPage = renderedPages[0];
  const scroller = getPreviewScrollEl();
  if (!firstPage || !scroller) return;
  const canvasWidth = firstPage.canvas.width;
  const canvasHeight = firstPage.canvas.height;
  if (!(canvasWidth > 0 && canvasHeight > 0)) return;

  const availableWidth = Math.max(240, scroller.clientWidth - 56);
  const availableHeight = Math.max(240, scroller.clientHeight - 48);
  const widthFit = availableWidth / canvasWidth;
  const heightFit = availableHeight / canvasHeight;
  currentZoom = Math.max(0.15, Math.min(widthFit, heightFit, 0.9));
  updateZoomDisplay();
  applyZoom();
}

function setPage(page) {
  const newPage = Math.max(1, Math.min(totalPages, page));
  if (newPage === currentPage) return;
  
  currentPage = newPage;
  
  if (currentFileType === 'pdf' && pdfDocument) {
    scrollPreviewToPage(currentPage - 1);
  } else {
    scrollPreviewToPage(currentPage - 1);
  }
  
  updatePageInfo();
}

function updatePageInfo() {
  if (el.pageInfo) {
    el.pageInfo.textContent = `${currentPage} / ${totalPages}`;
  }
  if (el.setupPreviewPageInfo) {
    el.setupPreviewPageInfo.textContent = `${currentPage} / ${totalPages}`;
  }
}

// ===== RESIZE HANDLE =====
function startResize(e) {
  isDraggingResize = true;
  resizeStartX = e.clientX;
  resizeStartWidth = el.markdownPane?.offsetWidth || 400;
  e.preventDefault();
}

function handleResize(e) {
  if (!isDraggingResize) return;
  
  const delta = resizeStartX - e.clientX;
  const newWidth = Math.max(300, Math.min(800, resizeStartWidth + delta));
  
  if (el.markdownPane) {
    el.markdownPane.style.width = `${newWidth}px`;
    updateToolbarSplitWidth(newWidth);
    scheduleRenderMergeConnectors();
    saveUiPrefs({ splitWidth: newWidth });
  }
}

function updateToolbarSplitWidth(width = null) {
  const nextWidth = Number(width || el.markdownPane?.offsetWidth || 600);
  if (Number.isFinite(nextWidth)) {
    document.documentElement.style.setProperty('--workspace-output-width', `${Math.max(300, Math.min(900, nextWidth))}px`);
  }
}

function stopResize() {
  isDraggingResize = false;
}

function handleGlobalShortcuts(event) {
  const target = event.target;
  const isTyping = target?.matches?.('input, textarea, select, [contenteditable="true"]');
  if (isTyping) return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && (event.key === '=' || event.key === '+')) {
    event.preventDefault();
    setZoom(currentZoom + 0.1);
  } else if (mod && event.key === '-') {
    event.preventDefault();
    setZoom(currentZoom - 0.1);
  } else if (mod && event.key.toLowerCase() === '0') {
    event.preventDefault();
    fitToWidth();
  } else if (event.key.toLowerCase() === 'o') {
    event.preventDefault();
    toggleOverlayVisible();
  } else if (mod && event.key.toLowerCase() === 'c' && window.getSelection?.().isCollapsed !== false) {
    event.preventDefault();
    copyMarkdown();
  } else if (mod && event.key === 'Enter') {
    event.preventDefault();
    if (!el.startBtn?.disabled) runPipeline();
  }
}

// ===== MARKDOWN ACTIONS =====
function copyMarkdown() {
  if (!el.markdownContent) {
    showLoading('No output to copy');
    return;
  }

  const clone = el.markdownContent.cloneNode(true);
  clone.querySelectorAll('.block-action-bar').forEach(node => node.remove());
  clone.querySelectorAll('.markdown-page-divider').forEach(node => node.remove());
  const html = clone.innerHTML || '';
  const text = clone.innerText || clone.textContent || '';

  if (navigator.clipboard?.write && window.ClipboardItem) {
    const item = new ClipboardItem({
      'text/plain': new Blob([text], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' }),
    });
    navigator.clipboard.write([item]).then(() => {
      showLoading('Output copied');
    }).catch(() => {
      navigator.clipboard.writeText(text).then(() => {
        showLoading('Output copied');
      }).catch(() => {
        showLoading('Failed to copy output');
      });
    });
  } else {
    navigator.clipboard.writeText(text).then(() => {
      showLoading('Output copied');
    }).catch(() => {
      showLoading('Failed to copy output');
    });
  }
}

// ===== DOWNLOAD =====
async function downloadResults() {
  const results = appState.get('results');
  if (!results) {
    showLoading('No results to download');
    return;
  }
  
  // Use exportUtils for full ZIP bundle
  try {
    const exportUtils = await getExportUtils();
    await exportUtils.exportZipBundle(appState);
    showLoading('Downloaded ZIP bundle');
  } catch (err) {
    console.error(`${UI_LOG_PREFIX} Download failed:`, err);
    showLoading('Download failed');
  }
}

function cancelProcessing() {
  if (isWarmupActive() && !appState.get('isProcessing')) {
    cancelPendingWarmup({ resetStatus: true });
    hideProgress();
    setWorkspaceMode('setup');
    showLoading('Runtime preparation cancelled');
    return;
  }
  appState.cancelProcessing();
  hideProgress();
  updateUI();
  showLoading('Cancelled');
}

function toggleExportMenu(event) {
  event?.stopPropagation();
  if (!appState.get('results')) {
    showLoading('No results to download');
    return;
  }
  if (el.exportOptions?.classList.contains('hidden')) openExportMenu();
  else closeExportMenu();
}

function openExportMenu() {
  if (!appState.get('results')) return;
  cancelExportMenuClose();
  el.exportOptions?.classList.remove('hidden');
  el.downloadBtn?.setAttribute('aria-expanded', 'true');
}

function closeExportMenu() {
  cancelExportMenuClose();
  el.exportOptions?.classList.add('hidden');
  el.downloadBtn?.setAttribute('aria-expanded', 'false');
}

function scheduleExportMenuClose() {
  cancelExportMenuClose();
  exportCloseTimer = setTimeout(closeExportMenu, 240);
}

function cancelExportMenuClose() {
  if (exportCloseTimer) {
    clearTimeout(exportCloseTimer);
    exportCloseTimer = null;
  }
}

async function handleExportOption(event) {
  const button = event.target.closest('[data-export]');
  if (!button) return;
  closeExportMenu();
  const kind = button.dataset.export;
  const results = appState.get('results');
  if (!results) {
    showLoading('No results to download');
    return;
  }
  const stem = getExportStem(results);

  try {
    const exportUtils = await getExportUtils();
    if (kind === 'zip') {
      await exportUtils.exportZipBundle(appState);
    } else if (kind === 'benchmark') {
      exportUtils.exportBenchmarkCsv(appState, `${stem}_benchmark.csv`);
    } else if (kind === 'benchmark-json') {
      // Export unified timing JSON + content_list JSON for benchmark/evaluate.py
      exportUtils.exportBenchmarkJson(appState, `${stem}_timing.json`);
      exportUtils.exportContentListJson(appState, `${stem}_content_list.json`);
    } else if (kind === 'markdown') {
      exportUtils._download(results.markdown || '', `${stem}.md`, 'text/markdown');
    } else if (kind === 'content') {
      const contentList = getResultArtifact(results, 'content_list', 'contentList', 'content_list_json');
      exportUtils._download(JSON.stringify(contentList ?? null, null, 2), `${stem}_content_list.json`, 'application/json');
    } else if (kind === 'middle') {
      const middleJson = getResultArtifact(results, 'middle_json', 'middleJson', 'layout_info');
      if (middleJson == null) {
        showLoading('Middle JSON is not available for this run');
        return;
      }
      exportUtils._download(JSON.stringify(middleJson, null, 2), `${stem}_middle.json`, 'application/json');
    } else if (kind === 'model') {
      const modelJson = getResultArtifact(results, 'model_output', 'modelOutput', 'modelJson');
      if (modelJson == null) {
        showLoading('Model JSON is not available for this run');
        return;
      }
      exportUtils._download(JSON.stringify(modelJson, null, 2), `${stem}_model.json`, 'application/json');
    }
    showLoading('Download started');
  } catch (err) {
    console.error(`${UI_LOG_PREFIX} Export failed:`, err);
    showLoading('Export failed');
  }
}

function getExportStem(results = appState.get('results')) {
  const rawName = currentFile?.name || results?.fileName || el.currentFileName?.textContent || 'output';
  return String(rawName || 'output').replace(/\.[^.]+$/, '') || 'output';
}

// ===== CLEAR =====
async function resetWorkspaceForNewTask() {
  cancelPendingWarmup({ resetStatus: true });
  selectedFiles = [];
  currentFileIndex = 0;
  currentFile = null;
  await cleanupPdfPreview();
  releaseCanvas(sourceCanvas);
  sourceCanvas = null;
  revokeThumbnailObjectUrls();
  
  renderFileList();
  appState.patch({
    currentFile: null,
    files: [],
    currentFileIndex: 0,
    results: null,
    progress: { current: 0, total: 0 },
    timings: emptyTimingSet(),
  });
  linkedBlocks = [];
  activeLinkId = null;
  activeGroupId = '';
  if (pinReleaseListener) {
    document.removeEventListener('click', pinReleaseListener, true);
    pinReleaseListener = null;
  }
  pinnedLinkId = null;
  pinnedGroupId = '';
  syncedPageIndex = null;
  syncedLinkId = null;
  showEmptyViewer();
  refreshAssetRequirements({ allowWarmup: false });
  updateUI();
  
  // Clear markdown
  if (el.markdownContent) {
    el.markdownContent.innerHTML = '<div class="empty-markdown"><p>Run extraction to view Markdown and JSON.</p></div>';
  }
  if (el.contentJsonViewer) {
    el.contentJsonViewer.textContent = '';
  }
  updateRunSummary(null);
  updateTimingsDisplay(emptyTimingSet());
  updateSetupUploadState();
}

async function clearAll() {
  await resetWorkspaceForNewTask();
  setWorkspaceMode('setup');
  setSetupTab('upload');
  updateSetupUploadState();
  showLoading('Cleared all files');
}

// ===== UI UPDATE =====
function updateSetupUploadState() {
  const hasFiles = selectedFiles.length > 0;
  const isProcessing = appState.get('isProcessing');

  el.setupWorkspace?.classList.toggle('is-empty', !hasFiles);
  el.setupWorkspace?.classList.toggle('is-ready', hasFiles);
  el.setupWorkspace?.classList.toggle('is-processing', Boolean(isProcessing));

  if (el.dropzoneTitle) {
    el.dropzoneTitle.textContent = hasFiles
      ? 'Files ready'
      : 'Drop files here';
  }
  if (el.dropzoneHint) {
    el.dropzoneHint.textContent = hasFiles && currentFile
      ? 'Select a tile to preview'
      : 'PDF and common image formats';
  }
  renderSetupFileCards();
  updateSetupTabs();
}

function updateUI() {
  const hasFiles = selectedFiles.length > 0;
  const hasResults = appState.get('results') !== null;
  const isProcessing = appState.get('isProcessing');
  
  if (el.startBtn) {
    const canRun = canRunExtraction();
    el.startBtn.disabled = !canRun;
    el.startBtn.title = canRun ? '' : hasFiles && appState.get('warmupStatus') !== 'ready'
      ? 'Models are still preparing, please wait...'
      : '';
  }
  if (el.uploadBtn) el.uploadBtn.disabled = Boolean(isProcessing);
  if (el.downloadBtn) el.downloadBtn.disabled = !hasResults;
  
  if (hasFiles && currentFile) {
    if (el.currentFileName) {
      el.currentFileName.textContent = currentFile.name;
      el.currentFileName.title = currentFile.name || '';
    }
    if (el.currentFileMeta) el.currentFileMeta.textContent = `${currentFileIndex + 1} / ${selectedFiles.length}`;
  } else if (!hasResults) {
    if (el.currentFileName) {
      el.currentFileName.textContent = '';
      el.currentFileName.title = '';
    }
    if (el.currentFileMeta) el.currentFileMeta.textContent = '';
  }
  if (workspaceMode === 'setup' && (isProcessing || hasResults)) {
    setWorkspaceMode('workspace');
  } else if (workspaceMode === 'setup') {
    updateSetupUploadState();
  }
}

// ===== STATE SUBSCRIPTION =====
const _stateBag = createSubscriptionBag('app');

function subscribeToState() {
  _stateBag.dispose(); // idempotent re-subscribe
  _stateBag.subscribe(appState, 'isProcessing', (isProcessing) => {
    if (isProcessing) {
      showProgress();
    }
    setProcessingChrome(isProcessing);
    updateUI();
  });
  
  _stateBag.subscribe(appState, 'processingStage', (stage) => {
    const titles = {
      preprocessing: 'Preparing pages',
      layout: 'Analyzing structure',
      ocr: 'Reading text',
      formula: 'Extracting formulas',
      table: 'Extracting tables',
      reading_order: 'Arranging content',
      postprocessing: 'Generating output',
    };
    const messages = {
      preprocessing: 'Loading and preparing each page for processing.',
      layout: 'Identifying document sections like headings, paragraphs, and images.',
      ocr: 'Extracting text from each document section.',
      formula: 'Parsing mathematical formulas and equations.',
      table: 'Detecting and reconstructing table rows and columns.',
      reading_order: 'Organizing extracted content into the correct reading order.',
      postprocessing: 'Creating Markdown and JSON output files.',
    };
    
    if (el.progressTitle) {
      el.progressTitle.textContent = titles[stage] || 'Processing document';
    }
    if (el.progressMessage) {
      el.progressMessage.textContent = messages[stage] || 'Extracting content from the current document.';
    }
  });
  
  _stateBag.subscribe(appState, 'timings', (timings) => {
    currentStageTimings = getStageTimingsFromResults();
    updateTimingsDisplay();
  });

  _stateBag.subscribe(appState, 'modelStatus', updateModelStatusSummary);
  _stateBag.subscribe(appState, 'modelProgress', updateModelStatusSummary);
  _stateBag.subscribe(appState, 'assetStatus', renderAssetGate);
  _stateBag.subscribe(appState, 'assetProgress', updateAssetProgress);
  _stateBag.subscribe(appState, 'runtimeStatus', () => {
    updateWarmupProgressUi();
    renderAssetGate();
    updateUI();
  });
  _stateBag.subscribe(appState, 'warmupStatus', (status) => {
    updateWarmupProgressUi();
    renderAssetGate();
    if (status === 'ready' && el.startBtn) {
      el.startBtn.disabled = false;
    }
    updateUI();
  });
  _stateBag.subscribe(appState, 'startupTimings', () => {
    updateTimingsDisplay();
  });
  
  _stateBag.subscribe(appState, 'progressPercent', (percent) => {
    console.log(`[UI] progressPercent subscriber called: ${percent}`);
    if (typeof percent === 'number' && percent >= 0) {
      updateProgress(percent);
    }
  });
  
  _stateBag.subscribe(appState, 'progressStage', (stage) => {
    if (stage && el.progressMessage) {
      const stageMessages = {
        orientation: 'Detecting document orientation...',
        layout: 'Detecting layout structure...',
        region_collect: 'Collecting content regions...',
        formula: 'Recognizing formulas...',
        ocr_det: 'Detecting text regions...',
        ocr_rec: 'Recognizing text...',
        table: 'Recognizing tables...',
        seal_ocr: 'Processing seals...',
      };
      el.progressMessage.textContent = stageMessages[stage] || 'Processing document...';
    }
  });
  
  _stateBag.subscribe(appState, 'results', (results) => {
    if (results) {
      displayResults(results);
      updateTimingsDisplay();
    }
  });
  
  _stateBag.subscribe(appState, 'error', (error) => {
    if (error) {
      hideProgress();
      showLoading(`Error: ${error}`, 3000);
      updateUI();
    }
  });
}

// ===== LOADING INDICATOR (LOFI) =====
function showRecoverableError(err, { audit_id = '', retryFn = null } = {}) {
  const container = document.getElementById('toastContainer');
  const message = err?.message ?? String(err ?? 'Unknown error');
  const id = audit_id ? ` [${audit_id}]` : '';

  if (container) {
    const t = document.createElement('div');
    t.className = 'pointer-events-auto flex items-start gap-3 bg-[#1c2128] border border-red-400 border-l-4 rounded-xl px-4 py-3 shadow-2xl text-sm';
    t.style.animation = 'slide-in-right 0.25s ease forwards';
    t.setAttribute('role', 'alert');
    t.innerHTML = `
      <span class="text-base mt-0.5">❌</span>
      <span class="flex-1" style="color:#8b949e">${escapeHtml(message)}${escapeHtml(id)}</span>
      ${retryFn ? '<button class="audit-retry-btn" style="color:#60a5fa;cursor:pointer;font-size:11px;white-space:nowrap">Retry</button>' : ''}
      <button style="color:#484f58;cursor:pointer" onclick="this.closest('div').remove()">×</button>
    `;
    if (retryFn) {
      t.querySelector('.audit-retry-btn')?.addEventListener('click', () => {
        t.remove();
        retryFn();
      });
    }
    container.appendChild(t);
    setTimeout(() => t.remove(), 8000);
  } else {
    // Fallback to showLoading if toast container not present
    showLoading(`Error: ${message}`, 4000);
  }

  // Restore startBtn within 500ms per Requirement 5.2
  setTimeout(() => {
    if (el.startBtn && !appState.get('isProcessing')) {
      el.startBtn.disabled = !canRunExtraction();
    }
  }, 500);
}

// Does NOT mutate native `disabled` on inputs — uses aria-disabled + pointer-events.
const _processingInterceptor = (e) => {
  if (appState.get('isProcessing')) {
    e.stopPropagation();
    e.preventDefault();
  }
};
let _processingChromeActive = false;

function setProcessingChrome(isProcessing) {
  const controls = [
    el.startBtn, el.uploadBtn, el.downloadBtn,
    el.overlayToggle, el.zoomIn, el.zoomOut, el.fitWidth,
  ].filter(Boolean);

  if (isProcessing && !_processingChromeActive) {
    _processingChromeActive = true;
    for (const ctrl of controls) {
      ctrl.setAttribute('aria-disabled', 'true');
    }
    document.addEventListener('click', _processingInterceptor, true);
  } else if (!isProcessing && _processingChromeActive) {
    _processingChromeActive = false;
    for (const ctrl of controls) {
      ctrl.removeAttribute('aria-disabled');
    }
    document.removeEventListener('click', _processingInterceptor, true);
  }
}

function updateQuickNavVisibility() {
  const mc = el.markdownContent;
  if (!mc) return;
  const btn = document.getElementById('scrollToTopBtn');
  if (!btn) return;
  const textLength = mc.textContent?.length ?? 0;
  const shouldShow = mc.scrollHeight > 200 || textLength > 10000;
  btn.classList.toggle('hidden', !shouldShow);
}

function showLoading(message, duration = 2000) {
  let indicator = document.getElementById('loadingIndicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'loadingIndicator';
    indicator.className = 'loading-indicator';
    document.body.appendChild(indicator);
  }
  
  indicator.textContent = message;
  indicator.classList.add('show');
  
  setTimeout(() => {
    indicator.classList.remove('show');
  }, duration);
}

function renderFatalUiError(error) {
  const emptyViewer = document.getElementById('emptyViewer');
  const target = emptyViewer || document.body;
  if (!target) return;

  const message = error?.message || 'Unknown startup error';
  const errorBox = document.createElement('div');
  errorBox.className = 'startup-error';

  const title = document.createElement('strong');
  title.textContent = 'UI failed to start';
  const body = document.createElement('p');
  body.textContent = message;
  const hint = document.createElement('small');
  hint.textContent = 'Check the browser console, then reload the page.';

  errorBox.append(title, body, hint);
  if (emptyViewer) {
    emptyViewer.replaceChildren(errorBox);
    emptyViewer.classList.remove('hidden');
  } else {
    target.prepend(errorBox);
  }
}

function handleBootstrapError(error) {
  console.error(`${UI_LOG_PREFIX} Failed to initialize UI:`, error);
  refreshIcons();
  renderFatalUiError(error);
}

// ===== INITIALIZE =====
const startApp = () => {
  init().catch(handleBootstrapError);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}