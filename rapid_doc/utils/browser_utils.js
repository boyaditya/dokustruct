/**
 * Browser-specific utilities consolidated from multiple pipeline files.
 * Replaces duplicated yieldToBrowser in batch_analyze.js and pipeline_analyze.js.
 * Provides consistent error formatting for pipeline stages.
 */

// ─── Standard performance constants ──────────────────────────────────────────
// Standard desktop-tier values used uniformly across all devices.
// User-provided config always overrides these defaults (backward-compatible).

export const MAX_CONCURRENT_BATCHES = 5;
export const REC_BATCH_NUM = 6;
export const DPI_DOWNSCALE_THRESHOLD = 2200;
export const PDF_PAGES_BATCH = 4;

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
