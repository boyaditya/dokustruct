/**
 * ui/linking/index.js
 *
 * Re-exports all public linking API so app-v2.js can import from one place.
 * Also provides ensureLinkingActive / ensureLinkingInactive (Requirement 2.5).
 */

export { ctx, initLinkingContext } from './context.js';
export { setLinkedHighlight, clearLinkedHighlight } from './highlight.js';
export { pinLinkedBlock, releasePin } from './pin.js';
export {
  handlePreviewLinkHover,
  handlePreviewLinkLeave,
  handlePreviewLinkClick,
  handleMarkdownLinkHover,
  handleMarkdownLinkLeave,
  handleMarkdownLinkClick,
  wireLinkingEvents,
  unwireLinkingEvents,
} from './events.js';

import { ctx } from './context.js';
import { wireLinkingEvents, unwireLinkingEvents } from './events.js';
import { releasePin } from './pin.js';
import { clearLinkedHighlight } from './highlight.js';

let _linkingActive = false;

/**
 * Activate linking for a new result set. Idempotent.
 * @param {{ results: object|null }} opts
 */
export function ensureLinkingActive({ results } = {}) {
  if (!results) {
    ensureLinkingInactive();
    return;
  }
  wireLinkingEvents();
  _linkingActive = true;
}

/**
 * Deactivate linking and clear all state. Idempotent.
 */
export function ensureLinkingInactive() {
  if (!_linkingActive) return;
  unwireLinkingEvents();
  releasePin();
  clearLinkedHighlight();
  ctx.linkedBlocks = [];
  ctx.activeLinkId = null;
  ctx.activeGroupId = '';
  ctx.syncedLinkId = null;
  _linkingActive = false;
}
