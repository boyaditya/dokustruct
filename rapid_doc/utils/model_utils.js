// Copyright (c) Opendatalab. All rights reserved.

/**
 * Convert any page image representation to a BGR cv.Mat.
 * Handles OffscreenCanvas, ImageBitmap, and pass-through for existing cv.Mat.
 *
 * In the browser, PDF.js renders pages to OffscreenCanvas (RGBA).
 * This function normalises them all to CV_8UC3 BGR mats that the rest
 * of the pipeline (cropImg, OCR, table, formula crops) expects.
 *
 * @param {cv.Mat|OffscreenCanvas|ImageBitmap} img
 * @returns {{ mat: cv.Mat, owned: boolean }}
 *   owned=true means the caller MUST call mat.delete when finished.
 */
export function toMatBgr(img) {
  if (typeof cv !== 'undefined' && img instanceof cv.Mat) {
    return { mat: img, owned: false };
  }

  let imageData = null;

  if (typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas) {
    const ctx = img.getContext('2d', { willReadFrequently: true });
    imageData = ctx.getImageData(0, 0, img.width, img.height);
  } else if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
    const oc = new OffscreenCanvas(img.width, img.height);
    const ctx = oc.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    imageData = ctx.getImageData(0, 0, img.width, img.height);
  } else {
    throw new Error(`toMatBgr: unsupported image type: ${img?.constructor?.name ?? typeof img}`);
  }

  const rgba = cv.matFromImageData(imageData);
  const bgr  = new cv.Mat();
  try {
    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    return { mat: bgr, owned: true };
  } finally {
    rgba.delete();
  }
}

/**
 * Crop an image region using polygon/bbox, placing it on a white background.
 *
 * @param {object} inputRes - layout detection result with poly, optional polygon_points
 * @param {cv.Mat} inputImg - source image (cv.Mat BGR)
 * @param {number} [cropPasteX=0]
 * @param {number} [cropPasteY=0]
 * @param {object} [opts]
 * @param {string} [opts.layoutShapeMode='auto']
 * @returns {{ newImage: cv.Mat, usefulList: number[] }}
 */
export function cropImg(inputRes, inputImg, cropPasteX = 0, cropPasteY = 0, opts = {}) {
  const layoutShapeMode = opts.layoutShapeMode ?? 'auto';

  const poly = Array.isArray(inputRes.poly) ? inputRes.poly : [];
  const xs = [];
  const ys = [];
  for (let i = 0; i + 1 < poly.length; i += 2) {
    const x = Number(poly[i]);
    const y = Number(poly[i + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      xs.push(x);
      ys.push(y);
    }
  }
  if (!xs.length || !ys.length) {
    return {
      newImage: new cv.Mat(0, 0, typeof inputImg?.type === 'function' ? inputImg.type() : cv.CV_8UC3),
      usefulList: [cropPasteX, cropPasteY, 0, 0, 0, 0, 0, 0],
    };
  }

  const cropXmin = Math.trunc(Math.min(...xs));
  const cropYmin = Math.trunc(Math.min(...ys));
  const cropXmax = Math.trunc(Math.max(...xs));
  const cropYmax = Math.trunc(Math.max(...ys));

  const cropNewWidth  = cropXmax - cropXmin + cropPasteX * 2;
  const cropNewHeight = cropYmax - cropYmin + cropPasteY * 2;
  if (cropNewWidth <= 0 || cropNewHeight <= 0) {
    return {
      newImage: new cv.Mat(0, 0, typeof inputImg?.type === 'function' ? inputImg.type() : cv.CV_8UC3),
      usefulList: [cropPasteX, cropPasteY, cropXmin, cropYmin, cropXmax, cropYmax, 0, 0],
    };
  }

  const srcXmin = Math.max(0, Math.min(inputImg.cols, cropXmin));
  const srcYmin = Math.max(0, Math.min(inputImg.rows, cropYmin));
  const srcXmax = Math.max(0, Math.min(inputImg.cols, cropXmax));
  const srcYmax = Math.max(0, Math.min(inputImg.rows, cropYmax));
  const srcWidth = srcXmax - srcXmin;
  const srcHeight = srcYmax - srcYmin;

  const returnImage = new cv.Mat(cropNewHeight, cropNewWidth, inputImg.type());
  returnImage.setTo(new cv.Scalar(255, 255, 255, 255));

  if (srcWidth <= 0 || srcHeight <= 0) {
    const usefulList = [cropPasteX, cropPasteY, cropXmin, cropYmin, cropXmax, cropYmax, cropNewWidth, cropNewHeight];
    return { newImage: returnImage, usefulList };
  }

  const roi = inputImg.roi(new cv.Rect(srcXmin, srcYmin, srcWidth, srcHeight));
  const destX = cropPasteX + (srcXmin - cropXmin);
  const destY = cropPasteY + (srcYmin - cropYmin);

  if (layoutShapeMode !== 'rect' && inputRes.polygon_points) {
    const polygon = inputRes.polygon_points;
    const pts = cv.matFromArray(polygon.length / 2, 1, cv.CV_32SC2,
      polygon.map((v, i) => i % 2 === 0 ? v - cropXmin : v - cropYmin)
    );
    const mask = cv.Mat.zeros(roi.rows, roi.cols, cv.CV_8UC1);
    const ptsArr = new cv.MatVector();
    ptsArr.push_back(pts);
    cv.fillPoly(mask, ptsArr, new cv.Scalar(1));

    const maskedRoi = new cv.Mat(roi.rows, roi.cols, roi.type(), new cv.Scalar(255, 255, 255, 255));
    roi.copyTo(maskedRoi, mask);
    const destRoi = returnImage.roi(new cv.Rect(destX, destY, roi.cols, roi.rows));
    maskedRoi.copyTo(destRoi);
    maskedRoi.delete(); mask.delete(); pts.delete(); ptsArr.delete(); destRoi.delete();
  } else {
    const destRoi = returnImage.roi(new cv.Rect(destX, destY, roi.cols, roi.rows));
    roi.copyTo(destRoi);
    destRoi.delete();
  }
  roi.delete();

  const usefulList = [cropPasteX, cropPasteY, cropXmin, cropYmin, cropXmax, cropYmax, cropNewWidth, cropNewHeight];
  return { newImage: returnImage, usefulList };
}

/**
 * Get coordinates and area from a layout result.
 * @param {object} blockWithPoly
 * @returns {[number, number, number, number, number]}
 */
export function getCoordsAndArea(blockWithPoly) {
  const xmin = Math.trunc(blockWithPoly.poly[0]);
  const ymin = Math.trunc(blockWithPoly.poly[1]);
  const xmax = Math.trunc(blockWithPoly.poly[4]);
  const ymax = Math.trunc(blockWithPoly.poly[5]);
  return [xmin, ymin, xmax, ymax, (xmax - xmin) * (ymax - ymin)];
}

/**
 * Calculate intersection of two boxes, or null if no overlap.
 * @param {number[]} box1
 * @param {number[]} box2
 * @returns {number[]|null}
 */
export function calculateIntersection(box1, box2) {
  const xmin = Math.max(box1[0], box2[0]);
  const ymin = Math.max(box1[1], box2[1]);
  const xmax = Math.min(box1[2], box2[2]);
  const ymax = Math.min(box1[3], box2[3]);
  if (xmax <= xmin || ymax <= ymin) return null;
  return [xmin, ymin, xmax, ymax];
}

/**
 * Returns true if small_box is inside big_box by at least overlap_threshold.
 * @param {number[]} smallBox [x,y,x2,y2, area]
 * @param {number[]} bigBox
 * @param {number} [overlapThreshold=0.8]
 * @returns {boolean}
 */
export function isInside(smallBox, bigBox, overlapThreshold = 0.8) {
  const intersection = calculateIntersection(smallBox.slice(0, 4), bigBox.slice(0, 4));
  if (!intersection) return false;
  const [xmin, ymin, xmax, ymax] = intersection;
  const intersectionArea = (xmax - xmin) * (ymax - ymin);
  return intersectionArea >= overlapThreshold * smallBox[4];
}

/**
 * Extract OCR, table, and formula regions from layout results.
 *
 * @param {object[]} layoutRes
 * @param {cv.Mat} npImg
 * @param {number} [overlapThreshold=0.8]
 * @returns {{ocrResList: object[], tableResList: object[], formulaResList: object[]}}
 */
export function getResListFromLayoutRes(layoutRes, npImg, overlapThreshold = 0.8) {
  const ocrResList     = [];
  const tableResList   = [];
  const formulaResList = [];
  const imageResList   = [];

  for (const res of layoutRes) {
    const categoryId = parseInt(res.category_id, 10);
    if (categoryId === 3) {
      imageResList.push(res);
    }
    if ([8, 13, 14].includes(categoryId)) {
      if (!res.bbox) {
        res.bbox = [
          Math.trunc(res.poly[0]), Math.trunc(res.poly[1]),
          Math.trunc(res.poly[4]), Math.trunc(res.poly[5]),
        ];
      }
      formulaResList.push(res);
    } else if ([0, 1, 2, 4, 6, 7].includes(categoryId)) {
      ocrResList.push(res);
    } else if (categoryId === 5) {
      tableResList.push(res);
    }
  }

  for (const imgBox of imageResList) {
    for (const tblBox of tableResList) {
      if (isInside(getCoordsAndArea(imgBox), getCoordsAndArea(tblBox), overlapThreshold)) {
        if (!tblBox.layout_image_list) tblBox.layout_image_list = [];
        const { newImage: croppedMat } = cropImg(imgBox, npImg);
        tblBox.layout_image_list.push({
          uuid: crypto.randomUUID(),
          poly: imgBox.poly,
          pil_image: croppedMat,
        });
      }
    }
  }

  return { ocrResList, tableResList, formulaResList };
}

/**
 * Clean GPU/device memory.
 * - WASM: triggers JS GC if exposed (rare in production browsers).
 * - WebGPU: flushes pending work and releases the shared device, which is the
 *   only mechanism that returns ORT-Web's pooled GPU buffers to the driver.
 *   The next configureOrtRuntime call requests a fresh device + adapter.
 *
 * Pass `{ releaseGpu: false }` to flush only without destroying the device
 * (useful between batches that share the same warm session pool).
 *
 * @param {string} [device='wasm']
 * @param {{ releaseGpu?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function cleanMemory(device = 'wasm', opts = {}) {
  if (typeof globalThis.gc === 'function') {
    try { globalThis.gc(); } catch { /* ignore */ }
  }

  // Drain WebGPU work and optionally release the device.
  // Imported dynamically to avoid a hard dependency cycle with ort_runtime.
  if (device === 'webgpu' || device === 'gpu') {
    try {
      const mod = await import('./ort_runtime.js');
      if (opts.releaseGpu === false) {
        await mod.flushGpuQueue?.();
      } else {
        await mod.resetGpuRuntime?.();
      }
    } catch (err) {
      console.warn('[cleanMemory] GPU drain failed:', err?.message ?? err);
    }
  }
}

