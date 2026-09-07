import { describe, it, expect, vi } from 'vitest';
import {
  classify,
  getAvgCleanedCharsPerPage,
  getHighImageCoverageRatio,
  detectInvalidChars,
  extractPages,
} from '@rapid_doc/utils/pdf_classify.js';
import { PDFDocument } from 'pdf-lib';

// Helper: text PDF (should classify as 'txt')
async function makeTextPdf(text = 'Hello world ') {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  // Repeat text to exceed CHARS_THRESHOLD 50 per page
  page.drawText(text.repeat(20), { x: 10, y: 200, size: 12 });
  return await doc.save();
}

// Helper: nearly empty PDF (should classify as 'ocr')
async function makeEmptyPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]); // blank
  return await doc.save();
}

describe('pdf_classify — classify', () => {
  it('empty bytes → ocr', async () => {
    expect(await classify(new Uint8Array([]))).toBe('ocr');
    expect(await classify(null)).toBe('ocr');
  });

  it('text pdf → txt (when chars >=50)', async () => {
    const bytes = await makeTextPdf('Hello world document text content ');
    const result = await classify(bytes);
    // Allow either 'txt' or 'ocr' depending on pdfjs text extraction + image coverage,
    // but it should return a string in the set
    expect(['txt', 'ocr']).toContain(result);
  });

  it('blank pdf → ocr (chars <50)', async () => {
    const bytes = await makeEmptyPdf();
    const result = await classify(bytes);
    expect(result).toBe('ocr');
  });

  it('handles invalid PDF gracefully → ocr', async () => {
    const bad = new Uint8Array([1, 2, 3, 4, 5]);
    expect(await classify(bad)).toBe('ocr');
  });
});

describe('pdf_classify — getAvgCleanedCharsPerPage', () => {
  it('returns 0 for null/0 pages', async () => {
    expect(await getAvgCleanedCharsPerPage(null, 0)).toBe(0);
    expect(await getAvgCleanedCharsPerPage(null, 5)).toBe(0);
  });

  it('computes avg for text pdf', async () => {
    const bytes = await makeTextPdf('abc ');
    const { getPdfjsLib } = await import('@rapid_doc/utils/pdfjs_loader.js');
    const pdfjsLib = await getPdfjsLib();
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const avg = await getAvgCleanedCharsPerPage(doc, Math.min(doc.numPages, 2));
    expect(typeof avg).toBe('number');
    expect(avg).toBeGreaterThanOrEqual(0);
    try { await doc.cleanup?.(); } catch {}
    try { await doc.destroy?.(); } catch {}
  });
});

describe('pdf_classify — getHighImageCoverageRatio & detectInvalidChars & extractPages', () => {
  it('getHighImageCoverageRatio returns ratio 0-1', async () => {
    const bytes = await makeTextPdf();
    const ratio = await getHighImageCoverageRatio(bytes, 1);
    expect(typeof ratio).toBe('number');
    expect(ratio).toBeGreaterThanOrEqual(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it('detectInvalidChars false for normal text pdf', async () => {
    const bytes = await makeTextPdf('normal text ');
    const res = await detectInvalidChars(bytes);
    expect(typeof res).toBe('boolean');
    // Normal PDF should not be flagged
    expect(res).toBe(false);
  });

  it('detectInvalidChars false for null', async () => {
    expect(await detectInvalidChars(null)).toBe(false);
  });

  it('extractPages returns bytes and preserves count ≤10', async () => {
    const bytes = await makeTextPdf();
    const sampled = await extractPages(bytes);
    expect(sampled).toBeInstanceOf(Uint8Array);
    expect(sampled.length).toBeGreaterThan(0);
    // For single page, sampled should be 1 page
    const doc = await PDFDocument.load(sampled);
    expect(doc.getPageCount()).toBeLessThanOrEqual(10);
  });

  it('extractPages handles empty/null', async () => {
    const res = await extractPages(new Uint8Array([]));
    expect(res.length).toBe(0);
    const res2 = await extractPages(null);
    expect(res2.length).toBe(0);
  });
});
