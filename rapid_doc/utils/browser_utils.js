/**
 * Browser-specific utilities consolidated from multiple pipeline files.
 * Replaces duplicated yieldToBrowser in batch_analyze.js and pipeline_analyze.js.
 * Provides consistent error formatting for pipeline stages.
 * Provides BrowserPerformanceProfile for adaptive resource scaling (Audit P10).
 */

// ─── Browser Performance Profile (Audit P10) ─────────────────────────────────

/**
 * Device-tier performance profiles for adaptive resource scaling.
 * Controls batch sizes, DPI thresholds, and concurrency limits based on
 * detected device capability (deviceMemory API).
 *
 * Used by:
 *  - ocr_text_recognizer.js  → MAX_CONCURRENT_BATCHES
 *  - rapid_ocr.js            → recBatchNum default
 *  - rapid_layout.js         → DPI_DOWNSCALE_THRESHOLD
 *  - pipelineAdapter.js      → pdf_pages_batch default
 *
 * User-provided config always overrides these defaults (backward-compatible).
 */
export const BrowserPerformanceProfile = Object.freeze({
  MOBILE: Object.freeze({
    MAX_CONCURRENT_BATCHES: 2,
    REC_BATCH_NUM: 4,
    DPI_DOWNSCALE_THRESHOLD: 1600,
    PDF_PAGES_BATCH: 2,
  }),
  DESKTOP: Object.freeze({
    MAX_CONCURRENT_BATCHES: 5,
    REC_BATCH_NUM: 6,
    DPI_DOWNSCALE_THRESHOLD: 2200,
    PDF_PAGES_BATCH: 4,
  }),
  HIGH_END: Object.freeze({
    MAX_CONCURRENT_BATCHES: 10,
    REC_BATCH_NUM: 12,
    DPI_DOWNSCALE_THRESHOLD: 3000,
    PDF_PAGES_BATCH: 8,
  }),
});

/**
 * Detect the browser performance tier using the Navigator Device Memory API.
 * Falls back to DESKTOP in non-browser environments (Node.js, workers without navigator).
 *
 * Tier mapping:
 *  - MOBILE:   deviceMemory ≤ 4 GB
 *  - HIGH_END: deviceMemory ≥ 16 GB
 *  - DESKTOP:  everything else (including unknown / API not available)
 *
 * Note: this detects *system RAM*, not VRAM. The HIGH_END tier targets
 * desktops where the GPU is also high-end. Systems with abundant system
 * RAM but mid-range or older GPUs may want to clamp REC_BATCH_NUM further.
 * WebGPU paths halve concurrency in `ocr_text_recognizer.js` to compensate.
 *
 * @returns {typeof BrowserPerformanceProfile[keyof typeof BrowserPerformanceProfile]}
 */
export function detectProfile() {
  if (typeof navigator === 'undefined') return BrowserPerformanceProfile.DESKTOP;
  // navigator.deviceMemory is only available in Chromium-based browsers.
  // If absent, default to DESKTOP (safe middle tier).
  if (navigator.deviceMemory && navigator.deviceMemory <= 4) return BrowserPerformanceProfile.MOBILE;
  if (navigator.deviceMemory && navigator.deviceMemory >= 16) return BrowserPerformanceProfile.HIGH_END;
  return BrowserPerformanceProfile.DESKTOP;
}

// ─── Background-throttle-resistant yield ─────────────────────────────────────
//
// `setTimeout(fn, 0)` is NOT a reliable way to yield: browsers clamp timers in
// hidden/background tabs to a minimum of ~1000ms, and Chrome's "intensive
// throttling" further clamps them to once per minute after a tab has been
// hidden for a few minutes. Because the pipeline awaits a yield at many points
// per page batch (layout, formula, OCR det/rec, table, postprocess), a
// timer-based yield makes inference crawl or appear frozen as soon as the tab
// loses focus — only resuming when the user interacts with the page.
//
// `MessageChannel` callbacks are macrotasks that the background-tab timer
// throttling does NOT apply to, so they keep firing at full speed in hidden
// tabs. A single channel is reused and resolvers are drained FIFO (one message
// delivered per `postMessage`, so order is preserved) to avoid per-yield
// allocation in the hot loop.

/** @type {MessageChannel | null} */
let _yieldChannel = null;
/** @type {Array<() => void>} */
const _yieldResolvers = [];

function getYieldChannel() {
  if (_yieldChannel) return _yieldChannel;
  if (typeof MessageChannel !== 'function') return null;
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const resolve = _yieldResolvers.shift();
    if (resolve) resolve();
  };
  // Some environments require start() before messages flow.
  channel.port1.start?.();
  _yieldChannel = channel;
  return channel;
}

/**
 * Yields control back to the browser event loop without being throttled when
 * the tab is in the background. Prevents UI freeze during long-running pipeline
 * operations and keeps inference running at full speed in hidden tabs.
 *
 * Uses MessageChannel (not subject to background-tab timer clamping) when
 * available, falling back to setTimeout in non-browser environments.
 *
 * @returns {Promise<void>}
 */
export function yieldToBrowser() {
  const channel = getYieldChannel();
  if (channel) {
    return new Promise((resolve) => {
      _yieldResolvers.push(resolve);
      channel.port2.postMessage(0);
    });
  }
  // Fallback for environments without MessageChannel (e.g. some test runners).
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Formats a pipeline error into a consistent, context-rich message string.
 *
 * Output format:
 *   [ModuleName] stage: message (page N) [recoverable]
 *   [ModuleName] stage: message [non-recoverable]
 *
 * @param {object} err - Error descriptor object
 * @param {string} err.stage - Pipeline stage name (e.g. 'layout', 'formula', 'ocr', 'table')
 * @param {string} err.module - Module name that produced the error
 * @param {string} err.message - Error message text
 * @param {number} [err.pageIndex] - Page index where the error occurred (optional)
 * @param {boolean} err.recoverable - Whether the pipeline can continue after this error
 * @returns {string} Formatted error message
 */
export function formatPipelineError({ stage, module, message, pageIndex, recoverable }) {
  const parts = [`[${module || 'Unknown'}]`];

  if (stage) {
    parts.push(`${stage}:`);
  }

  if (message) {
    parts.push(message);
  }

  if (pageIndex != null) {
    parts.push(`(page ${pageIndex})`);
  }

  parts.push(recoverable ? '[recoverable]' : '[non-recoverable]');

  return parts.join(' ');
}
