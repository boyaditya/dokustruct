/**
 * ui/history/reload.js
 *
 * Extracted from ui/app-v2.js. Signature unchanged (Requirement 7.2).
 * Disposer chain wired for deterministic resource cleanup (Requirement 4.7).
 */

import { createDisposerChain } from '../lifecycle/disposerChain.js';
import { readHistoryAsset } from './storage.js';

const UI_LOG_PREFIX = '[DocParsing UI]';

/**
 * @typedef {{
 *   el: object,
 *   appState: { patch: (patch: object) => void, get: (key: string) => any },
 *   thumbnailObjectUrls: Set<string>,
 *   renderedPages: Array<{ canvas: HTMLCanvasElement }>,
 *   overlayResizeObserver: ResizeObserver | null,
 *   setWorkspaceMode: (mode: string) => void,
 *   cleanupPdfPreview: () => Promise<void>,
 *   releaseCanvas: (canvas: HTMLCanvasElement | null) => void,
 *   hasStoredImages: (images: any) => boolean,
 *   getResultArtifact: (source: any, ...keys: string[]) => any,
 *   readHistoryStoredValue: (item: any, keyProp: string, label: string, fallback: any) => Promise<any>,
 *   normalizeHistoryStageTimings: (stageTimings: any, processingTotalMs: number) => object,
 *   emptyTimingSet: () => object,
 *   prepareLinkedBlocks: (results: object) => void,
 *   updatePageInfo: () => void,
 *   displayMarkdown: (md: string, pageCount: number, contentList: any[]) => void,
 *   displayJSON: (data: any, type: string) => void,
 *   renderHistoryPreviewPages: (pages: string[]) => void,
 *   renderHistoryThumbnail: (url: string) => void,
 *   showEmptyViewer: () => void,
 *   formatFileSize: (bytes: number) => string,
 *   formatDate: (iso: string) => string,
 *   updateRunSummary: (config: any) => void,
 *   updateTimingsDisplay: (timings: any) => void,
 *   updateUI: () => void,
 *   showLoading: (msg: string) => void,
 *   getSourceCanvas: () => HTMLCanvasElement | null,
 *   setSourceCanvas: (canvas: HTMLCanvasElement | null) => void,
 *   getCurrentRunConfig: () => object,
 *   setCurrentRunConfig: (config: any) => void,
 *   getCurrentStageTimings: () => object | null,
 *   setCurrentStageTimings: (timings: any) => void,
 *   getSelectedFiles: () => any[],
 *   setSelectedFiles: (files: any[]) => void,
 *   getCurrentFileIndex: () => number,
 *   setCurrentFileIndex: (idx: number) => void,
 *   getCurrentFile: () => any,
 *   setCurrentFile: (file: any) => void,
 *   getCurrentFileType: () => string | null,
 *   setCurrentFileType: (type: string | null) => void,
 *   getRequiredAssetsReady: () => boolean,
 *   setRequiredAssetsReady: (ready: boolean) => void,
 *   getTotalPages: () => number,
 *   setTotalPages: (n: number) => void,
 *   getCurrentPage: () => number,
 *   setCurrentPage: (n: number) => void,
 *   getSyncedPageIndex: () => number | null,
 *   setSyncedPageIndex: (idx: number | null) => void,
 *   getSyncedLinkId: () => string | null,
 *   setSyncedLinkId: (id: string | null) => void,
 * }} ReloadCtx
 */

/** @type {ReloadCtx | null} */
let _ctx = null;

/**
 * Initialise the history reload module with shared app context.
 * Must be called once from init() before loadHistoryItem() is used.
 *
 * @param {ReloadCtx} ctx
 */
export function initHistoryReload(ctx) {
  _ctx = ctx;
}

/**
 * Load a history item back into the workspace.
 * Runs a disposer chain before mounting new content to release previous
 * blob URLs, zero-out canvases, remove thumbnailObjectUrls entries, and
 * detach observers (Requirement 4.7).
 *
 * @param {object} item - History entry from getHistory().
 */
export async function loadHistoryItem(item) {
  if (!_ctx) {
    console.warn('[history/reload] initHistoryReload() not called before loadHistoryItem()');
    return;
  }

  const {
    el,
    appState,
    thumbnailObjectUrls,
    renderedPages,
    overlayResizeObserver,
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
    getSourceCanvas,
    setSourceCanvas,
    setCurrentRunConfig,
    setCurrentStageTimings,
    setSelectedFiles,
    setCurrentFileIndex,
    setCurrentFile,
    setCurrentFileType,
    setRequiredAssetsReady,
    setTotalPages,
    setCurrentPage,
    setSyncedPageIndex,
    setSyncedLinkId,
  } = _ctx;

  setWorkspaceMode('workspace');

  // ── Disposer chain: release resources from the previous item ──────────────
  // deterministic cleanup before mounting new content (Requirement 4.7)
  const disposer = createDisposerChain('loadHistoryItem');

  // 1. Revoke previous blob URLs and clear the tracking set
  disposer.add(() => {
    for (const url of thumbnailObjectUrls) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
    thumbnailObjectUrls.clear();
  });

  // 2. Zero-out all rendered page canvases
  disposer.add(() => {
    for (const record of renderedPages) {
      if (record?.canvas) {
        try {
          record.canvas.width = 0;
          record.canvas.height = 0;
        } catch { /* ignore */ }
      }
    }
  });

  // 3. Detach overlay resize observer so stale page elements are not observed
  disposer.add(() => {
    try { overlayResizeObserver?.disconnect(); } catch { /* ignore */ }
  });

  await disposer.runAll();
  // ─────────────────────────────────────────────────────────────────────────

  // Load assets from IndexedDB
  let images = item.images || {};
  if (!hasStoredImages(images) && item.imagesKey) {
    try {
      images = await readHistoryAsset(item.imagesKey) || {};
    } catch (err) {
      console.warn(`${UI_LOG_PREFIX} Failed to load history images:`, err);
      images = {};
    }
  }

  let previewPages = [];
  if (item.previewPagesKey) {
    try {
      const storedPages = await readHistoryAsset(item.previewPagesKey);
      previewPages = Array.isArray(storedPages) ? storedPages.filter(Boolean) : [];
    } catch (err) {
      console.warn(`${UI_LOG_PREFIX} Failed to load history preview pages:`, err);
    }
  }

  const markdown = await readHistoryStoredValue(item, 'markdownKey', 'markdown', item.markdown || '');
  const contentList = await readHistoryStoredValue(
    item,
    'contentListKey',
    'content list',
    getResultArtifact(item, 'contentList', 'content_list', 'content_list_json') || []
  );
  const layoutLabelBlocks = await readHistoryStoredValue(
    item,
    'layoutLabelBlocksKey',
    'layout label blocks',
    item.layoutLabelBlocks || []
  );
  const overlayBlocks = await readHistoryStoredValue(
    item,
    'overlayBlocksKey',
    'overlay blocks',
    item.overlayBlocks || []
  );

  let middleJson = getResultArtifact(item, 'middleJson', 'middle_json', 'layout_info');
  let modelJson = getResultArtifact(item, 'modelJson', 'model_output', 'modelOutput');
  if (!middleJson && item.middleJsonKey) {
    try {
      middleJson = await readHistoryAsset(item.middleJsonKey);
    } catch (err) {
      console.warn(`${UI_LOG_PREFIX} Failed to load history middle JSON:`, err);
    }
  }
  if (!modelJson && item.modelJsonKey) {
    try {
      modelJson = await readHistoryAsset(item.modelJsonKey);
    } catch (err) {
      console.warn(`${UI_LOG_PREFIX} Failed to load history model JSON:`, err);
    }
  }

  const historicalResults = {
    markdown,
    content_list: contentList,
    page_count: item.pageCount,
    fileName: item.fileName,
    fileSize: item.fileSize,
    images,
    middle_json: middleJson,
    model_output: modelJson,
    layout_label_blocks: layoutLabelBlocks,
    overlay_blocks: overlayBlocks,
    processingTotalMs: Number(item.processingTotalMs || 0),
  };

  const stageTimings = normalizeHistoryStageTimings(item.stageTimings, item.processingTotalMs);
  setCurrentRunConfig(item.runConfig || null);
  setCurrentStageTimings(stageTimings);

  await cleanupPdfPreview();
  setSelectedFiles([]);
  setCurrentFileIndex(0);
  setCurrentFile(null);
  setRequiredAssetsReady(false);
  setCurrentFileType(String(item.fileName || '').toLowerCase().endsWith('.pdf') ? 'pdf' : 'image');
  releaseCanvas(getSourceCanvas());
  setSourceCanvas(null);

  // Update appState with historical results
  appState.patch({
    currentFile: null,
    files: [],
    results: historicalResults,
    timings: stageTimings || emptyTimingSet(),
  });

  prepareLinkedBlocks(historicalResults);
  setTotalPages(item.pageCount || 1);
  setCurrentPage(1);
  setSyncedPageIndex(null);
  setSyncedLinkId(null);
  updatePageInfo();

  // Display the historical result
  displayMarkdown(markdown, item.pageCount, contentList);
  displayJSON(contentList, 'content');

  // Render thumbnail in viewer if available
  if (previewPages.length) {
    renderHistoryPreviewPages(previewPages);
  } else if (item.thumbnail) {
    renderHistoryThumbnail(item.thumbnail);
  } else {
    showEmptyViewer();
  }

  // Update file info
  if (el.currentFileName) {
    el.currentFileName.textContent = item.fileName;
    el.currentFileName.title = item.fileName || '';
  }
  if (el.currentFileMeta) {
    const sizeText = formatFileSize(item.fileSize);
    el.currentFileMeta.textContent = [sizeText !== '-' ? sizeText : null, formatDate(item.timestamp)].filter(Boolean).join(' • ');
  }

  updateRunSummary(item.runConfig || null);
  updateTimingsDisplay(stageTimings);
  updateUI();

  showLoading(`Loaded: ${item.fileName}`);
}
