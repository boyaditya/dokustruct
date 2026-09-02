/**
 * ui/perf/layoutReadBatch.js
 *
 * Pattern: schedule(target, readFn) → readFn runs in the read phase, its return
 * value is passed to the write phase. flush executes all reads then all writes.
 *
 * Usage:
 *   const batch = createLayoutReadBatch();
 *   batch.schedule(el, () => el.getBoundingClientRect(), (rect) => {
 *     el.style.top = rect.top + 'px';
 *   });
 *   batch.flush(); // reads first, then writes
 */

/**
 * @typedef {{
 *   schedule: (target: Element, readFn: () => any, writeFn?: (readResult: any) => void) => void,
 *   flush: () => void,
 *   size: number
 * }} LayoutReadBatch
 */

/**
 * Create a layout-read batch that separates DOM reads from DOM writes.
 *
 * @returns {LayoutReadBatch}
 */
export function createLayoutReadBatch() {
  /** @type {Array<{ target: Element, readFn: () => any, writeFn?: (r: any) => void }>} */
  const pending = [];

  return {
    /**
     * Schedule a read + optional write pair.
     * @param {Element} target - The element being measured (for debug context only).
     * @param {() => any} readFn - Performs the layout read (getBoundingClientRect, offsetTop, etc.).
     * @param {(readResult: any) => void} [writeFn] - Performs the DOM write using the read result.
     */
    schedule(target, readFn, writeFn) {
      pending.push({ target, readFn, writeFn });
    },

    /**
     * Execute all reads first, then all writes.
     * Clears the queue after execution.
     */
    flush() {
      if (!pending.length) return;
      // Phase 1: reads
      const results = pending.map(({ readFn }) => {
        try { return readFn(); }
        catch (err) { console.warn('[LayoutReadBatch] Read threw:', err); return undefined; }
      });
      // Phase 2: writes
      pending.forEach(({ writeFn }, i) => {
        if (typeof writeFn !== 'function') return;
        try { writeFn(results[i]); }
        catch (err) { console.warn('[LayoutReadBatch] Write threw:', err); }
      });
      pending.length = 0;
    },

    get size() { return pending.length; },
  };
}
