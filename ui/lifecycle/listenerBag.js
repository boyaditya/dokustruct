/**
 * ui/lifecycle/listenerBag.js
 *
 * Prevents listener leaks by recording every registration and providing a
 * single dispose call that removes all of them.
 *
 * Usage:
 *   const bag = createListenerBag('linking');
 *   bag.add(el.pageStack, 'mouseover', handleHover);
 *   bag.add(document, 'click', handleOutsideClick, true);
 *   // On teardown:
 *   bag.dispose();
 */

/**
 * @typedef {{
 *   add: (target: EventTarget, type: string, handler: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => void,
 *   remove: (target: EventTarget, type: string, handler: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => void,
 *   dispose: () => void,
 *   size: number
 * }} ListenerBag
 */

/**
 * Create a listener bag that tracks all addEventListener calls and can remove them all at once.
 *
 * @param {string} label - Debug label.
 * @returns {ListenerBag}
 */
export function createListenerBag(label = 'unnamed') {
  /** @type {Array<{ target: EventTarget, type: string, handler: EventListenerOrEventListenerObject, options: boolean | AddEventListenerOptions | undefined }>} */
  const entries = [];

  return {
    /**
     * Add an event listener and track it for later removal.
     * @param {EventTarget} target
     * @param {string} type
     * @param {EventListenerOrEventListenerObject} handler
     * @param {boolean | AddEventListenerOptions} [options]
     */
    add(target, type, handler, options) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, handler, options);
      entries.push({ target, type, handler, options });
    },

    /**
     * Remove a specific listener and untrack it.
     * @param {EventTarget} target
     * @param {string} type
     * @param {EventListenerOrEventListenerObject} handler
     * @param {boolean | EventListenerOptions} [options]
     */
    remove(target, type, handler, options) {
      if (!target || typeof target.removeEventListener !== 'function') return;
      target.removeEventListener(type, handler, options);
      const idx = entries.findIndex(
        e => e.target === target && e.type === type && e.handler === handler,
      );
      if (idx >= 0) entries.splice(idx, 1);
    },

    /**
     * Remove all tracked listeners.
     */
    dispose() {
      for (const { target, type, handler, options } of entries) {
        try {
          target.removeEventListener(type, handler, options);
        } catch (err) {
          console.warn(`[ListenerBag:${label}] removeEventListener threw:`, err);
        }
      }
      entries.length = 0;
    },

    /** Number of currently tracked listeners. */
    get size() {
      return entries.length;
    },
  };
}
