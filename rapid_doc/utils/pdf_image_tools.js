// Copyright (c) Opendatalab. All rights reserved.
/**
 * PDF image extraction and manipulation utilities.
 *
 * Browser workarounds:
 * - ProcessPoolExecutor → single-threaded (no Web Workers wired yet)
 * - PIL.Image.crop → OffscreenCanvas.drawImage with clipping
 * - pypdfium2 image extraction → pdfjs-dist getOperatorList
 * - FileBasedDataWriter → imageWriter.write(path, bytes) contract
 * - images_bytes_to_pdf_bytes → pdf-lib embedding
 */

import { pageToImage, imageToBytes, imageToB64str } from './pdf_reader.js';
import { ImageType, ContentType, CategoryId } from './enum_class.js';
import { strSha256 } from './hash_utils.js';
import { getEndPageId } from './pdf_page_id.js';
import { calculateIou } from './boxbase.js';
import { getPdfjsLib } from './pdfjs_loader.js';
import { deleteMat } from './resource_utils.js';

/**
 * Convert a pdfjs page to an image dict.
 *
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @param {number} [dpi=200]
 * @param {*} [imageType=ImageType.PIL]
 * @returns {Promise<object>} { canvas?, img_base64?, scale }
 */
export async function pdfPageToImage(page, dpi = 200, imageType = ImageType.PIL) {
  if (!page) return null;

  const { canvas, scale } = await pageToImage(page, dpi);
  if (imageType === ImageType.BASE64) {
    const b64 = await imageToB64str(canvas);
    canvas.width = 0;
    canvas.height = 0;
    return { img_base64: b64, scale };
  }
  return { img_pil: canvas, scale };
}

/**
 * Load all pages of a PDF as images (single-threaded).
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
  if (!pdfBytes) return [[], null];

  const pdfjsLib = await getPdfjsLib();
  const _data = pdfBytes instanceof Uint8Array ? pdfBytes.slice() : new Uint8Array(pdfBytes instanceof ArrayBuffer ? pdfBytes.slice(0) : pdfBytes);
  const loadingTask = pdfjsLib.getDocument({ data: _data });
  const pdfDoc = await loadingTask.promise;

  const endId = getEndPageId(endPageId, pdfDoc.numPages);
  const imagesList = await loadImagesFromPdfCore(pdfBytes, dpi, startPageId, endId, imageType, pdfDoc);

  return [imagesList, pdfDoc];
}

/**
 * Core single-threaded page rendering.
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
  if (!pdfBytes && !existingDoc) return [];

  const pdfjsLib = await getPdfjsLib();
  const _data = pdfBytes instanceof Uint8Array ? pdfBytes.slice() : new Uint8Array(pdfBytes instanceof ArrayBuffer ? pdfBytes.slice(0) : pdfBytes);
  const pdfDoc = existingDoc ?? await pdfjsLib.getDocument({ data: _data }).promise;
  try {
    const pageNum = pdfDoc.numPages;
    const endId = getEndPageId(endPageId, pageNum);

    const imagesList = [];
    for (let i = startPageId; i <= endId; i++) {
      const page = await pdfDoc.getPage(i + 1);
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
  if (!span || !pagePilImg) return '';

  const bbox = span.bbox;
  let cropCanvas = null;

  if (extractOriginalImage && span.type === ContentType.IMAGE) {
    for (const oriImage of (oriImageList ?? [])) {
      if (calculateIou(bbox, oriImage.bbox) >= extractOriginalImageIouThresh) {
        cropCanvas = oriImage.pil_image;
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
 *
 * @param {number[]} bbox [x0, y0, x1, y1]
 * @param {OffscreenCanvas} canvas
 * @param {number} [scale=2]
 * @returns {OffscreenCanvas}
 */
export function getCropImg(bbox, canvas, scale = 2) {
  if (!bbox || !canvas) return new OffscreenCanvas(1, 1);

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
 *
 * @param {number[]} bbox - [x0, y0, x1, y1]
 * @param {OffscreenCanvas|cv.Mat} canvas - Input image
 * @param {number} [scale=2] - Scale factor
 * @param {boolean} [returnList=false] - If true, return {mat, usefulList}
 * @returns {cv.Mat|{mat: cv.Mat, usefulList: number[]}} cv.Mat or {mat, usefulList}
 */
export function getCropNpImg(bbox, canvas, scale = 2, returnList = false) {
  if (!bbox || !canvas) {
    const emptyMat = new cv.Mat(0, 0, cv.CV_8UC3);
    return returnList ? { mat: emptyMat, usefulList: [0, 0, 0, 0, 0, 0, 0, 0] } : emptyMat;
  }

  let scaleBbox = [
    Math.floor(bbox[0] * scale),
    Math.floor(bbox[1] * scale),
    Math.floor(bbox[2] * scale),
    Math.floor(bbox[3] * scale),
  ];

  let mat;
  if (typeof cv !== 'undefined' && canvas instanceof cv.Mat) {
    scaleBbox = clampBboxToSize(scaleBbox, canvas.cols, canvas.rows);
    const [cropXmin, cropYmin, cropXmax, cropYmax] = scaleBbox;
    const width = cropXmax - cropXmin;
    const height = cropYmax - cropYmin;

    if (width <= 0 || height <= 0) {
      mat = new cv.Mat(0, 0, typeof canvas.type === 'function' ? canvas.type() : cv.CV_8UC3);
    } else {
      const roi = canvas.roi(new cv.Rect(cropXmin, cropYmin, width, height));
      try {
        mat = roi.clone();
      } finally {
        deleteMat(roi);
      }
    }
  } else {
    scaleBbox = clampBboxToSize(scaleBbox, canvas.width, canvas.height);
    const cropped = getCropImg(bbox, canvas, scale);
    const ctx = cropped.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, cropped.width, cropped.height);
    mat = cv.matFromImageData(imageData);
  }

  if (returnList) {
    const [cropXmin, cropYmin, cropXmax, cropYmax] = scaleBbox;
    const usefulList = [0, 0, cropXmin, cropYmin, cropXmax, cropYmax, mat.cols, mat.rows];
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
 * Uses pdf-lib to embed the image as a page.
 *
 * @param {Uint8Array} imageBytes
 * @returns {Promise<Uint8Array>}
 */
export async function imagesBytesToPdfBytes(imageBytes) {
  if (!imageBytes || imageBytes.length === 0) {
    throw new Error('imagesBytesToPdfBytes: empty image bytes');
  }

  const { PDFDocument } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const arrayBuffer = imageBytes.buffer.slice(
    imageBytes.byteOffset,
    imageBytes.byteOffset + imageBytes.byteLength,
  );
  let img;
  try {
    img = await pdfDoc.embedPng(arrayBuffer);
  } catch {
    img = await pdfDoc.embedJpg(arrayBuffer);
  }
  const page = pdfDoc.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  return pdfDoc.save();
}

function multiplyPdfMatrix(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function transformPdfPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function imageBboxFromCtm(ctm, pageHeight) {
  const points = [
    transformPdfPoint(ctm, 0, 0),
    transformPdfPoint(ctm, 1, 0),
    transformPdfPoint(ctm, 1, 1),
    transformPdfPoint(ctm, 0, 1),
  ];
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return [x0, pageHeight - y1, x1, pageHeight - y0].map(v => Math.round(v * 1000) / 1000);
}

async function resolvePdfjsImage(page, objId) {
  if (!objId || !page?.objs) return null;
  try {
    const value = page.objs.get(objId);
    if (value) return value;
  } catch { /* wait via callback below */ }
  try {
    return await new Promise(resolve => page.objs.get(objId, resolve));
  } catch {
    return null;
  }
}

function imageObjectToCanvas(imageObj) {
  if (!imageObj) return null;
  if (imageObj instanceof OffscreenCanvas) return imageObj;

  const width = imageObj.width ?? imageObj.naturalWidth ?? imageObj.videoWidth ?? 0;
  const height = imageObj.height ?? imageObj.naturalHeight ?? imageObj.videoHeight ?? 0;
  if (!width || !height) return null;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  if (typeof ImageBitmap !== 'undefined' && imageObj instanceof ImageBitmap) {
    ctx.drawImage(imageObj, 0, 0);
    return canvas;
  }
  if (typeof HTMLCanvasElement !== 'undefined' && imageObj instanceof HTMLCanvasElement) {
    ctx.drawImage(imageObj, 0, 0);
    return canvas;
  }

  const src = imageObj.data;
  if (!src) return null;
  const pixelCount = width * height;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  if (src.length >= pixelCount * 4) {
    rgba.set(src.subarray ? src.subarray(0, pixelCount * 4) : src.slice(0, pixelCount * 4));
  } else if (src.length >= pixelCount * 3) {
    for (let i = 0, j = 0; i < pixelCount; i++, j += 3) {
      rgba[i * 4] = src[j];
      rgba[i * 4 + 1] = src[j + 1];
      rgba[i * 4 + 2] = src[j + 2];
      rgba[i * 4 + 3] = 255;
    }
  } else if (src.length >= pixelCount) {
    for (let i = 0; i < pixelCount; i++) {
      const v = src[i];
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  } else {
    return null;
  }
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

/**
 * Extract original embedded images from a PDF page.
 * Uses pdfjs-dist getOperatorList to find image positions and resolve image objects.
 *
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @returns {Promise<Array<object>>}
 */
export async function getOriImage(page) {
  if (!page?.getOperatorList) return [];

  try {
    const pdfjsLib = await getPdfjsLib();
    const OPS = pdfjsLib.OPS ?? {};
    const operatorList = await page.getOperatorList();
    const viewport = page.getViewport({ scale: 1 });
    const pageHeight = Math.ceil(viewport.height);
    const stack = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const images = [];
    const isOp = (fn, name) => fn === OPS[name];

    for (let i = 0; i < operatorList.fnArray.length; i++) {
      const fn = operatorList.fnArray[i];
      const args = operatorList.argsArray[i] ?? [];
      if (isOp(fn, 'save')) {
        stack.push(ctm.slice());
      } else if (isOp(fn, 'restore')) {
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      } else if (isOp(fn, 'transform') && args.length >= 6) {
        ctm = multiplyPdfMatrix(ctm, args.slice(0, 6).map(Number));
      } else if (
        isOp(fn, 'paintImageXObject') ||
        isOp(fn, 'paintJpegXObject') ||
        isOp(fn, 'paintInlineImageXObject')
      ) {
        const imageObj = isOp(fn, 'paintInlineImageXObject') ? args[0] : await resolvePdfjsImage(page, args[0]);
        const canvas = imageObjectToCanvas(imageObj);
        if (!canvas) continue;
        images.push({
          bbox: imageBboxFromCtm(ctm, pageHeight),
          pil_image: canvas,
          width: canvas.width,
          height: canvas.height,
        });
      }
    }
    return images;
  } catch (err) {
    console.warn('[getOriImage] pdf.js image extraction failed:', err?.message ?? err);
    return [];
  }
}

/**
 * Save images embedded in table HTML using uuid placeholders.
 *
 * @param {Array<object>} layoutDets
 * @param {Array<object>} tableFillImageList
 * @param {string} pageImgMd5
 * @param {number} pageNum
 * @param {{ write(path: string, data: Uint8Array): void }|null} imageWriter
 * @returns {Promise<void>}
 */
export async function saveTableFillImage(layoutDets, tableFillImageList, pageImgMd5, pageNum, imageWriter) {
  if (!tableFillImageList?.length || !imageWriter) return;
  if (!layoutDets) return;

  const returnPath = (pathType) => `${pathType}/${pageImgMd5}`;

  try {
    for (const layoutDet of layoutDets) {
      if (layoutDet.category_id !== CategoryId.TableBody || !layoutDet.html) continue;
      for (const fillImage of tableFillImageList) {
        if (!layoutDet.html.includes(fillImage.uuid)) continue;
        const bbox = fillImage.bbox;
        const canvas = fillImage.pil_image;

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
    console.warn('[saveTableFillImage] failed:', e?.message ?? e);
  }
}
