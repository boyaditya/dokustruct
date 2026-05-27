/**
 * LetterBox, scaleBoxes, clipBoxes — image resize/pad and box coordinate utilities.
 *
 * This module returns raw cv.Mat objects. Callers are responsible
 * for calling .delete() on every Mat returned (try/finally pattern).
 */

/* global cv */

// ─── LetterBox ────────────────────────────────────────────────────────────────

export class LetterBox {
  /**
   * @param {{
   *   newShape?: [number, number],
   *   auto?: boolean,
   *   scaleFill?: boolean,
   *   scaleup?: boolean,
   *   center?: boolean,
   *   stride?: number,
   * }} [opts]
   */
  constructor({
    newShape = [640, 640],
    auto = false,
    scaleFill = false,
    scaleup = true,
    center = true,
    stride = 32,
  } = {}) {
    this.newShape = newShape;   // [H, W]  (same convention as Python)
    this.auto = auto;
    this.scaleFill = scaleFill;
    this.scaleup = scaleup;
    this.stride = stride;
    this.center = center;
  }

  /**
   * Resize + pad an image into the target shape.
   * Mirrors: __call__(labels=None, image=None)
   *
   * @param {cv.Mat} image    - Input BGR cv.Mat
   * @param {Object} [labels] - Optional label dict (update not implemented; pass {} to skip)
   * @returns {cv.Mat}        - New cv.Mat (caller must delete)
   */
  call(image, labels = {}) {
    const [srcH, srcW] = [image.rows, image.cols];
    const newShape = labels.rect_shape ?? this.newShape;  // [H, W]
    const [targetH, targetW] = Array.isArray(newShape) ? newShape : [newShape, newShape];

    // Scale ratio (new / old)
    let r = Math.min(targetH / srcH, targetW / srcW);
    if (!this.scaleup) r = Math.min(r, 1.0);

    let dw = targetW - Math.round(srcW * r);
    let dh = targetH - Math.round(srcH * r);

    if (this.auto) {
      dw = dw % this.stride;
      dh = dh % this.stride;
    } else if (this.scaleFill) {
      dw = 0;
      dh = 0;
      r = targetW / srcW;    // keep W ratio (may stretch)
    }

    const newUnpadW = Math.round(srcW * r);
    const newUnpadH = Math.round(srcH * r);

    // When center=true, divide padding between both sides.
    // When center=false, all padding goes to bottom/right (top=0, left=0).
    // Python: if self.center: dw /= 2; dh /= 2
    //         top  = int(round(dh - 0.1)) if self.center else 0
    //         left = int(round(dw - 0.1)) if self.center else 0
    //         bottom = int(round(dh + 0.1))   # uses dh AFTER optional /2
    //         right  = int(round(dw + 0.1))   # uses dw AFTER optional /2
    const halfDw = this.center ? dw / 2 : 0;
    const halfDh = this.center ? dh / 2 : 0;
    const padLeft   = this.center ? Math.round(halfDw - 0.1) : 0;
    const padRight  = this.center ? Math.round(halfDw + 0.1) : Math.round(dw + 0.1);
    const padTop    = this.center ? Math.round(halfDh - 0.1) : 0;
    const padBottom = this.center ? Math.round(halfDh + 0.1) : Math.round(dh + 0.1);

    let resized = image;
    let tempResized = null;
    if (newUnpadW !== srcW || newUnpadH !== srcH) {
      tempResized = new cv.Mat();
      cv.resize(
        image,
        tempResized,
        new cv.Size(newUnpadW, newUnpadH),
        0, 0,
        cv.INTER_LINEAR,
      );
      resized = tempResized;
    }

    const bordered = new cv.Mat();
    const borderValue = new cv.Scalar(114, 114, 114, 0);
    cv.copyMakeBorder(
      resized,
      bordered,
      padTop, padBottom,
      padLeft, padRight,
      cv.BORDER_CONSTANT,
      borderValue,
    );

    if (tempResized) tempResized.delete();

    return bordered;
  }
}

// ─── scale_boxes ──────────────────────────────────────────────────────────────

/**
 * Rescale bounding boxes from img1_shape space back to img0_shape space.
 * Mirrors: scale_boxes(img1_shape, boxes, img0_shape, ratio_pad, padding, xywh)
 *
 * @param {[number,number]} img1Shape - [H1, W1] — augmented image shape
 * @param {Float32Array}    boxes     - Flat array of boxes in [x1,y1,x2,y2] order (every 4 elements)
 * @param {[number,number]} img0Shape - [H0, W0] — original image shape
 * @param {null|[[number,number],[number,number]]} [ratioPad]
 * @param {boolean}         [padding=true]
 * @param {boolean}         [xywh=false]
 * @returns {Float32Array}
 */
export function scaleBoxes(img1Shape, boxes, img0Shape, ratioPad = null, padding = true, xywh = false) {
  let gain, padX, padY;

  if (ratioPad === null) {
    gain = Math.min(img1Shape[0] / img0Shape[0], img1Shape[1] / img0Shape[1]);
    padX = Math.round((img1Shape[1] - img0Shape[1] * gain) / 2 - 0.1);
    padY = Math.round((img1Shape[0] - img0Shape[0] * gain) / 2 - 0.1);
  } else {
    gain = ratioPad[0][0];
    [padX, padY] = ratioPad[1];
  }

  const out = new Float32Array(boxes.length);
  for (let i = 0; i < boxes.length; i += 4) {
    let x1 = boxes[i];
    let y1 = boxes[i + 1];
    let x2 = boxes[i + 2];
    let y2 = boxes[i + 3];

    if (padding) {
      x1 -= padX;
      y1 -= padY;
      if (!xywh) {
        x2 -= padX;
        y2 -= padY;
      }
    }

    out[i]     = x1 / gain;
    out[i + 1] = y1 / gain;
    out[i + 2] = x2 / gain;
    out[i + 3] = y2 / gain;
  }

  return clipBoxes(out, img0Shape);
}

// ─── clipBoxes ────────────────────────────────────────────────────────────────

/**
 * Clip boxes to stay within the image boundaries.
 * Mirrors: clip_boxes(boxes, shape)
 *
 * @param {Float32Array}    boxes
 * @param {[number,number]} shape - [H, W]
 * @returns {Float32Array}
 */
export function clipBoxes(boxes, shape) {
  const [imgH, imgW] = shape;
  const out = new Float32Array(boxes.length);
  for (let i = 0; i < boxes.length; i += 4) {
    out[i]     = Math.max(0, Math.min(imgW, boxes[i]));     // x1
    out[i + 1] = Math.max(0, Math.min(imgH, boxes[i + 1])); // y1
    out[i + 2] = Math.max(0, Math.min(imgW, boxes[i + 2])); // x2
    out[i + 3] = Math.max(0, Math.min(imgH, boxes[i + 3])); // y2
  }
  return out;
}
