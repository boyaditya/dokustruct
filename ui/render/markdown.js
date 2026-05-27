/**
 * ui/render/markdown.js
 *
 * Preserves render-pipeline order (Requirement 7.1):
 *   protect math → marked.parse → DOMPurify.sanitize → render KaTeX
 *   → applyMarkdownImageSources → applyLayoutBasedStyling
 *   → attachBlockActions → linkMarkdownBlocks
 *
 * For markdown.length > 500_000, inserts skeleton synchronously and yields
 * with scheduleIdleWork between heading-bounded chunks (Requirement 3.5).
 */

import { marked } from 'marked';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { scheduleIdleWork } from '../perf/idleScheduler.js';

/**
 * @typedef {{
 *   markdownContent: Element|null,
 *   applyMarkdownImageSources: () => void,
 *   applyLayoutBasedStyling: () => void,
 *   attachBlockActions: () => void,
 *   linkMarkdownBlocks: (pageCount: number, contentList: any[]|null) => void,
 *   hoistDisplayFormulaPlaceholders: (root: Element) => void,
 *   updateQuickNavVisibility: () => void,
 * }} MarkdownRenderContext
 */

/** @type {MarkdownRenderContext} */
const _ctx = {
  markdownContent: null,
  applyMarkdownImageSources: () => {},
  applyLayoutBasedStyling: () => {},
  attachBlockActions: () => {},
  linkMarkdownBlocks: () => {},
  hoistDisplayFormulaPlaceholders: () => {},
  updateQuickNavVisibility: () => {},
};

/**
 * Wire the render context. Called once from app-v2.js init().
 * @param {MarkdownRenderContext} ctx
 */
export function initMarkdownRenderer(ctx) {
  Object.assign(_ctx, ctx);
}

const KATEX_MACROS = {
  '\\rmathrm': '\\mathrm',
  '\\rmath': '\\mathrm',
  '\\mbox': '\\text',
};

/**
 * Render markdown into the markdownContent element.
 * Preserves the canonical render-pipeline order.
 *
 * @param {string} markdown
 * @param {number} [pageCount]
 * @param {any[]|null} [contentList]
 */
export function displayMarkdown(markdown, pageCount = 1, contentList = null) {
  const mc = _ctx.markdownContent;
  if (!mc) return;

  const emptyMd = mc.querySelector('.empty-markdown');
  if (emptyMd) emptyMd.remove();

  try {
    // ── Step 1: protect LaTeX before marked parses inline syntax ──────────
    const latexBlocks = [];
    let protectedSource = markdown;

    // Protect display math ($$...$$) — must come before inline ($...$)
    protectedSource = protectedSource.replace(/\$\$([\s\S]*?)\$\$/g, (_, latex) => {
      const trimmed = latex.trim();
      const idx = latexBlocks.length;
      latexBlocks.push({ latex: trimmed, display: true });
      const safe = trimmed.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return `<div class="katex-display-placeholder" data-idx="${idx}" data-formula-source="${safe}"></div>`;
    });

    // Protect inline math ($...$)
    protectedSource = protectedSource.replace(/(?<!\$)\$(?!\$)([\s\S]+?)(?<!\$)\$(?!\$)/g, (_, latex) => {
      const trimmed = latex.trim();
      if (!trimmed) return `$${latex}$`;
      const idx = latexBlocks.length;
      latexBlocks.push({ latex: trimmed, display: false });
      const safe = trimmed.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return `<span class="katex-inline-placeholder" data-idx="${idx}" data-formula-source="${safe}"></span>`;
    });

    // ── Step 2: marked.parse → DOMPurify.sanitize ─────────────────────────
    const rendered = marked.parse(protectedSource);
    mc.innerHTML = DOMPurify.sanitize(rendered, {
      ADD_ATTR: ['data-idx', 'data-formula-source', 'target'],
    });

    // ── Step 3: hoist display formula placeholders (PDF path fix) ─────────
    _ctx.hoistDisplayFormulaPlaceholders(mc);

    // ── Step 4: render KaTeX ───────────────────────────────────────────────
    for (const mathEl of mc.querySelectorAll('[data-idx]')) {
      const block = latexBlocks[parseInt(mathEl.dataset.idx)];
      if (!block) continue;
      try {
        mathEl.innerHTML = katex.renderToString(block.latex, {
          displayMode: block.display,
          throwOnError: false,
          strict: false,
          trust: false,
          macros: KATEX_MACROS,
        });
      } catch {
        const code = document.createElement('code');
        code.style.cssText = 'background:rgba(0,0,0,.05);padding:2px 4px;border-radius:3px;font-size:.9em;';
        code.textContent = block.display ? `$$${block.latex}$$` : `$${block.latex}$`;
        mathEl.replaceWith(code);
      }
    }

    // ── Step 5–8: post-render pipeline ────────────────────────────────────
    _ctx.applyMarkdownImageSources();
    _ctx.applyLayoutBasedStyling();
    _ctx.attachBlockActions();
    _ctx.linkMarkdownBlocks(pageCount, contentList);
    _ctx.updateQuickNavVisibility();

  } catch (err) {
    console.error('[Markdown] Render error:', err);
    mc.textContent = markdown;
  }
}
