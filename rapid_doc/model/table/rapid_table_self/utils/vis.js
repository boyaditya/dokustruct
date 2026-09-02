// Copyright (c) Opendatalab. All rights reserved.

/**
 * Table visualization helper — draws table cells and OCR boxes on canvas.
 */
export class VisTable {
  /**
   * Draw cell bounding boxes on a canvas copy of the source image.
   * @param {HTMLCanvasElement|ImageBitmap|ImageData} sourceImg
   * @param {number[][]} cellBboxes - Array of [x0,y0,x1,y1]
   * @param {string[][]} [logicPoints] - Optional logic cell coordinates
   * @returns {HTMLCanvasElement}
   */
  draw(sourceImg, cellBboxes, _logicPoints = null) {
    const canvas = document.createElement("canvas");
    const src = sourceImg instanceof ImageData
      ? this._imageDataToCanvas(sourceImg) : sourceImg;
    canvas.width = src.width ?? src.videoWidth;
    canvas.height = src.height ?? src.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(src, 0, 0);

    ctx.strokeStyle = "#0066ff";
    ctx.lineWidth = 2;

    for (let i = 0; i < cellBboxes.length; i++) {
      const [x0, y0, x1, y1] = cellBboxes[i];
      this.drawRectangle(ctx, x0, y0, x1, y1);
    }

    return canvas;
  }

  /**
   * Draw a rectangle on the canvas context.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   * @param {string} [color="#0066ff"]
   */
  drawRectangle(ctx, x0, y0, x1, y1, color = "#0066ff") {
    ctx.strokeStyle = color;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }

  /**
   * Draw a polyline (e.g., polygon bbox).
   * @param {CanvasRenderingContext2D} ctx
   * @param {number[][]} points - Array of [x,y] coordinates
   * @param {boolean} [close=true]
   */
  drawPolylines(ctx, points, close = true) {
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i][0], points[i][1]);
    }
    if (close) ctx.closePath();
    ctx.stroke();
  }

  /**
   * Plot OCR result boxes with logic point info.
   * @param {HTMLCanvasElement} canvas
   * @param {number[][]} dtBoxes
   * @param {[string, number][]} recRes
   * @returns {HTMLCanvasElement}
   */
  plotRecBoxWithLogicInfo(canvas, dtBoxes, recRes) {
    const ctx = canvas.getContext("2d");
    ctx.font = "12px sans-serif";
    ctx.strokeStyle = "#ff0000";
    ctx.lineWidth = 1;

    for (let i = 0; i < dtBoxes.length; i++) {
      const [x0, y0, x1, y1] = dtBoxes[i];
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      if (recRes[i]) {
        ctx.fillStyle = "rgba(255,0,0,0.7)";
        ctx.fillText(recRes[i][0], x0, y0 - 2);
      }
    }
    return canvas;
  }

  /** @private */
  _imageDataToCanvas(imageData) {
    const c = document.createElement("canvas");
    c.width = imageData.width;
    c.height = imageData.height;
    c.getContext("2d").putImageData(imageData, 0, 0);
    return c;
  }
}

export default VisTable;
