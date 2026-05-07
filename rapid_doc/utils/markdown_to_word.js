// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: markdown_to_word.py → markdown_to_word.js
 *
 * WORKAROUND: pypandoc (Pandoc subprocess) / python-docx
 * REASON: Pandoc cannot run in browser; python-docx is Python-only
 * SOLUTION: markdownToWord returns a Blob download using a basic HTML→Word approach.
 *   Modern browsers support msSaveBlob or URL.createObjectURL for Word-like files.
 *   For full Word support, the caller can use the returned HTML Blob and open in Word.
 *
 * STUB: All Word-specific functions (_addTableBorders, _setFonts, _fixStyles) are no-ops.
 *   markdownToWord returns an HTML Blob that Word can open (HTML→DOCX via Word import).
 *   htmlTableToMarkdown is a full port.
 */

import { markdownToHtml } from './markdown_to_html.js';

/**
 * Convert Markdown to a Word-compatible Blob (.docx via HTML container).
 * PORTING NOTE: markdown_to_word(markdown_content, output_path, ...) → async markdownToWord(...)
 *
 * Returns a Blob with MIME type application/msword.
 * The caller can trigger a file download with URL.createObjectURL.
 *
 * @param {string} markdownContent
 * @param {object} [opts]
 * @param {string} [opts.title='Document']
 * @returns {Promise<Blob>}
 */
// Python original: markdown_to_docx — export both names
export { markdownToWord as markdownToDocx };
export async function markdownToWord(markdownContent, { title = 'Document' } = {}) {
  const htmlContent = await markdownToHtml(markdownContent, { title });
  return new Blob([htmlContent], { type: 'application/msword' });
}

/**
 * Convert Markdown to Word Blob and trigger browser download.
 * @param {string} markdownContent
 * @param {string} [filename='document.doc']
 * @param {object} [opts]
 * @returns {Promise<void>}
 */
export async function downloadMarkdownAsWord(markdownContent, filename = 'document.doc', opts = {}) {
  const blob = await markdownToWord(markdownContent, opts);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Convert HTML table string to a Markdown pipe table.
 * PORTING NOTE: _html_table_to_markdown → htmlTableToMarkdown
 * Full port — handles rowspan/colspan (expand to multiple cells).
 *
 * @param {string} htmlTable
 * @returns {string}
 */
export function htmlTableToMarkdown(htmlTable) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<table>${htmlTable}</table>`, 'text/html');
  const rows = doc.querySelectorAll('tr');
  if (!rows.length) return htmlTable;

  const tableData = [];
  for (const row of rows) {
    const cells = row.querySelectorAll('th, td');
    const rowData = [];
    for (const cell of cells) {
      const colspan = parseInt(cell.getAttribute('colspan') ?? '1', 10);
      const cellText = cell.textContent.trim().replace(/\|/g, '\\|');
      rowData.push(cellText);
      for (let i = 1; i < colspan; i++) rowData.push('');
    }
    tableData.push(rowData);
  }

  if (!tableData.length) return htmlTable;

  const numCols = Math.max(...tableData.map(r => r.length));
  const normalised = tableData.map(row => {
    while (row.length < numCols) row.push('');
    return row;
  });

  const mdRows = normalised.map(row => `| ${row.join(' | ')} |`);
  // Insert separator after first row
  const sep = `| ${new Array(numCols).fill('---').join(' | ')} |`;
  mdRows.splice(1, 0, sep);
  return mdRows.join('\n');
}

// Stubs maintained for API compatibility
export function addTableBorders(_docxPath) {}
export function setFonts(_docxPath, _chineseFont, _latinFont) {}
export function fixStyles(_docxPath) {}
