/**
 * rapid_doc/cli/common.js
 * PORTING NOTE: cli/common.py → cli/common.js (browser stubs)
 *
 * WORKAROUND: pypdfium2 / filesystem operations → no-op stubs
 * REASON: CLI utilities are not applicable in the browser.
 * SOLUTION: Export stub functions so engine imports resolve; real functionality
 *           is not needed for the browser pipeline.
 */

/**
 * Convert PDF bytes using pypdfium2 — no-op in browser.
 * PORTING NOTE: convert_pdf_bytes_to_bytes_by_pypdfium2 → browser returns input unchanged
 * @param {Uint8Array} pdfBytes
 * @returns {Uint8Array}
 */
export function convertPdfBytesToBytesByPypdfium2(pdfBytes) {
  return pdfBytes;
}

/**
 * Prepare output environment (create dirs, etc.) — no-op in browser.
 * PORTING NOTE: prepare_env(output_dir) → no-op
 * @param {string} _outputDir
 */
export function prepareEnv(_outputDir) {}

/**
 * Read file bytes — no-op stub in browser (files come from File API).
 * PORTING NOTE: read_fn(path) → returns null in browser
 * @param {string} _path
 * @returns {null}
 */
export function readFn(_path) {
  return null;
}
