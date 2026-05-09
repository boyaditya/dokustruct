/**
 * rapid_doc/cli/common.js
 * PORTING NOTE: cli/common.py → cli/common.js (browser stubs)
 *
 * WORKAROUND: pypdfium2 / filesystem operations → browser equivalents or stubs
 * REASON: CLI utilities are not applicable in the browser.
 * SOLUTION: PDF slicing uses pdf-lib; filesystem operations remain no-op stubs.
 */

import { getEndPageId } from '../utils/pdf_page_id.js';

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input || []);
}

/**
 * Convert PDF bytes using pdf-lib page slicing (browser port of pypdfium2).
 * PORTING NOTE: convert_pdf_bytes_to_bytes_by_pypdfium2
 * @param {Uint8Array|ArrayBuffer|{pdf_bytes: Uint8Array|ArrayBuffer, original_image?: any}} pdfBytes
 * @param {number} [startPageId=0]
 * @param {number|null} [endPageId=null]
 * @returns {Promise<Uint8Array|{pdf_bytes: Uint8Array, original_image?: any}>}
 */
export async function convertPdfBytesToBytesByPypdfium2(pdfBytes, startPageId = 0, endPageId = null) {
  let originalImage = null;
  let bytesInput = pdfBytes;

  if (pdfBytes && typeof pdfBytes === 'object' && 'pdf_bytes' in pdfBytes) {
    originalImage = pdfBytes.original_image ?? null;
    bytesInput = pdfBytes.pdf_bytes;
  }

  const bytes = toUint8Array(bytesInput);
  try {
    const { PDFDocument } = await import('pdf-lib');
    const srcDoc = await PDFDocument.load(bytes);
    const totalPages = srcDoc.getPageCount();

    const start = Math.max(0, Number(startPageId || 0));
    const end = getEndPageId(endPageId, totalPages);
    const pageIndices = [];
    for (let i = start; i <= end; i++) pageIndices.push(i);

    const outDoc = await PDFDocument.create();
    const pages = await outDoc.copyPages(srcDoc, pageIndices);
    for (const page of pages) outDoc.addPage(page);

    const outBytes = await outDoc.save();
    if (originalImage != null) {
      return { pdf_bytes: outBytes, original_image: originalImage };
    }
    return outBytes;
  } catch (e) {
    console.warn(`[convertPdfBytesToBytesByPypdfium2] fallback to original bytes: ${e}`);
    return originalImage != null ? { pdf_bytes: bytes, original_image: originalImage } : bytes;
  }
}

/**
 * Convert PDF bytes by page batch (browser port of pypdfium2).
 * PORTING NOTE: convert_pdf_to_bytes_by_pypdfium2
 * @param {Uint8Array|ArrayBuffer|{pdf_bytes: Uint8Array|ArrayBuffer, original_image?: any}} pdfBytes
 * @param {number} [startPageId=0]
 * @param {number|null} [endPageId=null]
 * @param {number} [pdfPagesBatch=0]
 * @returns {Promise<[Uint8Array|{pdf_bytes: Uint8Array, original_image?: any}, boolean]>}
 */
export async function convertPdfToBytesByPypdfium2(
  pdfBytes,
  startPageId = 0,
  endPageId = null,
  pdfPagesBatch = 0,
) {
  let originalImage = null;
  let bytesInput = pdfBytes;

  if (pdfBytes && typeof pdfBytes === 'object' && 'pdf_bytes' in pdfBytes) {
    originalImage = pdfBytes.original_image ?? null;
    bytesInput = pdfBytes.pdf_bytes;
  }

  const bytes = toUint8Array(bytesInput);
  let fileEnd = false;

  try {
    const { PDFDocument } = await import('pdf-lib');
    const srcDoc = await PDFDocument.load(bytes);
    const totalPages = srcDoc.getPageCount();

    if (totalPages === 0) {
      const emptyBytes = new Uint8Array();
      return [
        originalImage != null ? { pdf_bytes: emptyBytes, original_image: originalImage } : emptyBytes,
        true,
      ];
    }

    let start = Number(startPageId || 0);
    if (start < 0) start = 0;

    let end;
    if (pdfPagesBatch > 0) {
      end = start + pdfPagesBatch - 1;
    } else {
      end = (endPageId != null && endPageId >= 0) ? endPageId : totalPages - 1;
    }

    if (end > totalPages - 1) {
      end = totalPages - 1;
      fileEnd = true;
    } else if (end === totalPages - 1) {
      fileEnd = true;
    }

    const pageIndices = [];
    for (let i = start; i <= end; i++) pageIndices.push(i);

    const outDoc = await PDFDocument.create();
    const pages = await outDoc.copyPages(srcDoc, pageIndices);
    for (const page of pages) outDoc.addPage(page);

    const outBytes = await outDoc.save();
    return [
      originalImage != null ? { pdf_bytes: outBytes, original_image: originalImage } : outBytes,
      fileEnd,
    ];
  } catch (e) {
    console.warn(`[convertPdfToBytesByPypdfium2] error, returning empty bytes: ${e}`);
    const emptyBytes = new Uint8Array();
    return [
      originalImage != null ? { pdf_bytes: emptyBytes, original_image: originalImage } : emptyBytes,
      true,
    ];
  }
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
