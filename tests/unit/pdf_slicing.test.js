import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { getEndPageId } from '@rapid_doc/utils/pdf_page_id.js';
import {
  convertPdfBytesToBytesByPypdfium2,
  convertPdfToBytesByPypdfium2,
  prepareEnv,
  readFn,
} from '@rapid_doc/cli/common.js';

async function makePdf(pageCount) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([200, 200]);
    page.drawText(`page ${i}`, { x: 10, y: 100, size: 12 });
  }
  return await doc.save();
}

describe('pdf_page_id — getEndPageId', () => {
  it('null/undefined → pdfPageNum -1', () => {
    expect(getEndPageId(null, 5)).toBe(4);
    expect(getEndPageId(undefined, 5)).toBe(4);
    expect(getEndPageId(-1, 5)).toBe(4);
  });
  it('clamps to max', () => {
    expect(getEndPageId(10, 5)).toBe(4);
    expect(getEndPageId(4, 5)).toBe(4);
  });
  it('keeps valid within range', () => {
    expect(getEndPageId(2, 5)).toBe(2);
    expect(getEndPageId(0, 5)).toBe(0);
  });
});

describe('cli/common — pdf slicing (pdf-lib)', () => {
  it('convertPdfBytesToBytesByPypdfium2 slices correctly', async () => {
    const bytes = await makePdf(5);
    const sliced = await convertPdfBytesToBytesByPypdfium2(bytes, 1, 2);
    const doc = await PDFDocument.load(sliced);
    expect(doc.getPageCount()).toBe(2);
  });

  it('convertPdfBytesToBytesByPypdfium2 handles ArrayBuffer', async () => {
    const bytes = await makePdf(3);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const sliced = await convertPdfBytesToBytesByPypdfium2(buf, 0, 1);
    const doc = await PDFDocument.load(sliced);
    expect(doc.getPageCount()).toBe(2);
  });

  it('convertPdfBytesToBytesByPypdfium2 preserves original_image dict', async () => {
    const bytes = await makePdf(2);
    const input = { pdf_bytes: bytes, original_image: { foo: 1 } };
    const out = await convertPdfBytesToBytesByPypdfium2(input, 0, 0);
    expect(out.pdf_bytes).toBeInstanceOf(Uint8Array);
    expect(out.original_image).toEqual({ foo: 1 });
    const doc = await PDFDocument.load(out.pdf_bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it('convertPdfBytesToBytesByPypdfium2 falls back to original on invalid bytes', async () => {
    const bad = new Uint8Array([1, 2, 3]);
    const out = await convertPdfBytesToBytesByPypdfium2(bad, 0, 1);
    expect(out).toEqual(bad);
  });

  it('convertPdfToBytesByPypdfium2 window mode with pdfPagesBatch', async () => {
    const bytes = await makePdf(5);
    const [out, fileEnd] = await convertPdfToBytesByPypdfium2(bytes, 0, null, 2);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
    expect(fileEnd).toBe(false);

    const [out2, fileEnd2] = await convertPdfToBytesByPypdfium2(bytes, 4, null, 2);
    const doc2 = await PDFDocument.load(out2);
    expect(doc2.getPageCount()).toBe(1);
    expect(fileEnd2).toBe(true);
  });

  it('convertPdfToBytesByPypdfium2 respects fileEnd at last page', async () => {
    const bytes = await makePdf(3);
    const [out, fileEnd] = await convertPdfToBytesByPypdfium2(bytes, 0, 2, 0);
    expect(fileEnd).toBe(true);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
  });

  it('convertPdfToBytesByPypdfium2 handles empty pdf (0 pages) fallback', async () => {
    // pdf-lib cannot create 0-page doc via save? We test invalid bytes path → empty
    const bad = new Uint8Array([1, 2, 3]);
    const [out, fileEnd] = await convertPdfToBytesByPypdfium2(bad, 0, null, 2);
    expect(fileEnd).toBe(true);
    expect(out).toBeInstanceOf(Uint8Array);
  });

  it('prepareEnv is no-op and readFn returns null', () => {
    expect(() => prepareEnv('/tmp/out')).not.toThrow();
    expect(readFn('/any/path')).toBeNull();
    expect(readFn(null)).toBeNull();
  });
});
