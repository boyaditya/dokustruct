// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: pdf_reader.py → pdf_reader.js
 *
 * WORKAROUND: pypdfium2.PdfPage.render(scale=...) → pdfjs-dist page.render({viewport})
 * REASON: pypdfium2 not available in browser

import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
 * SOLUTION: Use pdfjs-dist (pdfjsLib) to render pages to OffscreenCanvas / HTMLCanvasElement.
 *
 * WORKAROUND: PIL.Image → ImageBitmap / HTMLCanvasElement
 * SOLUTION: OffscreenCanvas-based rendering; output is { canvas, scale } or Uint8Array/base64.
 *
 * WORKAROUND: base64.b64encode → btoa(String.fromCharCode(...))
 * REASON: base64 stdlib not in browser
 * SOLUTION: Standard btoa + Uint8Array interop.
 */

import { getPdfjsLib } from './pdfjs_loader.js';

/**
 * Render a single pdfjs PDFPageProxy to a canvas.
 * PORTING NOTE: page_to_image(page, dpi, max_width_or_height) → pageToImage(...)
 *
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @param {number} [dpi=200]
 * @param {number} [maxWidthOrHeight=3500]
 * @returns {Promise<{canvas: OffscreenCanvas, scale: number}>}
 */
export async function pageToImage(page, dpi = 200, maxWidthOrHeight = 3500) {
  let scale = dpi / 72;

  const viewport0 = page.getViewport({ scale: 1 });
  const longSide = Math.max(viewport0.width, viewport0.height);
  if (longSide * scale > maxWidthOrHeight) {
    scale = maxWidthOrHeight / longSide;
  }

  const viewport = page.getViewport({ scale });
  const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  await page.render({ canvasContext: ctx, viewport }).promise;

  return { canvas, scale };
}

/**
 * Encode an OffscreenCanvas to raw bytes.
 * PORTING NOTE: image_to_bytes(image, image_format) → imageToBytes(canvas, imageFormat)
 *
 * @param {OffscreenCanvas} canvas
 * @param {string} [imageFormat='image/png']
 * @returns {Promise<Uint8Array>}
 */
export async function imageToBytes(canvas, imageFormat = 'image/png') {
  const blob = await canvas.convertToBlob({ type: imageFormat });
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Encode an OffscreenCanvas to a base64 string.
 * PORTING NOTE: image_to_b64str(image, image_format) → imageToB64str(canvas, imageFormat)
 *
 * @param {OffscreenCanvas} canvas
 * @param {string} [imageFormat='image/png']
 * @returns {Promise<string>}
 */
export async function imageToB64str(canvas, imageFormat = 'image/png') {
  const bytes = await imageToBytes(canvas, imageFormat);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Decode a base64 string to an OffscreenCanvas.
 * PORTING NOTE: base64_to_pil_image(base64_str) → base64ToCanvas(base64Str)
 *
 * @param {string} base64Str
 * @returns {Promise<OffscreenCanvas>}
 */
export async function base64ToCanvas(base64Str) {
  const binary = atob(base64Str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

/**
 * Render all pages of a PDF to canvas objects.
 * PORTING NOTE: pdf_to_images(pdf, dpi, ...) → pdfToImages(pdf, dpi, ...)
 *
 * @param {Uint8Array|ArrayBuffer} pdfBytes
 * @param {number} [dpi=200]
 * @param {number} [maxWidthOrHeight=3500]
 * @param {number} [startPageId=0]
 * @param {number|null} [endPageId=null]
 * @returns {Promise<Array<{canvas: OffscreenCanvas, scale: number}>>}
 */
export async function pdfToImages(pdfBytes, dpi = 200, maxWidthOrHeight = 3500, startPageId = 0, endPageId = null) {
  const pdfjsLib = await getPdfjsLib();
  // Always pass a copy so PDF.js cannot detach the caller's buffer
  const _data = pdfBytes instanceof Uint8Array ? pdfBytes.slice() : new Uint8Array(pdfBytes instanceof ArrayBuffer ? pdfBytes.slice(0) : pdfBytes);
  const loadingTask = pdfjsLib.getDocument({ data: _data });
  const pdfDoc = await loadingTask.promise;
  try {
    const pageNum = pdfDoc.numPages;
    const _endPageId = (endPageId !== null && endPageId >= 0) ? Math.min(endPageId, pageNum - 1) : pageNum - 1;

    const images = [];
    for (let i = startPageId; i <= _endPageId; i++) {
      const page = await pdfDoc.getPage(i + 1); // pdfjs is 1-indexed
      const result = await pageToImage(page, dpi, maxWidthOrHeight);
      images.push(result);
    }

    return images;
  } finally {
    try { await pdfDoc.cleanup?.(); } catch { /* ignore */ }
    try { await pdfDoc.destroy?.(); } catch { /* ignore */ }
  }
}

/**
 * Render PDF pages to byte arrays.
 * PORTING NOTE: pdf_to_images_bytes → pdfToImagesBytes
 *
 * @param {Uint8Array|ArrayBuffer} pdfBytes
 * @param {number} [dpi=200]
 * @param {number} [maxWidthOrHeight=3500]
 * @param {number} [startPageId=0]
 * @param {number|null} [endPageId=null]
 * @param {string} [imageFormat='image/png']
 * @returns {Promise<Uint8Array[]>}
 */
export async function pdfToImagesBytes(pdfBytes, dpi = 200, maxWidthOrHeight = 3500, startPageId = 0, endPageId = null, imageFormat = 'image/png') {
  const images = await pdfToImages(pdfBytes, dpi, maxWidthOrHeight, startPageId, endPageId);
  return Promise.all(images.map(({ canvas }) => imageToBytes(canvas, imageFormat)));
}

/**
 * Render PDF pages to base64-encoded strings.
 * PORTING NOTE: pdf_to_images_b64strs → pdfToImagesB64strs
 *
 * @param {Uint8Array|ArrayBuffer} pdfBytes
 * @param {number} [dpi=200]
 * @param {number} [maxWidthOrHeight=3500]
 * @param {number} [startPageId=0]
 * @param {number|null} [endPageId=null]
 * @param {string} [imageFormat='image/png']
 * @returns {Promise<string[]>}
 */
export async function pdfToImagesB64strs(pdfBytes, dpi = 200, maxWidthOrHeight = 3500, startPageId = 0, endPageId = null, imageFormat = 'image/png') {
  const images = await pdfToImages(pdfBytes, dpi, maxWidthOrHeight, startPageId, endPageId);
  return Promise.all(images.map(({ canvas }) => imageToB64str(canvas, imageFormat)));
}
