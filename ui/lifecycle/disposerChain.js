/**
 * ui/lifecycle/disposerChain.js
 *
 * Usage:
 *   const chain = createDisposerChain('runPipeline');
 *   chain.add(() => pdfDoc.destroy());
 *   chain.add(() => URL.revokeObjectURL(url));
 *   // In finally block:
 *   await chain.runAll();
 */

/**
 * @typedef {{ add: (fn: () => any) => void, runAll: () => Promise<void>, size: number }} DisposerChain
 */

/**
 * Create a disposer chain that runs cleanup functions in reverse insertion order.
 * Each disposer is called inside try/finally so one failure does not skip the rest.
 *
 * @param {string} label - Debug label for console warnings.
 * @returns {DisposerChain}
 */
export function createDisposerChain(label = 'unnamed') {
  /** @type {Array<() => any>} */
  const disposers = [];

  return {
    /**
     * Register a cleanup function. Called in LIFO order by runAll.
     * @param {() => any} fn
     */
    add(fn) {
      if (typeof fn === 'function') disposers.push(fn);
    },

    /**
     * Run all registered disposers in reverse insertion order.
     * Errors are caught per-disposer and logged; execution continues.
     * @returns {Promise<void>}
     */
    async runAll() {
      // Reverse copy so original array is not mutated mid-run.
      const toRun = disposers.slice().reverse();
      disposers.length = 0; // prevent double-run
      for (const fn of toRun) {
        try {
          await fn();
        } catch (err) {
          console.warn(`[DisposerChain:${label}] Disposer threw:`, err);
        }
      }
    },

    /** Number of registered disposers not yet run. */
    get size() {
      return disposers.length;
    },
  };
}
