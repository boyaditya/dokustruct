// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: model_utils.py → model_utils.js
 *
 * WORKAROUND: torch.cuda / torch_npu / gc.collect()
 * REASON: No PyTorch, CUDA, or GC control in browser
 * SOLUTION: cleanMemory/cleanVram are no-ops; getVram returns null.
 *
 * WORKAROUND: PIL.Image.fromarray / numpy slicing
 * REASON: No PIL/NumPy in browser
 * SOLUTION: cropImg uses cv.Mat; getResList uses ImageData.
 *
 * WORKAROUND: importlib.import_module
 * REASON: Dynamic imports are async in JS
 * SOLUTION: importPackage() always returns null (not used for feature detection).
 */

/**
 * Try to import a package by name.
 * PORTING NOTE: importlib.import_module → always null in browser
 * @param {string} _name
 * @returns {null}
 */
export function importPackage(_name) {
  return null;
}

/**
 * Convert any page image representation to a BGR cv.Mat.
 * Handles OffscreenCanvas, ImageBitmap, and pass-through for existing cv.Mat.
 *
 * PORTING NOTE: In Python the images are PIL/numpy arrays (RGB/BGR).
 *   In the browser, PDF.js renders pages to OffscreenCanvas (RGBA).
 *   This function normalises them all to CV_8UC3 BGR mats that the rest
 *   of the pipeline (cropImg, OCR, table, formula crops) expects.
 *
 * @param {cv.Mat|OffscreenCanvas|ImageBitmap} img
 * @returns {{ mat: cv.Mat, owned: boolean }}
 *   owned=true means the caller MUST call mat.delete() when finished.
 */
export function toMatBgr(img) {
  // Already a cv.Mat — caller owns it, we don't add a new reference
  if (typeof cv !== 'undefined' && img instanceof cv.Mat) {
    console.log(`[toMatBgr] Input is already cv.Mat (${img.cols}x${img.rows})`);
    return { mat: img, owned: false };
  }

  let imageData = null;

  if (typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas) {
    const ctx = img.getContext('2d');
    console.log(`[toMatBgr] Converting OffscreenCanvas (${img.width}x${img.height}) to BGR Mat...`);
    imageData = ctx.getImageData(0, 0, img.width, img.height);
  } else if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
    const oc = new OffscreenCanvas(img.width, img.height);
    const ctx = oc.getContext('2d');
    console.log(`[toMatBgr] Converting ImageBitmap (${img.width}x${img.height}) to BGR Mat...`);
    ctx.drawImage(img, 0, 0);
    imageData = ctx.getImageData(0, 0, img.width, img.height);
  } else {
    throw new Error(`toMatBgr: unsupported image type: ${img?.constructor?.name ?? typeof img}`);
  }

  // matFromImageData produces a CV_8UC4 RGBA mat
  const rgba = cv.matFromImageData(imageData);
  const bgr  = new cv.Mat();
  try {
    cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR);
    console.log(`[toMatBgr] BGR Mat created (${bgr.cols}x${bgr.rows})`);
    return { mat: bgr, owned: true };
  } finally {
    rgba.delete();
  }
}

/**
 * Check OpenVINO availability.
 * PORTING NOTE: openvino.runtime.Core → always false in browser
 * @returns {boolean}
 */
export function checkOpenvino() {
  return false;
}

/**
 * Crop an image region using polygon/bbox, placing it on a white background.
 * PORTING NOTE: numpy slicing + cv2.fillPoly → cv.mat operations
 *
 * @param {object} inputRes - layout detection result with poly, optional polygon_points
 * @param {cv.Mat} inputImg - source image (cv.Mat BGR)
 * @param {number} [cropPasteX=0]
 * @param {number} [cropPasteY=0]
 * @param {object} [opts]
 * @param {string} [opts.layoutShapeMode='auto']
 * @returns {{ newImage: cv.Mat, usefulList: number[] }}
 *   PORTING NOTE: return_image (np.array) → cv.Mat; return_list unchanged
 */
export function cropImg(inputRes, inputImg, cropPasteX = 0, cropPasteY = 0, opts = {}) {
  const layoutShapeMode = opts.layoutShapeMode ?? 'auto';

  const cropXmin = Math.trunc(inputRes.poly[0]);
  const cropYmin = Math.trunc(inputRes.poly[1]);
  const cropXmax = Math.trunc(inputRes.poly[4]);
  const cropYmax = Math.trunc(inputRes.poly[5]);

  const cropNewWidth  = cropXmax - cropXmin + cropPasteX * 2;
  const cropNewHeight = cropYmax - cropYmin + cropPasteY * 2;

  // Create white background
  const returnImage = new cv.Mat(cropNewHeight, cropNewWidth, inputImg.type());
  returnImage.setTo(new cv.Scalar(255, 255, 255, 255));

  // Crop region
  const roi = inputImg.roi(new cv.Rect(
    Math.max(0, cropXmin), Math.max(0, cropYmin),
    Math.min(cropXmax, inputImg.cols) - Math.max(0, cropXmin),
    Math.min(cropYmax, inputImg.rows) - Math.max(0, cropYmin),
  ));

  if (layoutShapeMode !== 'rect' && inputRes.polygon_points) {
    // Apply polygon mask
    const polygon = inputRes.polygon_points;
    const pts = cv.matFromArray(polygon.length / 2, 1, cv.CV_32SC2,
      polygon.map((v, i) => i % 2 === 0 ? v - cropXmin : v - cropYmin)
    );
    const mask = cv.Mat.zeros(roi.rows, roi.cols, cv.CV_8UC1);
    const ptsArr = new cv.MatVector();
    ptsArr.push_back(pts);
    cv.fillPoly(mask, ptsArr, new cv.Scalar(1));

    const maskedRoi = roi.clone();
    for (let r = 0; r < maskedRoi.rows; r++) {
      for (let c = 0; c < maskedRoi.cols; c++) {
        if (!mask.ucharAt(r, c)) {
          // Set to white
          maskedRoi.ucharPtr(r, c)[0] = 255;
          maskedRoi.ucharPtr(r, c)[1] = 255;
          maskedRoi.ucharPtr(r, c)[2] = 255;
        }
      }
    }
    const destRoi = returnImage.roi(new cv.Rect(cropPasteX, cropPasteY, roi.cols, roi.rows));
    maskedRoi.copyTo(destRoi);
    maskedRoi.delete(); mask.delete(); pts.delete(); ptsArr.delete();
  } else {
    const destRoi = returnImage.roi(new cv.Rect(cropPasteX, cropPasteY, roi.cols, roi.rows));
    roi.copyTo(destRoi);
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
 * PORTING NOTE: get_res_list_from_layout_res → getResListFromLayoutRes
 * PIL.Image.fromarray → createImageBitmap from cv.Mat
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

  // Find images inside tables
  for (const imgBox of imageResList) {
    for (const tblBox of tableResList) {
      if (isInside(getCoordsAndArea(imgBox), getCoordsAndArea(tblBox), overlapThreshold)) {
        if (!tblBox.layout_image_list) tblBox.layout_image_list = [];
        const { newImage: croppedMat } = cropImg(imgBox, npImg);
        tblBox.layout_image_list.push({
          uuid: crypto.randomUUID(),
          poly: imgBox.poly,
          pil_image: croppedMat, // cv.Mat used instead of PIL.Image
        });
      }
    }
  }

  return { ocrResList, tableResList, formulaResList };
}

/**
 * Clean GPU/device memory.
 * PORTING NOTE: torch.cuda.empty_cache() → no-op in browser
 * @param {string} [_device='wasm']
 */
export function cleanMemory(_device = 'wasm') {
  // No GPU memory management in browser
}

/**
 * Clean VRAM if below threshold.
 * PORTING NOTE: torch VRAM detection → no-op in browser
 * @param {string} _device
 * @param {number} [_vramThreshold=8]
 */
export function cleanVram(_device, _vramThreshold = 8) {
  // No VRAM management in browser
}

/**
 * Get VRAM size in GB.
 * PORTING NOTE: torch.cuda.get_device_properties → always null in browser
 * @param {string} _device
 * @returns {null}
 */
export function getVram(_device) {
  return null;
}
