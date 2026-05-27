/**
 * ui/render/overlay.js
 *
 * Uses DocumentFragment per page (Requirement 3.4) to reduce forced reflows.
 * ≤2 forced reflows per call (one read phase, one write phase).
 */

/**
 * @typedef {{
 *   renderedPages: any[],
 *   linkedBlocks: any[],
 *   overlayVisible: boolean,
 *   prepareLinkedBlocks: (results: any) => any[],
 *   buildRawOverlayBlocks: (results: any) => any[],
 *   getDisplayedCanvasSize: (record: any) => {width: number, height: number},
 *   getOverlaySourceSize: (results: any, pageIndex: number, boxes: any[]) => {width: number, height: number}|null,
 *   normalizeBox: (box: any) => any,
 *   classifyOverlayCategory: (opts: any) => string,
 *   getOverlayLabel: (opts: any) => string,
 *   syncOverlayToCanvas: () => void,
 *   scheduleRenderMergeConnectors: () => void,
 *   clearLayoutOverlay: () => void,
 *   getResults: () => any,
 * }} OverlayRenderContext
 */

/** @type {OverlayRenderContext} */
const _ctx = {
  renderedPages: [],
  linkedBlocks: [],
  overlayVisible: true,
  prepareLinkedBlocks: () => [],
  buildRawOverlayBlocks: () => [],
  getDisplayedCanvasSize: () => ({ width: 1, height: 1 }),
  getOverlaySourceSize: () => null,
  normalizeBox: () => null,
  classifyOverlayCategory: () => 'text',
  getOverlayLabel: () => 'block',
  syncOverlayToCanvas: () => {},
  scheduleRenderMergeConnectors: () => {},
  clearLayoutOverlay: () => {},
  getResults: () => null,
};

/**
 * Wire the overlay render context. Called once from app-v2.js init().
 * @param {OverlayRenderContext} ctx
 */
export function initOverlayRenderer(ctx) {
  const descriptors = Object.getOwnPropertyDescriptors(ctx);
  Object.defineProperties(_ctx, descriptors);
}

/**
 * Render layout overlay boxes for all pages.
 * Uses DocumentFragment per page to batch DOM writes (Requirement 3.4).
 */
export function renderLayoutOverlay() {
  if (!_ctx.renderedPages.length) return;
  const results = _ctx.getResults();
  if (!_ctx.overlayVisible) {
    _ctx.clearLayoutOverlay();
    return;
  }
  if (!_ctx.linkedBlocks.length) _ctx.prepareLinkedBlocks(results);
  const overlayBlocks = _ctx.linkedBlocks.length
    ? _ctx.linkedBlocks
    : _ctx.buildRawOverlayBlocks(results);

  // Phase 1: clear all overlays (write)
  _ctx.renderedPages.forEach(record => {
    record.overlay.innerHTML = '';
    record.overlay.style.display = 'none';
  });

  if (!overlayBlocks.length) {
    _ctx.clearLayoutOverlay();
    return;
  }

  // Group blocks by page
  const grouped = new Map();
  overlayBlocks.forEach(block => {
    const pageIndex = Number(block.pageIndex) || 0;
    if (!grouped.has(pageIndex)) grouped.set(pageIndex, []);
    grouped.get(pageIndex).push(block);
  });

  // Phase 2: build fragments (read display sizes) then append (write)
  _ctx.renderedPages.forEach(record => {
    const pageBlocks = grouped.get(record.pageIndex) || [];
    if (!pageBlocks.length) return;

    // Read phase: get display size once
    const displaySize = _ctx.getDisplayedCanvasSize(record);

    // Build fragment (no DOM reads inside)
    const fragment = document.createDocumentFragment();
    record.overlay.style.display = 'block';
    record.overlay.style.width = `${displaySize.width}px`;
    record.overlay.style.height = `${displaySize.height}px`;

    pageBlocks.forEach((block) => {
      const rect = block.bbox || _ctx.normalizeBox(block.item || block);
      if (!rect) return;
      const category = block.category || _ctx.classifyOverlayCategory({
        type: block.type,
        label: block.label,
        originalLabel: block.originalLabel,
      });
      const sourceSize = block.sourceSize
        || _ctx.getOverlaySourceSize(results, record.pageIndex, [block.item || block])
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
      if (block.originalLabel) item.dataset.originalLabel = block.originalLabel;
      if (rect.y0 * sy < 24) item.classList.add('is-near-top');
      if (displaySize.width - rect.x1 * sx < 180) item.classList.add('is-near-right');
      item.dataset.linkId = block.id;
      item.dataset.pageIndex = String(record.pageIndex);
      fragment.appendChild(item);
    });

    // Write phase: single append per page
    record.overlay.appendChild(fragment);
  });

  _ctx.syncOverlayToCanvas();
  _ctx.scheduleRenderMergeConnectors();
}
