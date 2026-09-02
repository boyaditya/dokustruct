/**
 * ui/linking/highlight.js
 *
 * setLinkedHighlight / clearLinkedHighlight paint management.
 * Routes paint work through rafCoalescer and short-circuits when
 * the new highlight target is identical to the current one.
 */

import { ctx } from './context.js';
import { createRafCoalescer } from '../perf/rafCoalescer.js';

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(value));
  return String(value).replace(/"/g, '\\"');
}

// coalesce rapid highlight calls to one rAF per frame
const _highlightCoalescer = createRafCoalescer(_applyHighlight);
let _pendingLinkId = null;
let _pendingGroupId = '';

/**
 * Schedule a highlight update. Coalesced to one rAF per frame.
 * @param {string} linkId
 * @param {string} [groupId]
 */
export function setLinkedHighlight(linkId, groupId = '') {
  const normalizedGroup = groupId || '';
  if (linkId === ctx.activeLinkId && normalizedGroup === ctx.activeGroupId) return;  _pendingLinkId = linkId;
  _pendingGroupId = normalizedGroup;
  _highlightCoalescer.schedule();
}

function _applyHighlight() {
  const linkId = _pendingLinkId;
  const groupId = _pendingGroupId;
  if (linkId === null) return;

  ctx.activeLinkId = linkId;
  ctx.activeGroupId = groupId;

  const { pageStack, markdownContent } = ctx.el;

  // Clear previous
  pageStack?.querySelectorAll('.layout-box.is-linked, .merge-connector.is-linked, .merge-connector-node.is-linked, .merge-connector-label.is-linked, .merge-connector-label-bg.is-linked').forEach(node => {
    node.classList.remove('is-linked');
  });
  markdownContent?.querySelectorAll('.block-shell.is-linked').forEach(node => {
    node.classList.remove('is-linked');
  });

  // Apply by linkId
  pageStack?.querySelectorAll(`[data-link-id="${cssEscape(linkId)}"]`).forEach(node => {
    if (node.classList.contains('layout-box')) node.classList.add('is-linked');
  });
  markdownContent?.querySelectorAll(`[data-link-id="${cssEscape(linkId)}"]`).forEach(node => {
    if (node.classList.contains('block-shell')) node.classList.add('is-linked');
  });

  // Apply by groupId
  if (groupId) {
    pageStack?.querySelectorAll(`[data-link-group-id="${cssEscape(groupId)}"]`).forEach(node => {
      if (node.classList.contains('layout-box')
        || node.classList.contains('merge-connector')
        || node.classList.contains('merge-connector-node')
        || node.classList.contains('merge-connector-label')
        || node.classList.contains('merge-connector-label-bg')) {
        node.classList.add('is-linked');
      }
    });
    markdownContent?.querySelectorAll(`[data-link-group-id="${cssEscape(groupId)}"]`).forEach(node => {
      if (node.classList.contains('block-shell')) node.classList.add('is-linked');
    });
  }
}

/**
 * Clear all linked highlights. Respects pin state.
 */
export function clearLinkedHighlight() {
  if (ctx.pinnedLinkId != null) {
    if (ctx.activeLinkId !== ctx.pinnedLinkId || ctx.activeGroupId !== ctx.pinnedGroupId) {
      setLinkedHighlight(ctx.pinnedLinkId, ctx.pinnedGroupId);
    }
    return;
  }
  _highlightCoalescer.cancel();
  ctx.activeLinkId = null;
  ctx.activeGroupId = '';
  _pendingLinkId = null;
  _pendingGroupId = '';

  const { pageStack, markdownContent } = ctx.el;
  pageStack?.querySelectorAll('.layout-box.is-linked, .merge-connector.is-linked, .merge-connector-node.is-linked, .merge-connector-label.is-linked, .merge-connector-label-bg.is-linked').forEach(node => {
    node.classList.remove('is-linked');
  });
  markdownContent?.querySelectorAll('.block-shell.is-linked').forEach(node => {
    node.classList.remove('is-linked');
  });
}
