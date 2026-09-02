/**
 * draw_bbox.js — Render bounding box overlays onto PDF pages.
 *
 * Browser workaround: Python uses reportlab + pypdf for PDF drawing.
 * Here we render pages via pdfjs-dist to OffscreenCanvas, draw overlays
 * with Canvas 2D API, and return PNG Blobs (one per page).
 * reportlab coordinate system (origin bottom-left, y-up) is preserved
 * inside calCanvasRect/calCanvasPolygon for correctness, then mapped
 * to HTML canvas coordinates (y-down).
 */

import { getPdfjsLib } from './pdfjs_loader.js';
import { BlockType, ContentType, SplitFlag } from './enum_class.js';

// ─── Page-info helper ─────────────────────────────────────────────────────────

/**
 * Extract page size and rotation from a PDF.js page object.
 *
 * @param {import('pdfjs-dist').PDFPageProxy} pdfPage
 * @returns {{ pageWidth: number, pageHeight: number, rotation: number }}
 */
function getPageInfo(pdfPage) {
  const viewport = pdfPage.getViewport({ scale: 1 });
  const rotation = (pdfPage.rotate ?? 0) % 360;
  return { pageWidth: viewport.width, pageHeight: viewport.height, rotation };
}

// ─── calCanvasRect ────────────────────────────────────────────────────────────

/**
 * Convert a PDF-coordinate bbox [x0,y0,x1,y1] to Canvas 2D draw rect [x, y, w, h].
 * Handles page rotation (0 / 90 / 180 / 270).
 *
 * NOTE: In PDF.js the viewport already accounts for rotation, so we apply the
 * same rotation-based transformations as the Python reportlab code.
 *
 * @param {{ pageWidth:number, pageHeight:number, rotation:number }} pageInfo
 * @param {number[]} bbox - [x0, y0, x1, y1]
 * @returns {[number, number, number, number]} [x, y, w, h] in canvas coords
 */
export function calCanvasRect(pageInfo, bbox) {
  const { pageWidth, pageHeight, rotation } = pageInfo;
  let { 0: x0, 1: y0, 2: x1, 3: y1 } = bbox;

  let rectW = Math.abs(x1 - x0);
  let rectH = Math.abs(y1 - y0);
  let rx, ry;

  if (rotation === 270) {
    [rectW, rectH] = [rectH, rectW];
    rx = pageHeight - y1;
    ry = pageWidth - x1;
  } else if (rotation === 180) {
    rx = pageWidth - x1;
    ry = y0;
  } else if (rotation === 90) {
    [rectW, rectH] = [rectH, rectW];
    rx = y0;
    ry = x0;
  } else {
    // rotation === 0: PDF y is bottom-up → flip for Canvas (y-down)
    rx = x0;
    ry = pageHeight - y1;
  }

  return [rx, ry, rectW, rectH];
}

// ─── calCanvasPolygon ─────────────────────────────────────────────────────────

/**
 * Convert a list of PDF-coordinate polygon points to Canvas 2D coordinates.
 *
 * @param {{ pageWidth:number, pageHeight:number, rotation:number }} pageInfo
 * @param {number[][]} polygonPoints - [[x,y], ...]
 * @returns {number[][]}
 */
export function calCanvasPolygon(pageInfo, polygonPoints) {
  const { pageWidth, pageHeight, rotation } = pageInfo;
  return polygonPoints.map(([x, y]) => {
    let cx, cy;
    if (rotation === 270) {
      cx = pageHeight - y;
      cy = pageWidth - x;
    } else if (rotation === 180) {
      cx = pageWidth - x;
      cy = y;
    } else if (rotation === 90) {
      cx = y;
      cy = x;
    } else {
      cx = x;
      cy = pageHeight - y;
    }
    return [cx, cy];
  });
}

// ─── drawPolygon ──────────────────────────────────────────────────────────────

/**
 * Draw a filled or stroked polygon on a 2D canvas context.
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {number[][]} points - [[x,y], ...] at least 3 points
 * @param {[number,number,number]} rgb - [r, g, b] range 0-255
 * @param {boolean} fill
 */
export function drawPolygon(ctx, points, rgb, fill) {
  if (points.length < 3) return;
  const [r, g, b] = rgb;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = `rgba(${r},${g},${b},0.3)`;
    ctx.fill();
  } else {
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.stroke();
  }
}

// ─── drawBboxWithoutNumber ────────────────────────────────────────────────────

/**
 * Draw bounding boxes (or polygons) for all items on page `i` without labels.
 *
 * @param {number} pageIdx
 * @param {Array<Array<{bbox?:number[], polygon_points?:number[][]}>>} bboxList
 * @param {{ pageWidth:number, pageHeight:number, rotation:number }} pageInfo
 * @param {CanvasRenderingContext2D} ctx
 * @param {[number,number,number]} rgbConfig - [r,g,b] 0-255
 * @param {boolean} fillConfig
 */
export function drawBboxWithoutNumber(pageIdx, bboxList, pageInfo, ctx, rgbConfig, fillConfig) {
  const pageData = bboxList[pageIdx] ?? [];
  const [r, g, b] = rgbConfig;

  for (const item of pageData) {
    const bbox = item.bbox ?? item;
    const polyPts = item.polygon_points ?? null;

    if (polyPts && polyPts.length >= 3) {
      const canvasPoly = calCanvasPolygon(pageInfo, polyPts);
      drawPolygon(ctx, canvasPoly, rgbConfig, fillConfig);
    } else if (bbox) {
      const [x, y, w, h] = calCanvasRect(pageInfo, bbox);
      if (fillConfig) {
        ctx.fillStyle = `rgba(${r},${g},${b},0.3)`;
        ctx.fillRect(x, y, w, h);
      } else {
        ctx.strokeStyle = `rgb(${r},${g},${b})`;
        ctx.strokeRect(x, y, w, h);
      }
    }
  }
}

// ─── drawBboxWithNumber ───────────────────────────────────────────────────────

/**
 * Draw bounding boxes with sequence numbers.
 *
 * @param {number} pageIdx
 * @param {Array} bboxList
 * @param {{ pageWidth:number, pageHeight:number, rotation:number }} pageInfo
 * @param {CanvasRenderingContext2D} ctx
 * @param {[number,number,number]} rgbConfig
 * @param {boolean} fillConfig
 * @param {boolean} [drawBbox=true]
 */
export function drawBboxWithNumber(pageIdx, bboxList, pageInfo, ctx, rgbConfig, fillConfig, drawBbox = true) {
  const pageData = bboxList[pageIdx] ?? [];
  const [r, g, b] = rgbConfig;

  for (let j = 0; j < pageData.length; j++) {
    const item = pageData[j];
    const bbox = item.bbox ?? item;
    const polyPts = item.polygon_points ?? null;

    if (!bbox) continue;

    const [x, y, w, h] = calCanvasRect(pageInfo, bbox);

    if (drawBbox) {
      if (polyPts && polyPts.length >= 3) {
        const canvasPoly = calCanvasPolygon(pageInfo, polyPts);
        drawPolygon(ctx, canvasPoly, rgbConfig, fillConfig);
      } else {
        if (fillConfig) {
          ctx.fillStyle = `rgba(${r},${g},${b},0.3)`;
          ctx.fillRect(x, y, w, h);
        } else {
          ctx.strokeStyle = `rgb(${r},${g},${b})`;
          ctx.strokeRect(x, y, w, h);
        }
      }
    }

    // Draw sequence number label at appropriate corner
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.font = '10px sans-serif';
    ctx.fillText(String(j + 1), x + w + 2, y + h - 2);
  }
}

// ─── _layoutItem helper ───────────────────────────────────────────────────────

/**
 * Normalise an item to { bbox, polygon_points } format.
 *
 * @param {number[]} bbox
 * @param {number[][]|null} [polygonPoints]
 * @returns {{ bbox: number[], polygon_points: number[][]|null }}
 */
function _layoutItem(bbox, polygonPoints = null) {
  return {
    bbox,
    polygon_points: (polygonPoints && polygonPoints.length >= 3) ? polygonPoints : null,
  };
}

// ─── PDF rendering helper ─────────────────────────────────────────────────────

/**
 * Render a PDF page to an OffscreenCanvas at 1× scale (logical PDF point size).
 *
 * @param {import('pdfjs-dist').PDFPageProxy} pdfPage
 * @param {number} [scale=1.0]
 * @returns {Promise<OffscreenCanvas>}
 */
async function renderPageToCanvas(pdfPage, scale = 1.0) {
  const viewport = pdfPage.getViewport({ scale });
  const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

// ─── drawLayoutBbox ───────────────────────────────────────────────────────────

/**
 * Render layout bounding box overlays onto each PDF page.
 * Returns an array of PNG Blobs (one per page).
 *
 * @param {Object[]} pdfInfo - Parsed middle-JSON page structures
 * @param {ArrayBuffer} pdfBytes
 * @returns {Promise<Blob[]>}
 */
export async function drawLayoutBbox(pdfInfo, pdfBytes) {
  const droppedBboxList = [];
  const tablesBodyList = [], tablesCaptionList = [], tablesFootnoteList = [];
  const imgsBodyList = [], imgsCaptionList = [], imgsFootnoteList = [];
  const codesBodyList = [], codesCaptionList = [];
  const titlesList = [], textsList = [], interequationsList = [];
  const listsList = [], listItemsList = [], indexsList = [];

  for (const page of pdfInfo) {
    const pageDropped = [];
    const tablesBody = [], tablesCaption = [], tablesFootnote = [];
    const imgsBody = [], imgsCaption = [], imgsFootnote = [];
    const codesBody = [], codesCaption = [];
    const titles = [], texts = [], interequations = [];
    const lists = [], listItems = [], indices = [];

    for (const b of (page.discarded_blocks ?? [])) {
      pageDropped.push(_layoutItem(b.bbox, b.polygon_points));
    }
    droppedBboxList.push(pageDropped);

    for (const block of (page.para_blocks ?? [])) {
      const bbox = block.bbox;
      const poly = block.polygon_points ?? null;

      if (block.type === BlockType.TABLE) {
        for (const nb of (block.blocks ?? [])) {
          const item = _layoutItem(nb.bbox, nb.polygon_points);
          if (nb.type === BlockType.TABLE_BODY) tablesBody.push(item);
          else if (nb.type === BlockType.TABLE_CAPTION) tablesCaption.push(item);
          else if (nb.type === BlockType.TABLE_FOOTNOTE) {
            if (!nb[SplitFlag?.CROSS_PAGE]) tablesFootnote.push(item);
          }
        }
      } else if (block.type === BlockType.IMAGE) {
        for (const nb of (block.blocks ?? [])) {
          const item = _layoutItem(nb.bbox, nb.polygon_points);
          if (nb.type === BlockType.IMAGE_BODY) imgsBody.push(item);
          else if (nb.type === BlockType.IMAGE_CAPTION) imgsCaption.push(item);
          else if (nb.type === BlockType.IMAGE_FOOTNOTE) imgsFootnote.push(item);
        }
      } else if (block.type === BlockType.CODE) {
        for (const nb of (block.blocks ?? [])) {
          const item = _layoutItem(nb.bbox, nb.polygon_points);
          if (nb.type === 'code_body') codesBody.push(item);
          else if (nb.type === 'code_caption') codesCaption.push(item);
        }
      } else if (block.type === BlockType.TITLE) {
        titles.push(_layoutItem(bbox, poly));
      } else if ([BlockType.TEXT, 'ref_text'].includes(block.type)) {
        texts.push(_layoutItem(bbox, poly));
      } else if (block.type === BlockType.INTERLINE_EQUATION) {
        interequations.push(_layoutItem(bbox, poly));
      } else if (block.type === 'list') {
        lists.push(_layoutItem(bbox, poly));
        for (const sub of (block.blocks ?? [])) {
          listItems.push(_layoutItem(sub.bbox, sub.polygon_points));
        }
      } else if (block.type === 'index') {
        indices.push(_layoutItem(bbox, poly));
      }
    }

    tablesBodyList.push(tablesBody); tablesCaptionList.push(tablesCaption); tablesFootnoteList.push(tablesFootnote);
    imgsBodyList.push(imgsBody); imgsCaptionList.push(imgsCaption); imgsFootnoteList.push(imgsFootnote);
    titlesList.push(titles); textsList.push(texts); interequationsList.push(interequations);
    listsList.push(lists); listItemsList.push(listItems); indexsList.push(indices);
    codesBodyList.push(codesBody); codesCaptionList.push(codesCaption);
  }

  // Build layout_bbox_list (numbered boxes) and inner_layout_bbox_list
  const layoutBboxList = [];
  const innerLayoutBboxList = [];

  for (const page of pdfInfo) {
    const pageBlockList = [];
    const pageInnerList = [];
    for (const block of (page.para_blocks ?? [])) {
      const bbox = block.bbox;
      const poly = block.polygon_points ?? null;
      if ([BlockType.TEXT, 'ref_text', BlockType.TITLE, BlockType.INTERLINE_EQUATION, 'list', 'index'].includes(block.type)) {
        pageBlockList.push(_layoutItem(bbox, poly));
      } else if (block.type === BlockType.IMAGE) {
        for (const sub of (block.blocks ?? [])) pageBlockList.push(_layoutItem(sub.bbox, sub.polygon_points));
      } else if (block.type === BlockType.TABLE) {
        const sortedBlocks = [...(block.blocks ?? [])].sort(
          (a, b) => ({'table_caption':1,'table_body':2,'table_footnote':3}[a.type]||0) - ({'table_caption':1,'table_body':2,'table_footnote':3}[b.type]||0)
        );
        for (const sub of sortedBlocks) {
          if (sub[SplitFlag?.CROSS_PAGE]) continue;
          pageBlockList.push(_layoutItem(sub.bbox, sub.polygon_points));
          for (const line of (sub.lines ?? [])) {
            for (const span of (line.spans ?? [])) {
              if (span.img_boxes) pageInnerList.push(...span.img_boxes);
              if (span.latex_boxes) pageInnerList.push(...span.latex_boxes);
            }
          }
        }
      } else if (block.type === 'code') {
        for (const sub of (block.blocks ?? [])) pageBlockList.push(_layoutItem(sub.bbox, sub.polygon_points));
      }
    }
    layoutBboxList.push(pageBlockList);
    innerLayoutBboxList.push(pageInnerList);
  }

  // Render overlays
  const pdfjsLib = await getPdfjsLib();
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
  const pdf = await loadingTask.promise;
  try {
    const blobs = [];

    for (let i = 0; i < pdf.numPages; i++) {
      const pdfPage = await pdf.getPage(i + 1);
      const canvas = await renderPageToCanvas(pdfPage);
      const ctx = canvas.getContext('2d');
      const pageInfo = getPageInfo(pdfPage);

      drawBboxWithoutNumber(i, codesBodyList, pageInfo, ctx, [102, 0, 204], true);
      drawBboxWithoutNumber(i, codesCaptionList, pageInfo, ctx, [204, 153, 255], true);
      drawBboxWithoutNumber(i, droppedBboxList, pageInfo, ctx, [158, 158, 158], true);
      drawBboxWithoutNumber(i, tablesBodyList, pageInfo, ctx, [204, 204, 0], true);
      drawBboxWithoutNumber(i, tablesCaptionList, pageInfo, ctx, [255, 255, 102], true);
      drawBboxWithoutNumber(i, tablesFootnoteList, pageInfo, ctx, [229, 255, 204], true);
      drawBboxWithoutNumber(i, imgsBodyList, pageInfo, ctx, [153, 255, 51], true);
      drawBboxWithoutNumber(i, imgsCaptionList, pageInfo, ctx, [102, 178, 255], true);
      drawBboxWithoutNumber(i, imgsFootnoteList, pageInfo, ctx, [255, 178, 102], true);
      drawBboxWithoutNumber(i, titlesList, pageInfo, ctx, [102, 102, 255], true);
      drawBboxWithoutNumber(i, textsList, pageInfo, ctx, [153, 0, 76], true);
      drawBboxWithoutNumber(i, interequationsList, pageInfo, ctx, [0, 255, 0], true);
      drawBboxWithoutNumber(i, listsList, pageInfo, ctx, [40, 169, 92], true);
      drawBboxWithoutNumber(i, listItemsList, pageInfo, ctx, [40, 169, 92], false);
      drawBboxWithoutNumber(i, indexsList, pageInfo, ctx, [40, 169, 92], true);
      drawBboxWithNumber(i, layoutBboxList, pageInfo, ctx, [255, 0, 0], false, false);
      drawBboxWithoutNumber(i, innerLayoutBboxList, pageInfo, ctx, [0, 255, 0], false);

      blobs.push(await canvas.convertToBlob({ type: 'image/png' }));
    }

    return blobs;
  } finally {
    try { await pdf.cleanup?.(); } catch { /* ignore */ }
    try { await pdf.destroy?.(); } catch { /* ignore */ }
  }
}

// ─── drawSpanBbox ─────────────────────────────────────────────────────────────

/**
 * Render span-level bounding box overlays.
 * Returns an array of PNG Blobs (one per page).
 *
 * @param {Object[]} pdfInfo
 * @param {ArrayBuffer} pdfBytes
 * @returns {Promise<Blob[]>}
 */
export async function drawSpanBbox(pdfInfo, pdfBytes) {
  const textList = [], inlineEqList = [], interlineEqList = [];
  const imageList = [], tableList = [], droppedList = [];

  for (const page of pdfInfo) {
    const pageText = [], pageInlineEq = [], pageInterlineEq = [];
    const pageImage = [], pageTable = [], pageDropped = [];

    for (const block of (page.discarded_blocks ?? [])) {
      if (block.type === BlockType.DISCARDED) {
        for (const line of (block.lines ?? [])) {
          for (const span of (line.spans ?? [])) {
            pageDropped.push(_layoutItem(span.bbox, span.polygon_points));
          }
        }
      }
    }

    for (const block of (page.preproc_blocks ?? [])) {
      const processSpan = (span) => {
        const item = _layoutItem(span.bbox, span.polygon_points);
        if (span.type === ContentType.TEXT) pageText.push(item);
        else if (span.type === ContentType.INLINE_EQUATION) pageInlineEq.push(item);
        else if (span.type === ContentType.INTERLINE_EQUATION) pageInterlineEq.push(item);
        else if (span.type === ContentType.CHECKBOX) pageInlineEq.push(item);
        else if (span.type === ContentType.IMAGE) pageImage.push(item);
        else if (span.type === ContentType.TABLE) pageTable.push(item);
      };

      if ([BlockType.TEXT, BlockType.TITLE, BlockType.INTERLINE_EQUATION, 'list', 'index'].includes(block.type)) {
        for (const line of (block.lines ?? [])) for (const span of (line.spans ?? [])) processSpan(span);
      } else if ([BlockType.IMAGE, BlockType.TABLE].includes(block.type)) {
        for (const sub of (block.blocks ?? [])) for (const line of (sub.lines ?? [])) for (const span of (line.spans ?? [])) processSpan(span);
      }
    }

    textList.push(pageText); inlineEqList.push(pageInlineEq); interlineEqList.push(pageInterlineEq);
    imageList.push(pageImage); tableList.push(pageTable); droppedList.push(pageDropped);
  }

  const pdfjsLib = await getPdfjsLib();
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
  const pdf = await loadingTask.promise;
  try {
    const blobs = [];

    for (let i = 0; i < pdf.numPages; i++) {
      const pdfPage = await pdf.getPage(i + 1);
      const canvas = await renderPageToCanvas(pdfPage);
      const ctx = canvas.getContext('2d');
      const pageInfo = getPageInfo(pdfPage);

      drawBboxWithoutNumber(i, textList, pageInfo, ctx, [255, 0, 0], false);
      drawBboxWithoutNumber(i, inlineEqList, pageInfo, ctx, [0, 255, 0], false);
      drawBboxWithoutNumber(i, interlineEqList, pageInfo, ctx, [0, 0, 255], false);
      drawBboxWithoutNumber(i, imageList, pageInfo, ctx, [255, 204, 0], false);
      drawBboxWithoutNumber(i, tableList, pageInfo, ctx, [204, 0, 255], false);
      drawBboxWithoutNumber(i, droppedList, pageInfo, ctx, [158, 158, 158], false);

      blobs.push(await canvas.convertToBlob({ type: 'image/png' }));
    }

    return blobs;
  } finally {
    try { await pdf.cleanup?.(); } catch { /* ignore */ }
    try { await pdf.destroy?.(); } catch { /* ignore */ }
  }
}

// ─── drawLineSortBbox ─────────────────────────────────────────────────────────

/**
 * Render line-level reading-order labels on each page.
 * Returns an array of PNG Blobs (one per page).
 *
 * @param {Object[]} pdfInfo
 * @param {ArrayBuffer} pdfBytes
 * @returns {Promise<Blob[]>}
 */
export async function drawLineSortBbox(pdfInfo, pdfBytes) {
  const layoutBboxList = [];

  for (const page of pdfInfo) {
    const pageLineList = [];

    for (const block of (page.preproc_blocks ?? [])) {
      if (block.type === BlockType.TEXT) {
        for (const line of (block.lines ?? [])) pageLineList.push({ index: line.index, bbox: line.bbox });
      } else if ([BlockType.TITLE, BlockType.INTERLINE_EQUATION].includes(block.type)) {
        const src = (block.virtual_lines?.length && block.virtual_lines[0]?.index != null)
          ? block.virtual_lines
          : block.lines ?? [];
        for (const line of src) pageLineList.push({ index: line.index, bbox: line.bbox });
      } else if ([BlockType.IMAGE, BlockType.TABLE].includes(block.type)) {
        for (const sub of (block.blocks ?? [])) {
          if ([BlockType.IMAGE_BODY, BlockType.TABLE_BODY].includes(sub.type)) {
            const src = (sub.virtual_lines?.length && sub.virtual_lines[0]?.index != null)
              ? sub.virtual_lines
              : sub.lines ?? [];
            for (const line of src) pageLineList.push({ index: line.index, bbox: line.bbox });
          } else {
            for (const line of (sub.lines ?? [])) pageLineList.push({ index: line.index, bbox: line.bbox });
          }
        }
      }
    }

    const sorted = [...pageLineList].sort((a, b) => a.index - b.index);
    layoutBboxList.push(sorted.map(l => _layoutItem(l.bbox)));
  }

  const pdfjsLib = await getPdfjsLib();
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes });
  const pdf = await loadingTask.promise;
  try {
    const blobs = [];

    for (let i = 0; i < pdf.numPages; i++) {
      const pdfPage = await pdf.getPage(i + 1);
      const canvas = await renderPageToCanvas(pdfPage);
      const ctx = canvas.getContext('2d');
      const pageInfo = getPageInfo(pdfPage);

      drawBboxWithNumber(i, layoutBboxList, pageInfo, ctx, [255, 0, 0], false);

      blobs.push(await canvas.convertToBlob({ type: 'image/png' }));
    }

    return blobs;
  } finally {
    try { await pdf.cleanup?.(); } catch { /* ignore */ }
    try { await pdf.destroy?.(); } catch { /* ignore */ }
  }
}
