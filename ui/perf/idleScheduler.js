/**
 * ui/perf/idleScheduler.js
 *
 * Uses requestIdleCallback when available; falls back to setTimeout(fn, 0).
 *
 * Usage:
 *   scheduleIdleWork(() => applyLayoutBasedStyling(), { timeout: 500 });
 */

/**
 * @typedef {{ timeout?: number }} IdleWorkOptions
 */

/**
 * Schedule a function to run during browser idle time.
 * Falls back to setTimeout when requestIdleCallback is unavailable.
 *
 * @param {(deadline?: IdleDeadline) => void} fn
 * @param {IdleWorkOptions} [opts]
 * @returns {number} Handle that can be passed to cancelIdleWork().
 */
export function scheduleIdleWork(fn, opts = {}) {
  if (typeof requestIdleCallback === 'function') {
    return requestIdleCallback(fn, opts);
  }
  // Fallback: use setTimeout with a small delay so it yields to the event loop.
  return /** @type {number} */ (setTimeout(() => fn(), opts.timeout ? Math.min(opts.timeout, 50) : 0));
}

/**
 * Cancel a previously scheduled idle work item.
 *
 * @param {number} handle
 */
export function cancelIdleWork(handle) {
  if (typeof cancelIdleCallback === 'function') {
    cancelIdleCallback(handle);
  } else {
    clearTimeout(handle);
  }
}
