/**
 * ui/linking/context.js
 *
 * All linking submodules read/write through this single object so they can be
 * extracted from ui/app.js without requiring prop-drilling or global leakage.
 * app.js initialises the context once via `initLinkingContext(el, getters)`.
 */

/**
 * @typedef {{
 *   el: { pageStack: Element|null, markdownContent: Element|null },
 *   linkedBlocks: any[],
 *   activeLinkId: string|null,
 *   activeGroupId: string,
 *   pinnedLinkId: string|null,
 *   pinnedGroupId: string,
 *   pinReleaseListener: Function|null,
 *   isSyncingScroll: boolean,
 *   syncedLinkId: string|null,
 *   currentPage: number,
 *   updatePageInfo: () => void,
 *   scrollOutputToLink: (id: string) => boolean,
 *   scrollOutputToNearestPageLink: (pageIndex: number, id: string) => boolean,
 *   scrollOutputToPagePosition: (pageIndex: number, ratio: number) => void,
 *   scrollPreviewToLink: (id: string) => boolean,
 *   scrollPreviewToPagePosition: (pageIndex: number, ratio: number) => void,
 *   getPreviewLinkPosition: (id: string) => {pageIndex: number, ratio: number}|null,
 *   getOutputLinkPosition: (id: string) => {pageIndex: number, ratio: number}|null,
 * }} LinkingContext
 */

/** @type {LinkingContext} */
export const ctx = {
  el: { pageStack: null, markdownContent: null },
  linkedBlocks: [],
  activeLinkId: null,
  activeGroupId: '',
  pinnedLinkId: null,
  pinnedGroupId: '',
  pinReleaseListener: null,
  isSyncingScroll: false,
  syncedLinkId: null,
  currentPage: 1,
  // These are wired by app.js after init
  updatePageInfo: () => {},
  scrollOutputToLink: () => false,
  scrollOutputToNearestPageLink: () => false,
  scrollOutputToPagePosition: () => {},
  scrollPreviewToLink: () => false,
  scrollPreviewToPagePosition: () => {},
  getPreviewLinkPosition: () => null,
  getOutputLinkPosition: () => null,
};

/**
 * Wire the linking context to the live app.js state.
 * Called once during init after DOM elements are resolved.
 *
 * @param {object} elRef - The `el` object from app.js
 * @param {object} fns - Scroll/nav helpers from app.js
 */
export function initLinkingContext(elRef, fns) {
  ctx.el = elRef;
  Object.assign(ctx, fns);
}
