/**
 * ui/render/actions.js
 *
 * Wraps each rendered markdown block in a .block-shell div and appends a
 * copy-action button. Also exports the block-classification helpers used by
 * the linker (isMediaOutputBlock, isStandaloneDisplayFormulaBlock,
 * hoistDisplayFormulaPlaceholders, extractBlockLinkText, blockHasFormula).

 */

/**
 * @typedef {{
 *   markdownContent: Element|null,
 *   normalizeLayoutText: (value: any) => string,
 *   refreshIcons: () => void,
 * }} ActionsRenderContext
 */

/** @type {ActionsRenderContext} */
const _ctx = {
  markdownContent: null,
  normalizeLayoutText: (value) => String(value ?? '').replace(/\s+/g, ' ').trim(),
  refreshIcons: () => {},
};

/**
 * Wire the actions render context. Called once from app.js init.
 * @param {ActionsRenderContext} ctx
 */
export function initActionsRenderer(ctx) {
  const descriptors = Object.getOwnPropertyDescriptors(ctx);
  Object.defineProperties(_ctx, descriptors);
}

// ── Block classification helpers ──────────────────────────────────────────────

/**
 * Returns true when the block's primary content is a media element (image,
 * table, figure) rather than text. KaTeX SVG subtrees are excluded so that
 * pure formula blocks are not mis-tagged as media.
 *
 * @param {Element|null} block
 * @returns {boolean}
 */
export function isMediaOutputBlock(block) {
  if (!block) return false;
  const tagName = String(block.tagName || '').toLowerCase();
  if (tagName === 'figure' || tagName === 'table') return true;
  const media = block.querySelector?.('img, picture, canvas, svg');
  if (!media) return false;
  if (media.closest?.('.katex, [data-formula-source], .katex-display-placeholder, .katex-inline-placeholder')) {
    return false;
  }
  return true;
}

/**
 * Returns true when the block is a standalone display-formula element.
 * Covers the image path (placeholder is itself the block) AND the PDF path
 * (marked emits a `<p>` whose only meaningful child is the display placeholder,
 * possibly with stray whitespace text nodes).
 *
 * @param {Element|null} block
 * @returns {boolean}
 */
export function isStandaloneDisplayFormulaBlock(block) {
  if (!block) return false;
  if (block.classList?.contains('katex-display-placeholder')) return true;
  const displays = block.querySelectorAll?.('.katex-display-placeholder');
  if (!displays || displays.length === 0) return false;
  let elementChildCount = 0;
  let onlyChildIsDisplay = false;
  let hasNonWhitespaceText = false;
  for (const node of block.childNodes) {
    if (node.nodeType === 3) {
      if (node.nodeValue && node.nodeValue.trim().length > 0) hasNonWhitespaceText = true;
      continue;
    }
    if (node.nodeType !== 1) continue;
    elementChildCount += 1;
    if (elementChildCount === 1) {
      onlyChildIsDisplay = node.classList?.contains?.('katex-display-placeholder')
        || (node.children?.length === 1 && node.firstElementChild?.classList?.contains?.('katex-display-placeholder'));
    }
  }
  return elementChildCount === 1 && onlyChildIsDisplay && !hasNonWhitespaceText;
}

/**
 * Returns true when the block contains any formula placeholder element.
 *
 * @param {Element|null} block
 * @returns {boolean}
 */
export function blockHasFormula(block) {
  return Boolean(
    block?.querySelector?.('[data-formula-source]') ||
    block?.classList?.contains?.('katex-display-placeholder'),
  );
}

/**
 * Extract link-comparison text from a rendered markdown block, substituting
 * KaTeX placeholders with their original LaTeX source so the scorer can match
 * middle-json paragraphs (which carry bare LaTeX - no surrounding $...$/$$...$$
 * wrappers, per pipelineAdapter.extractLayoutLabelBlocks).
 *
 * Apply formula-link styling.
 *
 * @param {Element|null} block
 * @returns {string}
 */
export function extractBlockLinkText(block) {
  if (!block) return '';
  // Standalone display formula block - use the source LaTeX directly.
  if (block.classList?.contains('katex-display-placeholder')) {
    const src = block.getAttribute?.('data-formula-source') || '';
    return _ctx.normalizeLayoutText(src);
  }
  const placeholders = block.querySelectorAll?.('[data-formula-source]');
  if (!placeholders || placeholders.length === 0) {
    return _ctx.normalizeLayoutText(block.textContent);
  }
  // Clone to avoid mutating live DOM; replace each placeholder with its bare source LaTeX text node.
  const clone = block.cloneNode(true);
  clone.querySelectorAll('[data-formula-source]').forEach((node) => {
    const src = node.getAttribute('data-formula-source') || '';
    node.replaceWith(document.createTextNode(src));
  });
  return _ctx.normalizeLayoutText(clone.textContent);
}

/**
 * Lift each display-math placeholder out of any inline wrapper so it can
 * render as a true block-level element. Repeats inside the wrapper produce
 * multiple hoisted blocks in original order. The original wrapper stays in
 * place (now possibly empty or with surrounding text); attachBlockActions
 * then wraps each new block separately.
 *
 * Center standalone display-math shells.
 *
 * @param {Element|null} root
 */
export function hoistDisplayFormulaPlaceholders(root) {
  if (!root) return;
  const placeholders = Array.from(root.querySelectorAll('.katex-display-placeholder'));
  for (const node of placeholders) {
    let parent = node.parentElement;
    // Walk up while parent is an inline wrapper that's not the markdown root and not already
    // a block-friendly container. <p> is the typical case; <span> / <em> / <strong> too.
    while (
      parent
      && parent !== root
      && /^(p|span|em|strong|i|b|u|s|small|sub|sup)$/i.test(parent.tagName)
    ) {
      // Split parent so the placeholder becomes a sibling of the parent.
      // After split: [parent_with_before, placeholder, parent_with_after]
      const before = parent.cloneNode(false);
      const after = parent.cloneNode(false);
      let cursor = parent.firstChild;
      let beforePhase = true;
      while (cursor) {
        const next = cursor.nextSibling;
        if (cursor === node) {
          beforePhase = false;
        } else if (beforePhase) {
          before.appendChild(cursor);
        } else {
          after.appendChild(cursor);
        }
        cursor = next;
      }
      const grandparent = parent.parentElement;
      if (!grandparent) break;
      // Insert before, placeholder, after where parent used to be.
      if (before.childNodes.length > 0) grandparent.insertBefore(before, parent);
      grandparent.insertBefore(node, parent);
      if (after.childNodes.length > 0) grandparent.insertBefore(after, parent);
      grandparent.removeChild(parent);
      parent = grandparent;
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Wrap each rendered markdown block in a .block-shell div and append a
 * copy-action button bar. Idempotent - blocks already inside a .block-shell
 * are skipped.
 *
 * : every content block must be actionable (copy).
 */
export function attachBlockActions() {
  const mc = _ctx.markdownContent;
  if (!mc) return;

  // each <li> becomes its own shell - the pipeline's
  // content_list emits one TEXT entry per list line, so each list item must
  // carry its own data-link-id. Wrapping the whole <ol>/<ul> as a single
  // shell made one candidate consume an entire list and shifted every
  // following block's link by N-1.
  const blocks = mc.querySelectorAll(
    'p, h1, h2, h3, h4, h5, h6, table, figure, pre, blockquote, li, div.katex-display-placeholder',
  );

  blocks.forEach((block) => {
    if (block.closest('.block-shell')) return;

    // <li> is handled itself; other elements nested inside a list belong to
    // their li's shell - wrapping them separately would create extra shells
    // and shift links.
    const tag = String(block.tagName || '').toLowerCase();
    if (tag !== 'li' && block.closest('li')) return;

    const shell = document.createElement('div');
    shell.className = 'block-shell';

    if (isMediaOutputBlock(block)) {
      shell.classList.add('block-shell--media');
    }

    if (isStandaloneDisplayFormulaBlock(block)) {
      shell.classList.add('block-shell--formula');
      shell.classList.add('block-shell--display-formula');
    }

    block.parentNode.insertBefore(shell, block);
    shell.appendChild(block);

    const actions = document.createElement('div');
    actions.className = 'block-action-bar';
    actions.innerHTML = `
      <button type="button" data-action="copy" title="Copy block"><i data-lucide="copy"></i></button>
    `;
    shell.appendChild(actions);
  });

  _ctx.refreshIcons();
}
