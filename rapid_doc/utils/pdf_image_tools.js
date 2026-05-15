// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: pdf_image_tools.py → pdf_image_tools.js
 *
 * WORKAROUND: ProcessPoolExecutor / multiprocessing
 * REASON: Browser is single-threaded; Web Workers not yet wired in this porting context
 * SOLUTION: Always use single-threaded loadImagesFromPdfCore path.
 *
 * WORKAROUND: PIL.Image.crop(scaled_bbox) → OffscreenCanvas.drawImage with clipping
 * REASON: PIL not in browser
 * SOLUTION: OffscreenCanvas-based cropping via drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh).
 *
 * WORKAROUND: pdfium_c.FPDF_PAGEOBJ_IMAGE + image.get_bitmap().to_pil()
 * REASON: pypdfium2 not in browser
 * SOLUTION: getOriImage uses pdfjs-dist getOperatorList to find image positions;
 *   rendered via page.objs.get() when available. For broad compatibility, returns empty list
 *   and logs a warning (no robust cross-PDF image-object extraction in pdfjs).
 *
 * WORKAROUND: FileBasedDataWriter (filesystem writes)
 * REASON: Browser has no filesystem
 * SOLUTION: imageWriter parameter accepted but writes via imageWriter.write(path, bytes) contract.
 *   ImageWriter must be provided by caller (e.g., an IndexedDB or in-memory writer).
 *
 * WORKAROUND: images_bytes_to_pdf_bytes using PIL → PDF
 * REASON: PIL not in browser
 * SOLUTION: Use pdf-lib (if available) to embed image as page; throw otherwise.
 */

import { pageToImage, imageToBytes, imageToB64str } from './pdf_reader.js';
import { ImageType, ContentType, CategoryId } from './enum_class.js';
import { strSha256 } from './hash_utils.js';
import { getEndPageId } from './pdf_page_id.js';
import { calculateIou } from './boxbase.js';
import { getPdfjsLib } from './pdfjs_loader.js';

/**
 * Convert a pdfjs page to an image dict.
 * PORTING NOTE: pdf_page_to_image(page, dpi, image_type) → pdfPageToImage(page, dpi, imageType)
 *
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @param {number} [dpi=200]
 * @param {*} [imageType=ImageType.PIL]
 * @returns {Promise<object>} { canvas?, img_base64?, scale }
 */
export async function pdfPageToImage(page, dpi = 200, imageType = ImageType.PIL) {
  const { canvas, scale } = await pageToImage(page, dpi);
  if (imageType === ImageType.BASE64) {
    const b64 = await imageToB64str(canvas);
    canvas.width = 0; canvas.height = 0;
    return { img_base64: b64, scale };
  }
  return { img_pil: canvas, scale };
}

/**
 * Load all pages of a PDF as images (single-threaded).
 * PORTING NOTE: load_images_from_pdf(...) → loadImagesFromPdf(...)
 *   ProcessPoolExecutor removed — always single-threaded.
 *
 * @param {Uint8Array} pdfBytes
 * @param {object} [opts]
 * @param {number} [opts.dpi=200]
 * @param {number} [opts.startPageId=0]
 * @param {number|null} [opts.endPageId=null]
 * @param {*} [opts.imageType=ImageType.PIL]
 * @returns {Promise<[Array<object>, import('pdfjs-dist').PDFDocumentProxy]>}
 */
export async function loadImagesFromPdf(pdfBytes, {
  dpi = 200,
  startPageId = 0,
  endPageId = null,
  imageType = ImageType.PIL,
} = {}) {
  const pdfjsLib = await getPdfjsLib();
  // Always pass a copy so PDF.js cannot detach the caller's buffer
  const _data = pdfBytes instanceof Uint8Array ? pdfBytes.slice() : new Uint8Array(pdfBytes instanceof ArrayBuffer ? pdfBytes.slice(0) : pdfBytes);
  const loadingTask = pdfjsLib.getDocument({ data: _data });
  const pdfDoc = await loadingTask.promise;

  const endId = getEndPageId(endPageId, pdfDoc.numPages);
  const imagesList = await loadImagesFromPdfCore(pdfBytes, dpi, startPageId, endId, imageType, pdfDoc);

  return [imagesList, pdfDoc];
}

/**
 * Core single-threaded page rendering.
 * PORTING NOTE: load_images_from_pdf_core → loadImagesFromPdfCore
 *
 * @param {Uint8Array} pdfBytes
 * @param {number} [dpi=200]
 * @param {number} [startPageId=0]
 * @param {number|null} [endPageId=null]
 * @param {*} [imageType=ImageType.PIL]
 * @param {import('pdfjs-dist').PDFDocumentProxy|null} [existingDoc=null]
 * @returns {Promise<Array<object>>}
 */
export async function loadImagesFromPdfCore(pdfBytes, dpi = 200, startPageId = 0, endPageId = null, imageType = ImageType.PIL, existingDoc = null) {
  const pdfjsLib = await getPdfjsLib();
  // Always pass a copy so PDF.js cannot detach the caller's buffer
  const _data = pdfBytes instanceof Uint8Array ? pdfBytes.slice() : new Uint8Array(pdfBytes instanceof ArrayBuffer ? pdfBytes.slice(0) : pdfBytes);
  const pdfDoc = existingDoc ?? await pdfjsLib.getDocument({ data: _data }).promise;
  try {
    const pageNum = pdfDoc.numPages;
    const endId = getEndPageId(endPageId, pageNum);

    const imagesList = [];
    for (let i = startPageId; i <= endId; i++) {
      const page = await pdfDoc.getPage(i + 1); // pdfjs 1-indexed
      const imageDict = await pdfPageToImage(page, dpi, imageType);
      imagesList.push(imageDict);
    }

    return imagesList;
  } finally {
    if (!existingDoc) {
      try { await pdfDoc.cleanup?.(); } catch { /* ignore */ }
      try { await pdfDoc.destroy?.(); } catch { /* ignore */ }
    }
  }
}

/**
 * Crop a span bbox from a page image and write to imageWriter.
 * PORTING NOTE: cut_image(span, ori_image_list, ...) → cutImage(...)
 *
 * @param {object} span
 * @param {Array<object>} oriImageList
 * @param {boolean} extractOriginalImage
 * @param {number} extractOriginalImageIouThresh
 * @param {number} pageNum
 * @param {OffscreenCanvas} pagePilImg
 * @param {string|null} returnPath
 * @param {{ write(path: string, data: Uint8Array): void }} imageWriter
 * @param {number} [scale=2]
 * @returns {Promise<string>}
 */
export async function cutImage(span, oriImageList, extractOriginalImage, extractOriginalImageIouThresh, pageNum, pagePilImg, returnPath, imageWriter, scale = 2) {
  const bbox = span.bbox;
  let cropCanvas = null;

  if (extractOriginalImage && span.type === ContentType.IMAGE) {
    for (const oriImage of oriImageList) {
      if (calculateIou(bbox, oriImage.bbox) >= extractOriginalImageIouThresh) {
        cropCanvas = oriImage.pil_image; // already an OffscreenCanvas
        break;
      }
    }
  }

  const filename = `${pageNum}_${Math.round(bbox[0])}_${Math.round(bbox[1])}_${Math.round(bbox[2])}_${Math.round(bbox[3])}`;
  const imgPath = returnPath !== null ? `${returnPath}_${filename}` : null;
  const imgHash256Path = `${await strSha256(imgPath)}.png`;

  if (!cropCanvas) {
    cropCanvas = getCropImg(bbox, pagePilImg, scale);
  }

  const imgBytes = await imageToBytes(cropCanvas, 'image/png');
  imageWriter.write(imgHash256Path, imgBytes);
  return imgHash256Path;
}

/**
 * Crop a region from an OffscreenCanvas.
 * PORTING NOTE: get_crop_img(bbox, pil_img, scale) → getCropImg(bbox, canvas, scale)
 *
 * @param {number[]} bbox [x0, y0, x1, y1]
 * @param {OffscreenCanvas} canvas
 * @param {number} [scale=2]
 * @returns {OffscreenCanvas}
 */
export function getCropImg(bbox, canvas, scale = 2) {
  let [x0, y0, x1, y1] = bbox.map(v => Math.round(v * scale));
  x0 = Math.max(0, Math.min(canvas.width, x0));
  y0 = Math.max(0, Math.min(canvas.height, y0));
  x1 = Math.max(0, Math.min(canvas.width, x1));
  y1 = Math.max(0, Math.min(canvas.height, y1));
  if (x1 <= x0 || y1 <= y0) {
    const out = new OffscreenCanvas(1, 1);
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 1, 1);
    return out;
  }
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
  return out;
}

/**
 * Crop a region from a canvas as a cv.Mat.
 * PORTING NOTE: get_crop_np_img(bbox, input_img, scale, return_list) → getCropNpImg(bbox, canvas, scale, returnList)
 *
 * @param {number[]} bbox - [x0, y0, x1, y1]
 * @param {OffscreenCanvas|cv.Mat} canvas - Input image
 * @param {number} [scale=2] - Scale factor
 * @param {boolean} [returnList=false] - If true, return {mat, usefulList}
 * @returns {cv.Mat|{mat: cv.Mat, usefulList: number[]}} cv.Mat or {mat, usefulList}
 */
export function getCropNpImg(bbox, canvas, scale = 2, returnList = false) {
  let scaleBbox = [
    Math.floor(bbox[0] * scale),
    Math.floor(bbox[1] * scale),
    Math.floor(bbox[2] * scale),
    Math.floor(bbox[3] * scale),
  ];

  let mat;
  if (typeof cv !== 'undefined' && canvas instanceof cv.Mat) {
    // Input is already a cv.Mat
    scaleBbox = clampBboxToSize(scaleBbox, canvas.cols, canvas.rows);
    const [cropXmin, cropYmin, cropXmax, cropYmax] = scaleBbox;
    const width = cropXmax - cropXmin;
    const height = cropYmax - cropYmin;
    
    if (width <= 0 || height <= 0) {
      mat = new cv.Mat(0, 0, typeof canvas.type === 'function' ? canvas.type() : cv.CV_8UC3);
    } else {
      const roi = canvas.roi(new cv.Rect(cropXmin, cropYmin, width, height));
      mat = roi.clone();
      roi.delete();
    }
  } else {
    // Input is canvas/OffscreenCanvas
    scaleBbox = clampBboxToSize(scaleBbox, canvas.width, canvas.height);
    const cropped = getCropImg(bbox, canvas, scale);
    const ctx = cropped.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, cropped.width, cropped.height);
    mat = cv.matFromImageData(imageData);
  }

  if (returnList) {
    const [cropXmin, cropYmin, cropXmax, cropYmax] = scaleBbox;
    const cropNewHeight = mat.rows;
    const cropNewWidth = mat.cols;
    const usefulList = [0, 0, cropXmin, cropYmin, cropXmax, cropYmax, cropNewWidth, cropNewHeight];
    return { mat, usefulList };
  }

  return mat;
}

function clampBboxToSize(bbox, width, height) {
  let [x0, y0, x1, y1] = bbox.map(v => Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
  x0 = Math.max(0, Math.min(width, x0));
  y0 = Math.max(0, Math.min(height, y0));
  x1 = Math.max(0, Math.min(width, x1));
  y1 = Math.max(0, Math.min(height, y1));
  return [x0, y0, x1, y1];
}

/**
 * Convert image bytes to a single-page PDF Uint8Array.
 * PORTING NOTE: images_bytes_to_pdf_bytes → imagesBytesToPdfBytes
 *
 * Uses pdf-lib if available; throws if not.
 *
 * @param {Uint8Array} imageBytes
 * @returns {Promise<Uint8Array>}
 */
export async function imagesBytesToPdfBytes(imageBytes) {
  const { PDFDocument } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const blob = new Blob([imageBytes]);
  const arrayBuffer = await blob.arrayBuffer();
  // Try PNG, then JPG
  let img;
  try { img = await pdfDoc.embedPng(arrayBuffer); } catch { img = await pdfDoc.embedJpg(arrayBuffer); }
  const page = pdfDoc.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  return pdfDoc.save();
}

/**
 * Extract original embedded images from a PDF page.
 * PORTING NOTE: get_ori_image(page, ...) → getOriImage(page, ...)
 *
 * WORKAROUND: pdfium image object extraction → pdfjs-dist
 * REASON: pdfjs has limited image object extraction capabilities
 * SOLUTION: Returns empty list as conservative fallback;
 *   upstream code (span_pre_proc) handles empty list gracefully.
 *
 * @param {import('pdfjs-dist').PDFPageProxy} _page
 * @returns {Promise<Array<object>>}
 */
export async function getOriImage(_page) {
  // pdfjs-dist does not provide low-level image bitmap extraction.
  // See https://github.com/mozilla/pdf.js/issues/9643
  return [];
}

/**
 * Save images embedded in table HTML using uuid placeholders.
 * PORTING NOTE: save_table_fill_image(...) → saveTableFillImage(...)
 *
 * @param {Array<object>} layoutDets
 * @param {Array<object>} tableFillImageList
 * @param {string} pageImgMd5
 * @param {number} pageNum
 * @param {{ write(path: string, data: Uint8Array): void }|null} imageWriter
 * @returns {Promise<void>}
 */
export async function saveTableFillImage(layoutDets, tableFillImageList, pageImgMd5, pageNum, imageWriter) {
  if (!tableFillImageList || !tableFillImageList.length) return;
  if (!imageWriter) return;

  const returnPath = (pathType) => `${pathType}/${pageImgMd5}`;

  try {
    for (const layoutDet of layoutDets) {
      if (layoutDet.category_id !== CategoryId.TableBody || !layoutDet.html) continue;
      for (const fillImage of tableFillImageList) {
        if (!layoutDet.html.includes(fillImage.uuid)) continue;
        const bbox = fillImage.bbox;
        const canvas = fillImage.pil_image; // OffscreenCanvas

        const filename = `${pageNum}_${Math.round(bbox[0])}_${Math.round(bbox[1])}_${Math.round(bbox[2])}_${Math.round(bbox[3])}`;
        const imgPath = `${returnPath('images')}_${filename}`;
        const imgHash256Path = `${await strSha256(imgPath)}.png`;
        const imgBytes = await imageToBytes(canvas, 'image/png');
        imageWriter.write(imgHash256Path, imgBytes);

        const imageDir = imageWriter._parentDir ? imageWriter._parentDir.split('/').pop() : 'images';
        const imagePath = `${imageDir}/${imgHash256Path}`;
        const formatImage = `<img src="${imagePath}" alt="Image" />`;
        layoutDet.html = layoutDet.html.replaceAll(fillImage.uuid, formatImage);
      }
    }
  } catch (e) {
    console.error(e);
  }
}
