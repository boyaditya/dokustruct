/**
 * ui/perf/rafCoalescer.js
 *
 * Usage:
 *   const coalesced = createRafCoalescer(() => renderLayoutOverlay());
 *   // Call as many times as you like; only one rAF fires per frame.
 *   element.addEventListener('mousemove', coalesced.schedule);
 *   // Cancel pending frame:
 *   coalesced.cancel();
 */

/**
 * @typedef {{ schedule: () => void, cancel: () => void, flush: () => void }} RafCoalescer
 */

/**
 * Create a rAF coalescer that ensures `fn` runs at most once per animation frame.
 *
 * @param {() => void} fn - The function to coalesce.
 * @returns {RafCoalescer}
 */
export function createRafCoalescer(fn) {
  let frameId = null;

  function schedule() {
    if (frameId !== null) return; // already queued
    frameId = requestAnimationFrame(() => {
      frameId = null;
      fn();
    });
  }

  function cancel() {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
  }

  /** Run immediately and cancel any pending frame. */
  function flush() {
    cancel();
    fn();
  }

  return { schedule, cancel, flush };
}
