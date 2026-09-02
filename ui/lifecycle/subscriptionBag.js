/**
 * ui/lifecycle/subscriptionBag.js
 *
 * Wraps appState.subscribe / subscribeAll / subscribeImmediate calls and
 * provides a single dispose that unsubscribes all of them.
 *
 * Usage:
 *   const bag = createSubscriptionBag('linking');
 *   bag.subscribe(appState, 'results', onResults);
 *   bag.subscribeAll(appState, onAnyChange);
 *   // On teardown:
 *   bag.dispose();
 */

/**
 * @typedef {{
 *   subscribe: (state: import('../state/appState.js').AppState, key: string, cb: Function) => void,
 *   subscribeAll: (state: import('../state/appState.js').AppState, cb: Function) => void,
 *   subscribeImmediate: (state: import('../state/appState.js').AppState, key: string, cb: Function) => void,
 *   dispose: () => void,
 *   size: number
 * }} SubscriptionBag
 */

/**
 * Create a subscription bag that tracks all appState subscriptions.
 *
 * @param {string} label - Debug label.
 * @returns {SubscriptionBag}
 */
export function createSubscriptionBag(label = 'unnamed') {
  /** @type {Array<() => void>} */
  const unsubs = [];

  return {
    /**
     * Subscribe to a specific state key.
     * @param {import('../state/appState.js').AppState} state
     * @param {string} key
     * @param {Function} cb
     */
    subscribe(state, key, cb) {
      const unsub = state.subscribe(key, cb);
      unsubs.push(unsub);
    },

    /**
     * Subscribe to all state changes.
     * @param {import('../state/appState.js').AppState} state
     * @param {Function} cb
     */
    subscribeAll(state, cb) {
      const unsub = state.subscribeAll(cb);
      unsubs.push(unsub);
    },

    /**
     * Subscribe and immediately invoke with current value.
     * @param {import('../state/appState.js').AppState} state
     * @param {string} key
     * @param {Function} cb
     */
    subscribeImmediate(state, key, cb) {
      const unsub = state.subscribeImmediate(key, cb);
      unsubs.push(unsub);
    },

    /**
     * Unsubscribe all tracked subscriptions.
     */
    dispose() {
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch (err) {
          console.warn(`[SubscriptionBag:${label}] Unsubscribe threw:`, err);
        }
      }
      unsubs.length = 0;
    },

    /** Number of currently tracked subscriptions. */
    get size() {
      return unsubs.length;
    },
  };
}
