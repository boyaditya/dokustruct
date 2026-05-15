// Copyright (c) Opendatalab. All rights reserved.
/**
 * PDF classification: determines whether a PDF needs OCR or can use text extraction.
 *
 * Browser workarounds:
 * - pdfminer → pdfjs-dist getTextContent() / getOperatorList()
 * - numpy.random.choice → crypto.getRandomValues Fisher-Yates sampling
 * - pypdfium2 page extraction → pdf-lib
 */

import { getPdfjsLib } from './pdfjs_loader.js';

const CHARS_THRESHOLD = 50;
const HIGH_COVERAGE_IMAGE_OPS = 3;
const HIGH_COVERAGE_RATIO_THRESHOLD = 0.8;
const CID_RATIO_THRESHOLD = 0.05;
const MAX_SAMPLE_PAGES = 10;

/**
 * Get a cryptographically random sample of integers without replacement.
 *
 * @param {number} total
 * @param {number} count
 * @returns {number[]}
 */
function randomChoice(total, count) {
  const indices = Array.from({ length: total }, (_, i) => i);
  const rng = new Uint32Array(total);
  crypto.getRandomValues(rng);
  for (let i = total - 1; i > 0; i--) {
    const j = rng[i] % (i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, count);
}

/**
 * Load a pdfjs PDFDocumentProxy from bytes.
 * @param {Uint8Array} pdfBytes
 * @returns {Promise<import('pdfjs-dist').PDFDocumentProxy>}
 */
async function loadPdfDoc(pdfBytes) {
  const pdfjsLib = await getPdfjsLib();
  const _data = pdfBytes instanceof Uint8Array ? pdfBytes.slice() : new Uint8Array(pdfBytes instanceof ArrayBuffer ? pdfBytes.slice(0) : pdfBytes);
  const loadingTask = pdfjsLib.getDocument({ data: _data });
  return loadingTask.promise;
}

/**
 * Classify whether a PDF can have text extracted directly or needs OCR.
 *
 * @param {Uint8Array} pdfBytes
 * @returns {Promise<'txt'|'ocr'>}
 */
export async function classify(pdfBytes) {
  if (!pdfBytes || pdfBytes.length === 0) return 'ocr';

  let sampleBytes;
  try {
    sampleBytes = await extractPages(pdfBytes);
  } catch {
    sampleBytes = pdfBytes;
  }

  let pdfDoc;
  try {
    pdfDoc = await loadPdfDoc(sampleBytes);
  } catch {
    return 'ocr';
  }

  try {
    const pageCount = pdfDoc.numPages;
    if (pageCount === 0) return 'ocr';

    const pagesToCheck = Math.min(pageCount, MAX_SAMPLE_PAGES);

    if ((await getAvgCleanedCharsPerPage(pdfDoc, pagesToCheck)) < CHARS_THRESHOLD) return 'ocr';
    if (await detectInvalidCharsInDoc(pdfDoc)) return 'ocr';
    if ((await getHighImageCoverageRatioInDoc(pdfDoc, pagesToCheck)) >= HIGH_COVERAGE_RATIO_THRESHOLD) return 'ocr';

    return 'txt';
  } catch (e) {
    console.warn('[classify] PDF classification error:', e?.message ?? e);
    return 'ocr';
  } finally {
    try { await pdfDoc.cleanup?.(); } catch { /* ignore */ }
    try { await pdfDoc.destroy?.(); } catch { /* ignore */ }
  }
}

/**
 * Compute average cleaned character count per page.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDoc
 * @param {number} pagesToCheck
 * @returns {Promise<number>}
 */
export async function getAvgCleanedCharsPerPage(pdfDoc, pagesToCheck) {
  if (!pdfDoc || pagesToCheck <= 0) return 0;

  let cleanedTotal = 0;
  for (let i = 0; i < pagesToCheck; i++) {
    const page = await pdfDoc.getPage(i + 1);
    const textContent = await page.getTextContent();
    const text = textContent.items.map(item => item.str ?? '').join('');
    cleanedTotal += text.replace(/\s+/g, '').length;
  }
  return cleanedTotal / pagesToCheck;
}

/**
 * Estimate image coverage ratio using pdfjs operator list.
 * Pages with >= 3 image operations are flagged as high-coverage.
 *
 * @param {Uint8Array} samplePdfBytes
 * @param {number} pagesToCheck
 * @returns {Promise<number>}
 */
export async function getHighImageCoverageRatio(samplePdfBytes, pagesToCheck) {
  if (!samplePdfBytes) return 0;

  const pdfDoc = await loadPdfDoc(samplePdfBytes);
  try {
    return await getHighImageCoverageRatioInDoc(pdfDoc, pagesToCheck);
  } finally {
    try { await pdfDoc.cleanup?.(); } catch { /* ignore */ }
    try { await pdfDoc.destroy?.(); } catch { /* ignore */ }
  }
}

async function getHighImageCoverageRatioInDoc(pdfDoc, pagesToCheck) {
  let highCoverageCount = 0;
  const pageCount = Math.min(pdfDoc.numPages, pagesToCheck);
  if (pageCount === 0) return 0;

  for (let i = 0; i < pageCount; i++) {
    const page = await pdfDoc.getPage(i + 1);
    const opList = await page.getOperatorList();
    // OPS.paintImageXObject = 85, paintJpegXObject = 82, paintInlineImageXObject = 83
    const imageOps = opList.fnArray.filter(op => op === 85 || op === 82 || op === 83).length;
    if (imageOps >= HIGH_COVERAGE_IMAGE_OPS) highCoverageCount++;
  }

  return highCoverageCount / pageCount;
}

/**
 * Extract a random sample of up to 10 pages as a new PDF.
 * Uses pdf-lib if available; otherwise returns original bytes.
 *
 * @param {Uint8Array} srcPdfBytes
 * @returns {Promise<Uint8Array>}
 */
export async function extractPages(srcPdfBytes) {
  if (!srcPdfBytes || srcPdfBytes.length === 0) return new Uint8Array(0);

  try {
    const { PDFDocument } = await import('pdf-lib');
    const srcDoc = await PDFDocument.load(srcPdfBytes, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    if (totalPages === 0) return new Uint8Array(0);

    const selectCount = Math.min(MAX_SAMPLE_PAGES, totalPages);
    const pageIndices = randomChoice(totalPages, selectCount).sort((a, b) => a - b);

    const newDoc = await PDFDocument.create();
    const copiedPages = await newDoc.copyPages(srcDoc, pageIndices);
    for (const p of copiedPages) newDoc.addPage(p);

    return newDoc.save();
  } catch {
    return srcPdfBytes;
  }
}

/**
 * Detect garbled/CID-encoded text in a PDF.
 *
 * @param {Uint8Array} samplePdfBytes
 * @returns {Promise<boolean>}
 */
export async function detectInvalidChars(samplePdfBytes) {
  if (!samplePdfBytes) return false;

  let pdfDoc;
  try {
    pdfDoc = await loadPdfDoc(samplePdfBytes);
  } catch {
    return false;
  }

  try {
    return await detectInvalidCharsInDoc(pdfDoc);
  } finally {
    try { await pdfDoc.cleanup?.(); } catch { /* ignore */ }
    try { await pdfDoc.destroy?.(); } catch { /* ignore */ }
  }
}

async function detectInvalidCharsInDoc(pdfDoc) {
  let fullText = '';
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const textContent = await page.getTextContent();
    fullText += textContent.items.map(item => item.str ?? '').join('');
  }

  const cidPattern = /\(cid:\d+\)/g;
  const matches = fullText.match(cidPattern) ?? [];
  const cidCount = matches.length;
  const cidLen = matches.reduce((sum, m) => sum + m.length, 0);
  const textLen = fullText.replace(/\n/g, '').length;

  if (textLen === 0) return false;

  const cidCharsRatio = cidCount / (cidCount + textLen - cidLen);
  return cidCharsRatio > CID_RATIO_THRESHOLD;
}
