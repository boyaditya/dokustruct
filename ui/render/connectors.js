/**
 * ui/render/connectors.js
 *
 * Draws SVG connector lines between merged layout-overlay boxes that span
 * multiple pages or positions. Uses a single global SVG layer prepended to
 * el.pageStack. Batched via a single innerHTML clear followed by grouped
 * appends, so reads never interleave with writes.
 */

import { createRafCoalescer } from '../perf/rafCoalescer.js';

/**
 * @typedef {{
 *   renderedPages: any[],
 *   pageStack: Element|null,
 * }} ConnectorsRenderContext
 */

/** @type {ConnectorsRenderContext} */
const _ctx = {
  renderedPages: [],
  pageStack: null,
};

/**
 * Wire the connectors render context. Called once from app.js init.
 * @param {ConnectorsRenderContext} ctx
 */
export function initConnectorsRenderer(ctx) {
  // Use defineProperties to preserve getter descriptors so live references
  // (renderedPages array, pageStack element) are always current.
  const descriptors = Object.getOwnPropertyDescriptors(ctx);
  Object.defineProperties(_ctx, descriptors);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function getGlobalMergeConnectorLayer() {
  if (!_ctx.pageStack) return null;
  let layer = _ctx.pageStack.querySelector(':scope > .merge-connector-global-layer');
  if (layer) return layer;
  layer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  layer.classList.add('merge-connector-global-layer');
  _ctx.pageStack.prepend(layer);
  return layer;
}

function syncGlobalMergeConnectorLayer(layer = null) {
  const connectorLayer = layer || _ctx.pageStack?.querySelector(':scope > .merge-connector-global-layer');
  if (!connectorLayer || !_ctx.pageStack) return;
  const width = Math.max(_ctx.pageStack.scrollWidth, _ctx.pageStack.offsetWidth, 1);
  const height = Math.max(_ctx.pageStack.scrollHeight, _ctx.pageStack.offsetHeight, 1);
  connectorLayer.setAttribute('width', String(width));
  connectorLayer.setAttribute('height', String(height));
  connectorLayer.setAttribute('viewBox', `0 0 ${width} ${height}`);
}

function compareConnectorItems(a, b) {
  if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
  if (Math.abs(a.top - b.top) > 4) return a.top - b.top;
  return a.left - b.left;
}

function getGlobalItemBox(item) {
  return {
    left: item.pageLeft + item.left,
    top: item.pageTop + item.top,
    width: item.width,
    height: item.height,
  };
}

function getGlobalBoxCorners(box) {
  return [
    { x: box.left, y: box.top },
    { x: box.left + box.width, y: box.top },
    { x: box.left + box.width, y: box.top + box.height },
    { x: box.left, y: box.top + box.height },
  ];
}

function getPointDistance(a, b) {
  return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
}

function routeConnectorBetweenItems(source, target) {
  const sourceCorners = getGlobalBoxCorners(getGlobalItemBox(source));
  const targetCorners = getGlobalBoxCorners(getGlobalItemBox(target));
  let best = [sourceCorners[0], targetCorners[0]];
  let bestDistance = Infinity;
  sourceCorners.forEach(start => {
    targetCorners.forEach(end => {
      const distance = getPointDistance(start, end);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = [start, end];
      }
    });
  });
  return best;
}

function appendMergeConnectorNode(layer, groupId, point) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  node.classList.add('merge-connector-node');
  node.dataset.linkGroupId = groupId;
  node.setAttribute('cx', point.x.toFixed(1));
  node.setAttribute('cy', point.y.toFixed(1));
  node.setAttribute('r', '4');
  layer.appendChild(node);
}

function appendMergeConnectorLabel(layer, groupId, start, end) {
  const mid = {
    x: (start.x + end.x) * 0.5,
    y: (start.y + end.y) * 0.5,
  };
  const labelWidth = 38;
  const labelHeight = 16;
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.classList.add('merge-connector-label-bg');
  bg.dataset.linkGroupId = groupId;
  bg.setAttribute('x', (mid.x - labelWidth / 2).toFixed(1));
  bg.setAttribute('y', (mid.y - labelHeight / 2).toFixed(1));
  bg.setAttribute('width', String(labelWidth));
  bg.setAttribute('height', String(labelHeight));
  bg.setAttribute('rx', '4');
  layer.appendChild(bg);

  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  text.classList.add('merge-connector-label');
  text.dataset.linkGroupId = groupId;
  text.setAttribute('x', mid.x.toFixed(1));
  text.setAttribute('y', (mid.y + 3.5).toFixed(1));
  text.textContent = 'merge';
  layer.appendChild(text);
}

function appendMergeConnectorPath(layer, groupId, points, { showLabel = false } = {}) {
  if (!layer || points.length < 2) return;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const [first, ...rest] = points;
  const d = [`M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`]
    .concat(rest.map(point => `L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`))
    .join(' ');
  path.classList.add('merge-connector');
  path.dataset.linkGroupId = groupId;
  path.setAttribute('d', d);
  layer.appendChild(path);

  appendMergeConnectorNode(layer, groupId, first);
  appendMergeConnectorNode(layer, groupId, rest[rest.length - 1]);
  if (showLabel) appendMergeConnectorLabel(layer, groupId, first, rest[rest.length - 1]);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render SVG merge-connector lines between grouped overlay boxes.
 * Phase 1 (read): collect box positions from the live overlay DOM.
 * Phase 2 (write): clear the SVG layer and append new paths.
 *  — reads before writes.
 */
export function renderMergeConnectors() {
  const layer = getGlobalMergeConnectorLayer();
  if (!layer || !_ctx.pageStack) return;

  // Write: clear
  layer.innerHTML = '';
  syncGlobalMergeConnectorLayer(layer);

  // Read phase: collect all grouped boxes
  const groups = new Map();
  _ctx.renderedPages.forEach(record => {
    const boxes = Array.from(record.overlay.querySelectorAll('.layout-box[data-link-group-id]'));
    boxes.forEach(box => {
      const groupId = box.dataset.linkGroupId;
      if (!groupId) return;
      if (!groups.has(groupId)) groups.set(groupId, []);
      groups.get(groupId).push({
        box,
        record,
        pageIndex: record.pageIndex,
        left: parseFloat(box.style.left) || 0,
        top: parseFloat(box.style.top) || 0,
        width: parseFloat(box.style.width) || 0,
        height: parseFloat(box.style.height) || 0,
        pageLeft: record.pageEl.offsetLeft,
        pageTop: record.pageEl.offsetTop,
      });
    });
  });

  // Write phase: append connector paths
  groups.forEach((items, groupId) => {
    if (items.length < 2) return;
    items.sort(compareConnectorItems);
    const segments = [];
    for (let index = 0; index < items.length - 1; index += 1) {
      const points = routeConnectorBetweenItems(items[index], items[index + 1]);
      const length = getPointDistance(points[0], points[1]);
      segments.push({ points, length });
    }
    const labelIndex = segments.reduce((bestIndex, segment, index) => (
      segment.length > (segments[bestIndex]?.length || 0) ? index : bestIndex
    ), 0);
    segments.forEach((segment, index) => {
      appendMergeConnectorPath(layer, groupId, segment.points, { showLabel: index === labelIndex });
    });
  });
}

/**
 * Schedule renderMergeConnectors via RAF coalescer.
 * Attaches a lazy _coalescer property on first call.
 */
export function scheduleRenderMergeConnectors() {
  if (!scheduleRenderMergeConnectors._coalescer) {
    scheduleRenderMergeConnectors._coalescer = createRafCoalescer(renderMergeConnectors);
  }
  scheduleRenderMergeConnectors._coalescer.schedule();
}

/**
 * Sync the global connector layer dimensions to the current pageStack size.
 * Called from syncOverlayToCanvas in app.js.
 */
export { syncGlobalMergeConnectorLayer };
