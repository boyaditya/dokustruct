/**
 * ui/render/styling.js
 *
 * Applies CSS classes and data attributes to rendered markdown elements based on
 * the layout model's original_label values. Off-viewport blocks are deferred via
 * scheduleIdleWork. Reads before writes.
 */

import { scheduleIdleWork } from '../perf/idleScheduler.js';

/**
 * @typedef {{
 *   markdownContent: Element|null,
 *   getResults: () => any,
 *   extractBlockLinkText: (block: Element) => string,
 *   normalizeLayoutText: (value: any) => string,
 *   labelGroupKey: (originalLabel: string|null, blockType: string|null) => string,
 *   UI_LOG_PREFIX: string,
 * }} StylingRenderContext
 */

/** @type {StylingRenderContext} */
const _ctx = {
  markdownContent: null,
  getResults: () => null,
  extractBlockLinkText: (block) => block?.textContent || '',
  normalizeLayoutText: (value) => String(value ?? '').replace(/\s+/g, ' ').trim(),
  labelGroupKey: () => 'text',
  UI_LOG_PREFIX: '[DokuStruct UI]',
};

/**
 * Wire the styling render context. Called once from app.js init.
 * @param {StylingRenderContext} ctx
 */
export function initStylingRenderer(ctx) {
  const descriptors = Object.getOwnPropertyDescriptors(ctx);
  Object.defineProperties(_ctx, descriptors);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function centerAlignVisuals() {
  const mc = _ctx.markdownContent;
  if (!mc) return;

  // Center align all images
  const images = mc.querySelectorAll('img');
  images.forEach(img => {
    if (img.parentElement.tagName === 'P') {
      img.parentElement.style.textAlign = 'center';
    }
  });

  mc.querySelectorAll('table').forEach(table => {
    table.style.marginLeft = '';
    table.style.marginRight = '';
  });
}

function applyLabelClass(elem, labelInfo) {
  const ol = labelInfo.originalLabel;
  if (ol === 'paragraph_title' || ol === 'doc_title') {
    elem.classList.add('layout-title');
  } else if (
    ol === 'text' ||
    ol === 'content' ||
    ol === 'abstract' ||
    ol === 'reference' ||
    ol === 'reference_content'
  ) {
    elem.classList.add('layout-text');
  } else if (
    ol === 'figure_title' ||
    ol === 'chart_title' ||
    ol === 'image_caption'
  ) {
    elem.classList.add('layout-figure-caption');
  } else if (ol === 'table_title' || ol === 'table_caption') {
    elem.classList.add('layout-table-caption');
  }
}

function buildLayoutLabelMap(results) {
  const layoutLabelMap = new Map();

  if (Array.isArray(results.layout_label_blocks) && results.layout_label_blocks.length) {
    results.layout_label_blocks.forEach((item) => {
      const text = _ctx.normalizeLayoutText(item?.text);
      if (!text) return;
      layoutLabelMap.set(text, {
        originalLabel: item.originalLabel ?? item.original_label ?? null,
        blockType: item.blockType ?? item.block_type ?? null,
      });
    });
    return { map: layoutLabelMap, sourceData: null };
  }

  let sourceData = null;
  if (results.middle_json && results.middle_json.pdf_info) {
    sourceData = results.middle_json.pdf_info;
  } else if (results.model_output) {
    sourceData = results.model_output;
  }

  return { map: layoutLabelMap, sourceData };
}

function populateMapFromSourceData(layoutLabelMap, sourceData) {
  if (!Array.isArray(sourceData)) return;
  sourceData.forEach((page) => {
    if (page.preproc_blocks && Array.isArray(page.preproc_blocks)) {
      page.preproc_blocks.forEach((block) => {
        const originalLabel = block.original_label;
        const blockType = block.type;
        let fullBlockText = '';
        if (block.lines && Array.isArray(block.lines)) {
          block.lines.forEach((line) => {
            if (line.spans && Array.isArray(line.spans)) {
              line.spans.forEach((span) => {
                if (span.content) fullBlockText += span.content + ' ';
              });
            }
          });
        }
        fullBlockText = _ctx.normalizeLayoutText(fullBlockText);
        if (fullBlockText) {
          layoutLabelMap.set(fullBlockText, { originalLabel, blockType });
        }
      });
    }
    // layout_dets do not include text content directly - skip.
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Apply layout-model-derived CSS classes and data attributes to rendered markdown.
 * Off-viewport elements are deferred via scheduleIdleWork.
 */
export function applyLayoutBasedStyling() {
  const mc = _ctx.markdownContent;
  if (!mc) return;

  const results = _ctx.getResults();
  if (!results) {
    console.warn(`${_ctx.UI_LOG_PREFIX} No results available for layout-based styling`);
    return;
  }

  const { map: layoutLabelMap, sourceData } = buildLayoutLabelMap(results);

  if (sourceData !== null) {
    populateMapFromSourceData(layoutLabelMap, sourceData);
  }

  if (layoutLabelMap.size === 0) {
    // Image-only pages (tables, figures with no text spans) legitimately produce
    // an empty layout map - this is expected, not an error.
    console.info(
      `${_ctx.UI_LOG_PREFIX} No text content found in layout data - page may be image-only. Skipping text-based styling.`,
    );
    centerAlignVisuals();
    return;
  }

  // Read phase: collect all elements and their text
  const allElements = Array.from(mc.querySelectorAll('p, h1, h2, h3, h4, h5, h6'));

  // Partition into in-viewport (apply now) and off-viewport (defer)
  const viewportBottom = window.scrollY + window.innerHeight + 200;

  const applyToElement = (elem) => {
    const text = _ctx.extractBlockLinkText(elem);
    if (!layoutLabelMap.has(text)) return;
    const labelInfo = layoutLabelMap.get(text);
    elem.setAttribute('data-original-label', labelInfo.originalLabel);
    elem.setAttribute('data-block-type', labelInfo.blockType);
    applyLabelClass(elem, labelInfo);
  };

  const deferred = [];
  allElements.forEach((elem) => {
    const rect = elem.getBoundingClientRect();
    const absTop = rect.top + window.scrollY;
    if (absTop <= viewportBottom) {
      applyToElement(elem);
    } else {
      deferred.push(elem);
    }
  });

  // Defer off-viewport blocks
  if (deferred.length > 0) {
    scheduleIdleWork(() => {
      deferred.forEach(applyToElement);
    }, { timeout: 500 });
  }

  centerAlignVisuals();
}
