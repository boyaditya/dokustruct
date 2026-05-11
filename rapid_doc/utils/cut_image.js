/**
 * PORTING NOTE: cut_image.py → cut_image.js
 *
 * WORKAROUND: Python uses PIL.Image.crop() + filesystem writes via image_writer
 * REASON: No PIL or filesystem in the browser
 * SOLUTION:
 *   - page_pil_img is accepted as either a cv.Mat or an ImageBitmap/ImageData.
 *   - Cropping is done via Canvas 2D (OffscreenCanvas).
 *   - image_writer is expected to be a Map<string, Blob> (or any object with a
 *     .write(key, blob) method), replacing the disk-based FileBasedDataWriter.
 *   - str_sha256 → async SubtleCrypto SHA-256.
 *
 * AFFECTED METHODS:
 *   cut_image_and_table        → async cutImageAndTable(...)
 *   check_img_bbox             → checkImgBbox(bbox)
 *   cut_image (pdf_image_tools) → async cutImage(...)   [inline]
 *   get_crop_img                → syncGetCropImg(bbox, mat, scale)
 *   image_to_bytes              → async matToPngBlob(mat)
 */

import { getLogger } from './logger.js';
import { strSha256 } from './hash_utils.js';
import { calculateIou } from './boxbase.js';

const logger = getLogger('cut_image');

// ─── checkImgBbox ─────────────────────────────────────────────────────────────

/**
 * Validate that a bounding box is non-degenerate.
 * Matches Python: check_img_bbox(bbox)
 *
 * @param {number[]} bbox - [x0, y0, x1, y1]
 * @returns {boolean}
 */
export function checkImgBbox(bbox) {
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    logger.warning(`image_bboxes: invalid bbox, ${JSON.stringify(bbox)}`);
    return false;
  }
  return true;
}

// ─── getCropMat ───────────────────────────────────────────────────────────────

/**
 * Crop a region from a cv.Mat according to a scaled bbox.
 * Caller must .delete() the returned Mat.
 * Matches Python: get_crop_img(bbox, pil_img, scale=2)
 *
 * @param {number[]} bbox - [x0, y0, x1, y1] in original (unscaled) coordinates
 * @param {cv.Mat}  mat  - Source image Mat (BGR or RGBA)
 * @param {number}  [scale=2]
 * @returns {cv.Mat} Cropped Mat
 */
export function getCropMat(bbox, mat, scale = 2) {
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

  try {
    const rect = new cv.Rect(x0, y0, w, h);
    return mat.roi(rect); // returns a sub-matrix view; clone if mutation needed
  } catch (err) {
    console.error(`[getCropMat] FAILED: ${err.message || err}`);
    throw err;
  }
}

// ─── matToPngBlob ─────────────────────────────────────────────────────────────

/**
 * Encode a cv.Mat (BGR) to a PNG Blob.
 * Matches Python: image_to_bytes(crop_img, image_format="PNG")
 *
 * @param {cv.Mat} mat - BGR Mat
 * @returns {Promise<Blob>} PNG Blob
 */
export async function matToPngBlob(mat) {
  if (!mat || mat.isDeleted()) return null;
  // Convert BGR → RGBA for OffscreenCanvas
  let rgba = new cv.Mat();
  let cloned = mat.clone(); // Ensure it's not a view
  try {
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
    rgba.delete();
    cloned.delete();
  }
}

// ─── cutImage (inline port of pdf_image_tools.cut_image) ─────────────────────

/**
 * Crop a span's bbox from a page image, hash the path, store the PNG via
 * imageWriter, and return the stored key.
 *
 * Matches Python: cut_image(span, ori_image_list, extract_original_image,
 *                           extract_original_image_iou_thresh, page_num,
 *                           page_pil_img, return_path, image_writer, scale=2)
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
  const bbox = span.bbox;
  console.info(`[cutImage] span type=${span.type} bbox=${JSON.stringify(bbox)}`);
  let cropMat = null;
  let needDeleteCrop = false;

  // Try to use original embedded image if conditions match
  if (extractOriginalImage && span.type === 'image') {
    for (const oriImage of oriImageList) {
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

  let pngBlob;
  try {
    pngBlob = await matToPngBlob(cropMat);
  } finally {
    if (needDeleteCrop) cropMat.delete();
  }

  imageWriter.write(imgHash256Path, pngBlob);
  return imgHash256Path;
}

// ─── cutImageAndTable ─────────────────────────────────────────────────────────

/**
 * Crop an image or table span from a page and write the PNG via imageWriter.
 * Mutates span.image_path in-place, then returns the span.
 *
 * Matches Python: cut_image_and_table(span, ori_image_list, extract_original_image,
 *                                     extract_original_image_iou_thresh,
 *                                     page_pil_img, page_img_md5, page_id,
 *                                     image_writer, scale=2)
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
