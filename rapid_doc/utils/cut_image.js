/**
 * Image cropping utilities for document pipeline.
 * Handles Mat-based and Canvas-based image cropping with proper resource cleanup.
 *
 * Browser workaround: Python uses PIL.Image.crop() + filesystem writes via image_writer.
 * Here we use cv.Mat ROI or OffscreenCanvas for cropping, and imageWriter.write() for storage.
 */

import { getLogger } from './logger.js';
import { strSha256 } from './hash_utils.js';
import { calculateIou } from './boxbase.js';
import { deleteMat } from './resource_utils.js';

const logger = getLogger('cut_image');

/**
 * Validate that a bounding box is non-degenerate.
 *
 * @param {number[]} bbox - [x0, y0, x1, y1]
 * @returns {boolean}
 */
export function checkImgBbox(bbox) {
  if (!bbox || bbox.length < 4) return false;
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    logger.warning(`image_bboxes: invalid bbox, ${JSON.stringify(bbox)}`);
    return false;
  }
  return true;
}

/**
 * Crop a region from a cv.Mat according to a scaled bbox.
 * Caller must .delete() the returned Mat.
 *
 * @param {number[]} bbox - [x0, y0, x1, y1] in original (unscaled) coordinates
 * @param {cv.Mat}  mat  - Source image Mat (BGR or RGBA)
 * @param {number}  [scale=2]
 * @returns {cv.Mat} Cropped Mat
 */
export function getCropMat(bbox, mat, scale = 2) {
  if (!bbox || !mat) return null;

  let x0 = Math.max(0, Math.floor(bbox[0] * scale));
  let y0 = Math.max(0, Math.floor(bbox[1] * scale));
  let x1 = Math.min(mat.cols, Math.ceil(bbox[2] * scale));
  let y1 = Math.min(mat.rows, Math.ceil(bbox[3] * scale));

  if (x1 <= x0) {
    if (x0 > 0) x0 = x1 - 1;
    else x1 = x0 + 1;
  }
  if (y1 <= y0) {
    if (y0 > 0) y0 = y1 - 1;
    else y1 = y0 + 1;
  }

  // Final bounds check
  x0 = Math.max(0, Math.min(x0, mat.cols - 1));
  y0 = Math.max(0, Math.min(y0, mat.rows - 1));
  const w = Math.max(1, Math.min(x1 - x0, mat.cols - x0));
  const h = Math.max(1, Math.min(y1 - y0, mat.rows - y0));

  const rect = new cv.Rect(x0, y0, w, h);
  return mat.roi(rect);
}

/**
 * Encode a cv.Mat (BGR) to a PNG Blob via OffscreenCanvas.
 *
 * @param {cv.Mat} mat - BGR Mat
 * @returns {Promise<Blob|null>} PNG Blob
 */
export async function matToPngBlob(mat) {
  if (!mat || mat.isDeleted?.()) return null;

  let rgba = null;
  let cloned = null;
  try {
    cloned = mat.clone();
    rgba = new cv.Mat();
    cv.cvtColor(cloned, rgba, cv.COLOR_BGR2RGBA);
    const imageData = new ImageData(
      new Uint8ClampedArray(rgba.data),
      rgba.cols,
      rgba.rows,
    );
    const canvas = new OffscreenCanvas(rgba.cols, rgba.rows);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(imageData, 0, 0);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    deleteMat(rgba);
    deleteMat(cloned);
  }
}

/**
 * Crop a span's bbox from a page image, hash the path, store the PNG via
 * imageWriter, and return the stored key.
 *
 * @param {Object}      span
 * @param {Object[]}    oriImageList            - [{bbox, mat: cv.Mat}, ...]
 * @param {boolean}     extractOriginalImage
 * @param {number}      extractOriginalImageIouThresh
 * @param {number}      pageNum
 * @param {cv.Mat}      pageMat                 - Page image as BGR cv.Mat
 * @param {string|null} returnPath              - Logical path prefix
 * @param {{write(key:string, blob:Blob):void}} imageWriter
 * @param {number}      [scale=2]
 * @returns {Promise<string>} Stored PNG key (SHA-256 hash + '.png')
 */
export async function cutImage(
  span,
  oriImageList,
  extractOriginalImage,
  extractOriginalImageIouThresh,
  pageNum,
  pageMat,
  returnPath,
  imageWriter,
  scale = 2,
) {
  if (!span || !pageMat) return '';

  const bbox = span.bbox;
  let cropMat = null;
  let needDeleteCrop = false;

  // Try to use original embedded image if conditions match
  if (extractOriginalImage && span.type === 'image') {
    for (const oriImage of (oriImageList ?? [])) {
      if (calculateIou(bbox, oriImage.bbox) >= extractOriginalImageIouThresh) {
        cropMat = oriImage.mat; // borrowed — do NOT delete
        break;
      }
    }
  }

  // Build logical path name (mirrors Python filename construction)
  const filename = `${pageNum}_${Math.floor(bbox[0])}_${Math.floor(bbox[1])}_${Math.floor(bbox[2])}_${Math.floor(bbox[3])}`;
  const imgPath = returnPath != null ? `${returnPath}_${filename}` : filename;
  const imgHash256Path = `${await strSha256(imgPath)}.png`;

  if (!cropMat) {
    cropMat = getCropMat(bbox, pageMat, scale);
    needDeleteCrop = true;
  }

  try {
    const pngBlob = await matToPngBlob(cropMat);
    imageWriter.write(imgHash256Path, pngBlob);
  } finally {
    if (needDeleteCrop) {
      deleteMat(cropMat);
    }
  }

  return imgHash256Path;
}

/**
 * Crop an image or table span from a page and write the PNG via imageWriter.
 * Mutates span.image_path in-place, then returns the span.
 *
 * @param {Object}      span
 * @param {Object[]}    oriImageList
 * @param {boolean}     extractOriginalImage
 * @param {number}      extractOriginalImageIouThresh
 * @param {cv.Mat}      pageMat
 * @param {string}      pageImgMd5
 * @param {number}      pageId
 * @param {{write(key:string, blob:Blob):void}|null} imageWriter
 * @param {number}      [scale=2]
 * @returns {Promise<Object>} The mutated span
 */
export async function cutImageAndTable(
  span,
  oriImageList,
  extractOriginalImage,
  extractOriginalImageIouThresh,
  pageMat,
  pageImgMd5,
  pageId,
  imageWriter,
  scale = 2,
) {
  if (!span) return span;

  const spanType = span.type;
  const returnPath = (pathType) => `${pathType}/${pageImgMd5}`;

  if (!checkImgBbox(span.bbox) || !imageWriter) {
    span.image_path = '';
  } else {
    span.image_path = await cutImage(
      span,
      oriImageList,
      extractOriginalImage,
      extractOriginalImageIouThresh,
      pageId,
      pageMat,
      returnPath(spanType),
      imageWriter,
      scale,
    );
  }

  return span;
}
