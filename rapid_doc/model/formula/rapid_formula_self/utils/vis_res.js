// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: vis_res.py → vis_res.js
// Python matplotlib/Pillow visualization → browser Canvas 2D API

/**
 * Visualization helper for formula/layout detection results.
 * PORTING NOTE: VisLayout.draw_detections → drawDetections using Canvas 2D API
 */
export class VisLayout {
  /**
   * Draw detection boxes and labels on a copy of the source image.
   * @param {ImageBitmap|ImageData|HTMLCanvasElement} sourceImg
   * @param {Array<{bbox: number[], label: string, score?: number}>} detections
   * @param {object} [opts]
   * @param {number} [opts.lineThickness=2]
   * @param {number} [opts.fontSize=14]
   * @returns {HTMLCanvasElement}
   */
  drawDetections(sourceImg, detections, { lineThickness = 2, fontSize = 14 } = {}) {
    const canvas = document.createElement("canvas");
    const [w, h] = sourceImg instanceof ImageData
      ? [sourceImg.width, sourceImg.height]
      : [sourceImg.width, sourceImg.height];
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(sourceImg instanceof ImageData ? this._imageDataToCanvas(sourceImg) : sourceImg, 0, 0);

    for (let i = 0; i < detections.length; i++) {
      const det = detections[i];
      const color = this.getColor(i);
      this.drawBox(ctx, det.bbox, color, lineThickness);
      const label = det.score != null
        ? `${det.label}: ${det.score.toFixed(3)}`
        : det.label;
      this.drawText(ctx, label, [det.bbox[0], det.bbox[1]], color, fontSize);
    }
    return canvas;
  }

  /**
   * Draw a single bounding box.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number[]} bbox [x0,y0,x1,y1]
   * @param {string} color
   * @param {number} [thickness=2]
   */
  drawBox(ctx, bbox, color, thickness = 2) {
    const [x0, y0, x1, y1] = bbox;
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }

  /**
   * Draw text label at position.
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} text
   * @param {number[]} pos [x, y]
   * @param {string} color
   * @param {number} fontSize
   */
  drawText(ctx, text, pos, color, fontSize = 14) {
    ctx.font = `${fontSize}px sans-serif`;
    const metrics = ctx.measureText(text);
    const bh = fontSize + 4;
    ctx.fillStyle = color;
    ctx.fillRect(pos[0], pos[1] - bh, metrics.width + 4, bh);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, pos[0] + 2, pos[1] - 3);
  }

  /**
   * Get deterministic color for index.
   * @param {number} idx
   * @returns {string} CSS color string
   */
  getColor(idx) {
    const palette = [
      "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
      "#911eb4", "#42d4f4", "#f032e6", "#bfef45", "#fabebe",
      "#469990", "#e6beff", "#9a6324", "#fffac8", "#800000",
    ];
    return palette[idx % palette.length];
  }

  /**
   * @param {ImageData} imageData
   * @returns {HTMLCanvasElement}
   */
  _imageDataToCanvas(imageData) {
    const c = document.createElement("canvas");
    c.width = imageData.width;
    c.height = imageData.height;
    c.getContext("2d").putImageData(imageData, 0, 0);
    return c;
  }
}

export default VisLayout;
