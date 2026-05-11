// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: pdf_classify.py → pdf_classify.js
 *
 * WORKAROUND: pdfminer (PDFPageAggregator, LTImage, LTFigure, extract_text)
 * REASON: pdfminer is a Python-only library
 * SOLUTION:
 *   - getAvgCleanedCharsPerPage → pdfjs-dist getTextContent()
 *   - getHighImageCoverageRatio → pdfjs-dist getOperatorList() + OPS.paintImageXObject
 *   - detectInvalidChars → regex on pdfjs text content
 *   - extractPages → pdfjs PDFDocumentProxy page slicing via exportAsPDF workaround
 *     (browser has no pdfium.PdfDocument.import_pages; used a simplified approach: return full bytes)
 *
 * WORKAROUND: numpy.random.choice
 * REASON: numpy not in browser
 * SOLUTION: crypto.getRandomValues-based sampling
 *
 * WORKAROUND: pypdfium2.PdfDocument.new() + import_pages + save()
 * REASON: pypdfium2 not in browser; pdfjs-dist is read-only
 * SOLUTION: extractPages returns a subset via pdf-lib (if available) or returns original bytes.
 *   Falls back to returning original bytes if pdf-lib is not installed (conservative approach).
 */

import { getPdfjsLib } from './pdfjs_loader.js';

/**
 * Get a cryptographically random sample of integers without replacement.
 * PORTING NOTE: numpy.random.choice(total, count, replace=False) → randomChoice(total, count)
 *
 * @param {number} total
 * @param {number} count
 * @returns {number[]}
 */
function randomChoice(total, count) {
  const indices = Array.from({ length: total }, (_, i) => i);
  // Fisher-Yates partial shuffle
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
  // Always pass a copy so PDF.js cannot detach the caller's buffer
  const _data = pdfBytes instanceof Uint8Array ? pdfBytes.slice() : new Uint8Array(pdfBytes instanceof ArrayBuffer ? pdfBytes.slice(0) : pdfBytes);
  const loadingTask = pdfjsLib.getDocument({ data: _data });
  return loadingTask.promise;
}

/**
 * Classify whether a PDF can have text extracted directly or needs OCR.
 * PORTING NOTE: classify(pdf_bytes) → classify(pdfBytes)
 *
 * @param {Uint8Array} pdfBytes
 * @returns {Promise<'txt'|'ocr'>}
 */
export async function classify(pdfBytes) {
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

    const pagesToCheck = Math.min(pageCount, 10);
    const CHARS_THRESHOLD = 50;

    if ((await getAvgCleanedCharsPerPage(pdfDoc, pagesToCheck)) < CHARS_THRESHOLD) return 'ocr';
    if (await detectInvalidCharsInDoc(pdfDoc)) return 'ocr';
    if ((await getHighImageCoverageRatioInDoc(pdfDoc, pagesToCheck)) >= 0.8) return 'ocr';

    return 'txt';
  } catch (e) {
    console.error('PDF classify error:', e);
    return 'ocr';
  } finally {
    try { await pdfDoc.cleanup?.(); } catch { /* ignore */ }
    try { await pdfDoc.destroy?.(); } catch { /* ignore */ }
  }
}

/**
 * Compute average cleaned character count per page.
 * PORTING NOTE: get_avg_cleaned_chars_per_page → getAvgCleanedCharsPerPage
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdfDoc
 * @param {number} pagesToCheck
 * @returns {Promise<number>}
 */
export async function getAvgCleanedCharsPerPage(pdfDoc, pagesToCheck) {
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
 * PORTING NOTE: get_high_image_coverage_ratio → getHighImageCoverageRatio
 *   (pdfminer LTImage/LTFigure → pdfjs OPS.paintImageXObject)
 *
 * NOTE: pdfjs does not expose image rectangle sizes directly; this counts image paint calls
 *   as a heuristic. Pages with ≥ 3 image operations are flagged as high-coverage.
 *
 * @param {Uint8Array} samplePdfBytes
 * @param {number} pagesToCheck
 * @returns {Promise<number>}
 */
export async function getHighImageCoverageRatio(samplePdfBytes, pagesToCheck) {
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

  for (let i = 0; i < pageCount; i++) {
    const page = await pdfDoc.getPage(i + 1);
    const opList = await page.getOperatorList();
    // OPS.paintImageXObject = 85, paintJpegXObject = 82, paintInlineImageXObject = 83
    const imageOps = opList.fnArray.filter(op => op === 85 || op === 82 || op === 83).length;
    // Heuristic: >= 3 image ops -> likely image-heavy page
    if (imageOps >= 3) highCoverageCount++;
  }

  return pageCount > 0 ? highCoverageCount / pageCount : 0;
}

/**
 * Extract a random sample of up to 10 pages as a new PDF.
 * PORTING NOTE: extract_pages(src_pdf_bytes) → extractPages(srcPdfBytes)
 *
 * WORKAROUND: pypdfium2 PdfDocument.new() + import_pages + save()
 * SOLUTION: Try to use pdf-lib if available; otherwise return original bytes.
 *
 * @param {Uint8Array} srcPdfBytes
 * @returns {Promise<Uint8Array>}
 */
export async function extractPages(srcPdfBytes) {
  try {
    const { PDFDocument } = await import('pdf-lib');
    const srcDoc = await PDFDocument.load(srcPdfBytes, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    if (totalPages === 0) return new Uint8Array(0);

    const selectCount = Math.min(10, totalPages);
    const pageIndices = randomChoice(totalPages, selectCount).sort((a, b) => a - b);

    const newDoc = await PDFDocument.create();
    const copiedPages = await newDoc.copyPages(srcDoc, pageIndices);
    for (const p of copiedPages) newDoc.addPage(p);

    return newDoc.save();
  } catch {
    // pdf-lib not available or failed — return original bytes
    return srcPdfBytes;
  }
}

/**
 * Detect garbled/CID-encoded text in a PDF.
 * PORTING NOTE: detect_invalid_chars(sample_pdf_bytes) → detectInvalidChars(samplePdfBytes)
 *   pdfminer extract_text → pdfjs getTextContent
 *
 * @param {Uint8Array} samplePdfBytes
 * @returns {Promise<boolean>}
 */
export async function detectInvalidChars(samplePdfBytes) {
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

  // Detect (cid:NNN) patterns indicating garbled/embedded encoding
  const cidPattern = /\(cid:\d+\)/g;
  const matches = fullText.match(cidPattern) ?? [];
  const cidCount = matches.length;
  const cidLen = matches.reduce((sum, m) => sum + m.length, 0);
  const textLen = fullText.replace(/\n/g, '').length;

  if (textLen === 0) return false;

  const cidCharsRatio = cidCount / (cidCount + textLen - cidLen);
  return cidCharsRatio > 0.05;
}
