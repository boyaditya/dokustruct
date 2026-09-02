/**
 * ui/linking/events.js
 *
 * Extracted from ui/app.js. Includes keyboard parity (focusin/focusout)
 * per
 */

import { ctx } from './context.js';
import { setLinkedHighlight, clearLinkedHighlight } from './highlight.js';
import { pinLinkedBlock } from './pin.js';
import { createListenerBag } from '../lifecycle/listenerBag.js';

/** Listener bag for all linking event handlers — dispose on teardown. */
export const linkingListenerBag = createListenerBag('linking');

// ── Preview panel handlers ────────────────────────────────────────────────

export function handlePreviewLinkHover(event) {
  const box = event.target.closest?.('.layout-box');
  if (!box?.dataset.linkId) return;
  setLinkedHighlight(box.dataset.linkId, box.dataset.linkGroupId);
}

export function handlePreviewLinkLeave(event) {
  if (!event.target.closest?.('.layout-box')) return;
  if (ctx.pinnedLinkId != null) return;
  const fromBox = event.target.closest('.layout-box');
  const toBox = event.relatedTarget?.closest?.('.layout-box');
  if (toBox && toBox === fromBox) return;
  clearLinkedHighlight();
}

export function handlePreviewLinkClick(event) {
  const box = event.target.closest?.('.layout-box');
  if (!box?.dataset.linkId || event.button !== 0) return;
  event.preventDefault();
  pinLinkedBlock(box.dataset.linkId, { source: 'preview' });
}

// ── Markdown panel handlers ───────────────────────────────────────────────

export function handleMarkdownLinkHover(event) {
  if (event.target.closest?.('.block-action-bar')) return;
  const shell = event.target.closest?.('.block-shell[data-link-id]');
  if (!shell?.dataset.linkId) return;
  setLinkedHighlight(shell.dataset.linkId, shell.dataset.linkGroupId);
}

export function handleMarkdownLinkLeave(event) {
  if (!event.target.closest?.('.block-shell[data-link-id]')) return;
  if (ctx.pinnedLinkId != null) return;
  const sourceShell = event.target.closest('.block-shell[data-link-id]');
  const relatedShell = event.relatedTarget?.closest?.('.block-shell[data-link-id]');
  if (relatedShell && relatedShell === sourceShell) return;
  if (event.relatedTarget === null && ctx.el.markdownContent?.contains(event.target)) return;
  clearLinkedHighlight();
}

export function handleMarkdownLinkClick(event) {
  if (event.target.closest?.('.block-action-bar')) return;
  const shell = event.target.closest?.('.block-shell[data-link-id]');
  if (!shell?.dataset.linkId || event.button !== 0) return;
  pinLinkedBlock(shell.dataset.linkId, { source: 'output' });
}

// ── Keyboard parity () ────────────────────────────────────

export function handleMarkdownLinkFocusIn(event) {
  const shell = event.target.closest?.('.block-shell[data-link-id]');
  if (!shell?.dataset.linkId) return;
  setLinkedHighlight(shell.dataset.linkId, shell.dataset.linkGroupId);
}

export function handleMarkdownLinkFocusOut(event) {
  const shell = event.target.closest?.('.block-shell[data-link-id]');
  if (!shell) return;
  if (ctx.pinnedLinkId != null) return;
  clearLinkedHighlight();
}

// ── Wire / unwire ─────────────────────────────────────────────────────────

/**
 * Register all linking event listeners using the listener bag.
 * Idempotent — disposes previous bag before re-registering.
 */
export function wireLinkingEvents() {
  linkingListenerBag.dispose();

  const { pageStack, markdownContent } = ctx.el;
  if (pageStack) {
    linkingListenerBag.add(pageStack, 'mouseover', handlePreviewLinkHover);
    linkingListenerBag.add(pageStack, 'mouseout', handlePreviewLinkLeave);
    linkingListenerBag.add(pageStack, 'click', handlePreviewLinkClick);
  }
  if (markdownContent) {
    linkingListenerBag.add(markdownContent, 'mouseover', handleMarkdownLinkHover);
    linkingListenerBag.add(markdownContent, 'mouseout', handleMarkdownLinkLeave);
    linkingListenerBag.add(markdownContent, 'click', handleMarkdownLinkClick);
    // keyboard parity — focusin/focusout delegation
    linkingListenerBag.add(markdownContent, 'focusin', handleMarkdownLinkFocusIn);
    linkingListenerBag.add(markdownContent, 'focusout', handleMarkdownLinkFocusOut);
  }
}

/**
 * Remove all linking event listeners.
 */
export function unwireLinkingEvents() {
  linkingListenerBag.dispose();
}
