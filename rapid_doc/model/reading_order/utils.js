// Copyright (c) Opendatalab. All rights reserved.

// ─────────────────────────────────────────────────────────────
// Standalone geometry helpers (operate on plain [x1,y1,x2,y2] arrays)
// ─────────────────────────────────────────────────────────────

export function caculateBboxArea(bbox) {
  const [x1, y1, x2, y2] = bbox.map(Number);
  return Math.abs((x2 - x1) * (y2 - y1));
}

/**
 * Calculate overlap ratio between two bounding boxes.
 * @param {number[]} bbox1 [x1,y1,x2,y2]
 * @param {number[]} bbox2 [x1,y1,x2,y2]
 * @param {"union"|"small"|"large"} mode
 * @returns {number}
 */
export function calculateOverlapRatio(bbox1, bbox2, mode = "union") {
  const xMinInter = Math.max(bbox1[0], bbox2[0]);
  const yMinInter = Math.max(bbox1[1], bbox2[1]);
  const xMaxInter = Math.min(bbox1[2], bbox2[2]);
  const yMaxInter = Math.min(bbox1[3], bbox2[3]);

  const interW = Math.max(0, xMaxInter - xMinInter);
  const interH = Math.max(0, yMaxInter - yMinInter);
  const interArea = interW * interH;

  const area1 = caculateBboxArea(bbox1);
  const area2 = caculateBboxArea(bbox2);

  let refArea;
  if (mode === "union") refArea = area1 + area2 - interArea;
  else if (mode === "small") refArea = Math.min(area1, area2);
  else if (mode === "large") refArea = Math.max(area1, area2);
  else throw new Error(`Invalid mode: ${mode}`);

  return refArea === 0 ? 0.0 : interArea / refArea;
}

/**
 * Returns 1 to drop bbox1, 2 to drop bbox2, or null if no overlap exceeds ratio.
 */
export function _getMinboxIfOverlapByRatio(bbox1, bbox2, ratio, smaller = true) {
  const area1 = caculateBboxArea(bbox1);
  const area2 = caculateBboxArea(bbox2);
  const overlapRatio = calculateOverlapRatio(bbox1, bbox2, "small");

  if (overlapRatio > ratio) {
    if ((area1 <= area2 && smaller) || (area1 >= area2 && !smaller)) return 1;
    else return 2;
  }
  return null;
}

/**
 * Remove overlapping bounding boxes.
 * @param {number[][]} bboxes  List of [x1,y1,x2,y2]
 * @param {number} threshold
 * @param {boolean} smaller   Drop the smaller box when true
 * @returns {[number[][], number[][]]} [updatedBboxes, droppedBoxes]
 */
export function removeOverlapBlocks(bboxes, threshold = 0.65, smaller = true) {
  const dropped = new Set();
  const copy = bboxes.map((b) => [...b]);
  const droppedBoxes = [];

  for (let i = 0; i < copy.length; i++) {
    for (let j = i + 1; j < copy.length; j++) {
      if (dropped.has(i) || dropped.has(j)) continue;
      const flag = _getMinboxIfOverlapByRatio(copy[i], copy[j], threshold, smaller);
      if (flag !== null) {
        dropped.add(flag === 1 ? i : j);
      }
    }
  }

  const sortedDropped = [...dropped].sort((a, b) => b - a);
  for (const idx of sortedDropped) {
    droppedBoxes.push(copy[idx]);
    copy.splice(idx, 1);
  }

  return [copy, droppedBoxes];
}

// ─────────────────────────────────────────────────────────────
// VisReadOrder  (cv2 drawing → Canvas 2D API)
// ─────────────────────────────────────────────────────────────

/**
 * Visualise reading order on a canvas.
 *
 * Works in browser (HTMLCanvasElement / OffscreenCanvas) and Node.js environments
 * that expose OffscreenCanvas or a compatible canvas API.
 *
 * All methods are static; no instance state required.
 */
export class VisReadOrder {
  /**
   * Draw reading-order overlay on top of `image`.
   *
   * @param {ImageBitmap|ImageData|HTMLImageElement|OffscreenCanvas} image
   *   Source image. Accepts anything accepted by `CanvasRenderingContext2D.drawImage`.
   *   If `image` has a `width` / `height` properties they are used; otherwise pass
   *   `imageWidth` / `imageHeight` explicitly.
   * @param {number[][]} boxes          [[x1,y1,x2,y2], ...]
   * @param {number[]}   orderIndexes   Order label per box
   * @param {number}     maskAlpha      Opacity for colour fill (0–1). Default 0.3
   * @param {number|null} imageWidth    Required only when image has no .width
   * @param {number|null} imageHeight   Required only when image has no .height
   * @returns {OffscreenCanvas|null}
   */
  static drawOrder(
    image,
    boxes,
    orderIndexes,
    maskAlpha = 0.3,
    imageWidth = null,
    imageHeight = null
  ) {
    if (!boxes || !orderIndexes) return null;

    const w = image?.width ?? imageWidth;
    const h = image?.height ?? imageHeight;
    if (!w || !h) return null;

    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(w, h)
        : document.createElement("canvas");

    if (!("OffscreenCanvas" in globalThis)) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);

    VisReadOrder.drawMasks(ctx, boxes, maskAlpha, w, h);

    const fontSizePx = Math.max(12, Math.min(w, h) * 0.02);

    for (let i = 0; i < boxes.length; i++) {
      const color = VisReadOrder.getColor();
      VisReadOrder.drawBox(ctx, boxes[i], color);
      VisReadOrder.drawText(ctx, String(orderIndexes[i]), boxes[i], color, fontSizePx);
    }

    return canvas;
  }

  /**
   * Draw a rectangle outline.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number[]} box  [x1,y1,x2,y2]
   * @param {number[]} color [r,g,b]
   * @param {number} lineWidth
   */
  static drawBox(ctx, box, color = [0, 0, 255], lineWidth = 2) {
    const [x1, y1, x2, y2] = box.map(Math.round);
    ctx.strokeStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
    ctx.lineWidth = lineWidth;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  }

  /**
   * Draw a text label with a filled background inside the box.
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} text
   * @param {number[]} box  [x1,y1,x2,y2]
   * @param {number[]} color [r,g,b] — background colour
   * @param {number} fontSizePx
   */
  static drawText(ctx, text, box, color = [0, 0, 255], fontSizePx = 14) {
    const [x1, y1] = box.map(Math.round);
    ctx.font = `${fontSizePx}px sans-serif`;

    const metrics = ctx.measureText(text);
    const tw = Math.ceil(metrics.width);
    const th = Math.ceil(fontSizePx * 1.2);

    ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
    ctx.fillRect(x1, y1 - th, tw, th);

    ctx.fillStyle = "rgb(255,255,255)";
    ctx.textBaseline = "bottom";
    ctx.fillText(text, x1, y1);
  }

  /**
   * Draw semi-transparent filled rectangles for all boxes.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number[][]} boxes
   * @param {number} maskAlpha
   * @param {number} w
   * @param {number} h
   */
  static drawMasks(ctx, boxes, maskAlpha = 0.3, w, h) {
    const tmpCanvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(w, h)
        : (() => {
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            return c;
          })();

    const tmpCtx = tmpCanvas.getContext("2d");
    tmpCtx.drawImage(ctx.canvas, 0, 0);

    for (const box of boxes) {
      const color = VisReadOrder.getColor();
      const [x1, y1, x2, y2] = box.map(Math.round);
      tmpCtx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
      tmpCtx.fillRect(x1, y1, x2 - x1, y2 - y1);
    }

    // composite: mask * alpha + original * (1 - alpha)
    ctx.globalAlpha = maskAlpha;
    ctx.drawImage(tmpCanvas, 0, 0);
    ctx.globalAlpha = 1.0;
  }

  /**
   * Random RGB colour.
   * @returns {[number, number, number]}
   */
  static getColor() {
    return [
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
      Math.floor(Math.random() * 256),
    ];
  }
}
