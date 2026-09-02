/**
 * ui/perf/virtualization.js
 *
 * Hides off-viewport items by setting visibility:hidden + height placeholder so
 * the scroll container keeps its natural height. Items are revealed as they enter
 * the viewport.
 *
 * Threshold gating (per spec ):
 *   - History list: activate when item count > 50
 *   - Markdown blocks: activate when block count > 100
 *   - JSON viewer lines: activate when line count > 100
 *
 * Usage:
 *   const vlist = createVirtualList({
 *     container: el.fileList,
 *     threshold: 50,
 *     rootMargin: '200px',
 *   });
 *   vlist.observe(items); // items: NodeList or Array<Element>
 *   vlist.disconnect(); // cleanup
 */

/**
 * @typedef {{
 *   observe: (items: Element[] | NodeList) => void,
 *   disconnect: () => void
 * }} VirtualList
 */

/**
 * Create a virtual list using IntersectionObserver.
 *
 * @param {{
 *   container: Element,
 *   threshold?: number,
 *   rootMargin?: string,
 * }} opts
 * @returns {VirtualList}
 */
export function createVirtualList({ container, threshold = 50, rootMargin = '300px' }) {
  /** @type {IntersectionObserver | null} */
  let observer = null;
  /** @type {Set<Element>} */
  const observed = new Set();

  function onIntersect(entries) {
    for (const entry of entries) {
      const el = entry.target;
      if (entry.isIntersecting) {
        el.style.visibility = '';
        el.style.contentVisibility = '';
      } else {
        el.style.visibility = 'hidden';
        // content-visibility: auto is a stronger hint but not universally supported.
        if ('contentVisibility' in el.style) {
          el.style.contentVisibility = 'hidden';
        }
      }
    }
  }

  return {
    /**
     * Start observing a list of elements. Only activates when item count > threshold.
     * @param {Element[] | NodeList} items
     */
    observe(items) {
      const arr = Array.from(items);
      if (arr.length <= threshold) return; // below threshold — no virtualization

      if (!observer) {
        observer = new IntersectionObserver(onIntersect, {
          root: container,
          rootMargin,
          threshold: 0,
        });
      }

      for (const item of arr) {
        if (!observed.has(item)) {
          observer.observe(item);
          observed.add(item);
        }
      }
    },

    /**
     * Disconnect the observer and restore all items to visible.
     */
    disconnect() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      for (const item of observed) {
        item.style.visibility = '';
        item.style.contentVisibility = '';
      }
      observed.clear();
    },
  };
}
