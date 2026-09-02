/**
 * ui/history/list.js
 *
 * Extracted from ui/app.js. Signature unchanged.
 * Virtualization applied when history item count > 100.
 */

import { createVirtualList } from '../perf/virtualization.js';

const HISTORY_VLIST_THRESHOLD = 100;

/** @type {{ el: object, getHistory: () => any[], formatDuration: (ms: number) => string, formatFileSize: (bytes: number) => string, formatDate: (iso: string) => string, escapeHtml: (s: string) => string, refreshIcons: () => void, loadHistoryItem: (item: object) => Promise<void>, requestHistoryDelete: (id: any) => void }} */
let _ctx = null;

/** @type {import('../perf/virtualization.js').VirtualList | null} */
let _vlist = null;

/**
 * Initialise the history list module with shared app context.
 * Must be called once from init before loadHistory is used.
 *
 * @param {{
 *   el: object,
 *   getHistory: () => any[],
 *   formatDuration: (ms: number) => string,
 *   formatFileSize: (bytes: number) => string,
 *   formatDate: (iso: string) => string,
 *   escapeHtml: (s: string) => string,
 *   refreshIcons: () => void,
 *   loadHistoryItem: (item: object) => Promise<void>,
 *   requestHistoryDelete: (id: any) => void,
 * }} ctx
 */
export function initHistoryList(ctx) {
  _ctx = ctx;
}

/**
 * Render the history sidebar list.
 * Applies IntersectionObserver-based virtualization when item count > 100.
 */
export function loadHistory() {
  if (!_ctx) {
    console.warn('[history/list] initHistoryList() not called before loadHistory()');
    return;
  }

  const { el, getHistory, formatDuration, formatFileSize, formatDate, escapeHtml, refreshIcons, loadHistoryItem, requestHistoryDelete } = _ctx;

  const history = getHistory();
  if (!el.fileList) return;

  // Disconnect any previous virtual list before rebuilding DOM
  if (_vlist) {
    _vlist.disconnect();
    _vlist = null;
  }

  el.fileList.innerHTML = '';

  if (history.length === 0) {
    el.fileList.innerHTML = '<div class="empty-history">No processed documents yet</div>';
    return;
  }

  history.forEach((item) => {
    const div = document.createElement('div');
    // Whole-card pulse via CSS class when pipeline is active
    const isProcessing = Boolean(item._isProcessing);
    div.className = 'history-item' + (isProcessing ? ' is-processing' : '');

    // Determine icon based on file type
    const fileName = String(item.fileName || 'Untitled document');
    const isPdf = fileName.toLowerCase().endsWith('.pdf');
    const iconClass = isPdf ? 'pdf' : 'image';
    const iconName = isPdf ? 'file-text' : 'image';
    const timingText = formatDuration(Number(item.processingTotalMs || 0));
    const sizeText = formatFileSize(item.fileSize);
    const badges = [
      item.runConfig?.formulaEnable ? '<span class="history-badge" title="Formula enabled">Formula</span>' : '',
      item.runConfig?.tableEnable ? '<span class="history-badge" title="Table enabled">Table</span>' : '',
    ].filter(Boolean).join('');
    const historyMeta = [
      sizeText !== '-' ? sizeText : null,
      formatDate(item.timestamp),
      isProcessing ? '<span class="history-processing-pulse">Processing...</span>' : (timingText !== '-' ? timingText : null),
    ].filter(Boolean).join(' • ');

    div.innerHTML = `
      <div class="history-icon ${iconClass}${isProcessing ? ' is-processing' : ''}">
        <i data-lucide="${iconName}"></i>
      </div>
      <div class="history-info">
        <div class="history-name">${escapeHtml(fileName)}</div>
        <div class="history-meta">${historyMeta}</div>
        ${badges ? `<div class="history-badges">${badges}</div>` : ''}
      </div>
      <button class="history-delete" data-id="${item.id}" type="button" aria-label="Delete ${escapeHtml(fileName)}"${isProcessing ? ' disabled' : ''}>
        <i data-lucide="trash-2"></i>
      </button>
    `;

    div.querySelector('.history-info').addEventListener('click', () => loadHistoryItem(item));
    div.querySelector('.history-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      requestHistoryDelete(item.id);
    });

    el.fileList.appendChild(div);
  });

  // apply virtualization when item count exceeds threshold
  if (history.length > HISTORY_VLIST_THRESHOLD) {
    _vlist = createVirtualList({
      container: el.fileList,
      threshold: HISTORY_VLIST_THRESHOLD,
      rootMargin: '200px',
    });
    _vlist.observe(el.fileList.querySelectorAll('.history-item'));
  }

  refreshIcons();
}
