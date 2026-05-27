/**
 * ui/linking/pin.js
 *
 * Extracted from ui/app-v2.js. Single pinReleaseListener slot with
 * local-closure capture (FIX L4-bis) and group-aware outside-click (FIX L8).
 */

import { ctx } from './context.js';
import { setLinkedHighlight, clearLinkedHighlight } from './highlight.js';

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(value));
  return String(value).replace(/"/g, '\\"');
}

function getLinkGroupId(linkId) {
  return document.querySelector(`[data-link-id="${cssEscape(linkId)}"][data-link-group-id]`)?.dataset.linkGroupId
    || ctx.linkedBlocks.find(block => block.id === linkId)?.mergeGroupId
    || '';
}

/**
 * Pin a linked block and scroll the opposite panel to it.
 * @param {string} linkId
 * @param {{ source?: 'preview'|'output' }} [opts]
 */
export function pinLinkedBlock(linkId, { source = 'preview' } = {}) {
  // Remove any existing pin release listener before setting a new pin
  if (ctx.pinReleaseListener) {
    document.removeEventListener('click', ctx.pinReleaseListener, true);
    ctx.pinReleaseListener = null;
  }
  ctx.pinnedLinkId = linkId;

  const groupId = getLinkGroupId(linkId);
  ctx.pinnedGroupId = groupId || '';
  // Reset active so setLinkedHighlight short-circuit doesn't suppress the pin paint
  ctx.activeLinkId = null;
  ctx.activeGroupId = '';
  setLinkedHighlight(linkId, groupId);

  const releaseFn = function onPinRelease(e) {
    const escapedId = cssEscape(linkId);
    const groupSelector = groupId ? `, [data-link-group-id="${cssEscape(groupId)}"]` : '';
    const pinnedNodes = document.querySelectorAll(`[data-link-id="${escapedId}"]${groupSelector}`);
    let clickedInsidePinned = false;
    for (const node of pinnedNodes) {
      if (node.contains(e.target)) { clickedInsidePinned = true; break; }
    }
    if (!clickedInsidePinned) {
      ctx.pinnedLinkId = null;
      ctx.pinnedGroupId = '';
      document.removeEventListener('click', releaseFn, true);
      if (ctx.pinReleaseListener === releaseFn) ctx.pinReleaseListener = null;
      clearLinkedHighlight();
    }
  };
  ctx.pinReleaseListener = releaseFn;
  document.addEventListener('click', releaseFn, true);

  if (source === 'preview') {
    const pos = ctx.getPreviewLinkPosition(linkId);
    if (pos) {
      ctx.currentPage = pos.pageIndex + 1;
      ctx.updatePageInfo();
      if (!ctx.scrollOutputToLink(linkId)) {
        ctx.scrollOutputToNearestPageLink(pos.pageIndex, linkId) || ctx.scrollOutputToPagePosition(pos.pageIndex, pos.ratio);
      }
    }
  } else if (source === 'output') {
    const pos = ctx.getOutputLinkPosition(linkId);
    if (pos) {
      ctx.currentPage = pos.pageIndex + 1;
      ctx.updatePageInfo();
      if (!ctx.scrollPreviewToLink(linkId)) {
        ctx.scrollPreviewToPagePosition(pos.pageIndex, pos.ratio);
      }
    }
  }
}

/**
 * Release the current pin and clear highlights.
 */
export function releasePin() {
  if (ctx.pinReleaseListener) {
    document.removeEventListener('click', ctx.pinReleaseListener, true);
    ctx.pinReleaseListener = null;
  }
  ctx.pinnedLinkId = null;
  ctx.pinnedGroupId = '';
}
