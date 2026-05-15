// Copyright (c) Opendatalab. All rights reserved.

import { AbortException } from "../../../../utils/exceptions.js";
import { formatPipelineError } from "../../../../utils/browser_utils.js";

const TABLE_MATCH_CHUNK_SIZE = 256;

/**
 * Normalise cell bboxes to 4-point rectangles [x0, y0, x1, y1].
 * Accepts 4-value rectangle, 8-value polygon, or nested [[x,y],...] polygon.
 * @param {Array|null} cellBboxes
 * @returns {number[][]}
 */
function normalizeCellBboxes(cellBboxes) {
  if (!cellBboxes || cellBboxes.length === 0) return [];
  const out = [];
  for (const bbox of cellBboxes) {
    if (!bbox) continue;
    let flat;
    if (Array.isArray(bbox[0])) {
      flat = [];
      for (const pt of bbox) flat.push(Number(pt[0]), Number(pt[1]));
    } else {
      flat = bbox.map(Number);
    }
    if (flat.length === 4) {
      out.push(flat);
    } else if (flat.length === 8) {
      const xs = [flat[0], flat[2], flat[4], flat[6]];
      const ys = [flat[1], flat[3], flat[5], flat[7]];
      out.push([
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
      ]);
    } else {
      throw new Error(`Unsupported table cell bbox shape: ${flat.length}`);
    }
  }
  return out;
}

/**
 * Normalise OCR det boxes to 4-value rectangles.
 * Accepts either rectangle or 8-point polygon or [[x,y],...] form.
 * @param {Array} dtBoxes
 * @returns {number[][]}
 */
function normalizeDtBoxes(dtBoxes) {
  if (!dtBoxes || dtBoxes.length === 0) return [];
  const out = [];
  for (const raw of dtBoxes) {
    if (!raw) continue;
    let flat;
    if (Array.isArray(raw[0])) {
      flat = [];
      for (const pt of raw) flat.push(Number(pt[0]), Number(pt[1]));
    } else {
      flat = raw.map(Number);
    }
    if (flat.length === 4) {
      out.push(flat);
    } else if (flat.length === 8) {
      const xs = [flat[0], flat[2], flat[4], flat[6]];
      const ys = [flat[1], flat[3], flat[5], flat[7]];
      out.push([
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
      ]);
    }
  }
  return out;
}

/**
 * Pairwise IoU + custom distance metric between OCR boxes and cell boxes.
 * Preserves Python's coordinate-axis convention for behavioural parity.
 * @param {number[][]} dt - (N,4) OCR rects
 * @param {number[][]} cells - (M,4) cell rects
 * @returns {{ iou: number[][], distance: number[][] }}
 */
function pairwiseIouAndDistance(dt, cells) {
  const N = dt.length;
  const M = cells.length;
  const iou = new Array(N);
  const distance = new Array(N);
  for (let i = 0; i < N; i++) {
    const d0 = dt[i][0], d1 = dt[i][1], d2 = dt[i][2], d3 = dt[i][3];
    const dtArea = (d2 - d0) * (d3 - d1);
    const iouRow = new Array(M);
    const distRow = new Array(M);
    for (let j = 0; j < M; j++) {
      const c0 = cells[j][0], c1 = cells[j][1], c2 = cells[j][2], c3 = cells[j][3];
      const cellArea = (c2 - c0) * (c3 - c1);
      const sumArea = dtArea + cellArea;

      const leftLine = Math.max(d1, c1);
      const rightLine = Math.min(d3, c3);
      const topLine = Math.max(d0, c0);
      const bottomLine = Math.min(d2, c2);
      let iouVal = 0;
      if (leftLine < rightLine && topLine < bottomLine) {
        const intersect = (rightLine - leftLine) * (bottomLine - topLine);
        const union = sumArea - intersect;
        if (union !== 0) iouVal = intersect / union;
      }
      iouRow[j] = iouVal;

      const dis = Math.abs(c0 - d0) + Math.abs(c1 - d1) + Math.abs(c2 - d2) + Math.abs(c3 - d3);
      const dis2 = Math.abs(c0 - d0) + Math.abs(c1 - d1);
      const dis3 = Math.abs(c2 - d2) + Math.abs(c3 - d3);
      distRow[j] = dis + Math.min(dis2, dis3);
    }
    iou[i] = iouRow;
    distance[i] = distRow;
  }
  return { iou, distance };
}

/**
 * Select the best cell index for each OCR box by (1-IoU, distance) tie-break.
 * @param {number[][]} iou
 * @param {number[][]} distance
 * @returns {number[]}
 */
function selectBestCellIndices(iou, distance) {
  const out = new Array(iou.length);
  for (let r = 0; r < iou.length; r++) {
    const row = iou[r];
    const distRow = distance[r];
    let maxIou = -Infinity;
    for (let j = 0; j < row.length; j++) {
      if (row[j] > maxIou) maxIou = row[j];
    }
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let j = 0; j < row.length; j++) {
      if (row[j] !== maxIou) continue;
      if (distRow[j] < bestDist) {
        bestDist = distRow[j];
        bestIdx = j;
      }
    }
    out[r] = bestIdx;
  }
  return out;
}

/**
 * Filter OCR boxes that lie entirely above the table top.
 * @param {number[][]} cellBboxes normalised (Nc,4)
 * @param {number[][]} dtBoxes normalised (Ndt,4)
 * @param {any[]} recRes
 * @returns {{ dtBoxes: number[][], recRes: any[] }}
 */
function filterOcrResult(cellBboxes, dtBoxes, recRes) {
  if (cellBboxes.length === 0 || dtBoxes.length === 0) {
    return { dtBoxes, recRes };
  }
  let y1 = Infinity;
  for (const c of cellBboxes) {
    if (c[1] < y1) y1 = c[1];
    if (c[3] < y1) y1 = c[3];
  }
  const newDt = [];
  const newRec = [];
  for (let i = 0; i < dtBoxes.length; i++) {
    const box = dtBoxes[i];
    const maxY = Math.max(box[1], box[3]);
    if (maxY < y1) continue;
    newDt.push(box);
    newRec.push(recRes[i]);
  }
  return { dtBoxes: newDt, recRes: newRec };
}

/**
 * Chunked, greedy assignment of OCR boxes to cells.
 * @param {number[][]} cellBboxes normalised (Nc,4)
 * @param {number[][]} dtBoxes normalised (Ndt,4)
 * @param {number} [minIou=1e-8]
 * @returns {Object<number, number[]>}
 */
function matchResult(cellBboxes, dtBoxes, minIou = Math.pow(0.1, 8)) {
  const matched = {};
  if (dtBoxes.length === 0 || cellBboxes.length === 0) return matched;
  for (let start = 0; start < dtBoxes.length; start += TABLE_MATCH_CHUNK_SIZE) {
    const end = Math.min(start + TABLE_MATCH_CHUNK_SIZE, dtBoxes.length);
    const chunk = dtBoxes.slice(start, end);
    const { iou, distance } = pairwiseIouAndDistance(chunk, cellBboxes);
    const best = selectBestCellIndices(iou, distance);
    for (let offset = 0; offset < best.length; offset++) {
      const bestCell = best[offset];
      if (bestCell < 0) continue;
      const bestInverseIou = 1.0 - iou[offset][bestCell];
      if (bestInverseIou >= 1 - minIou) continue;
      const ocrIdx = start + offset;
      if (!matched[bestCell]) matched[bestCell] = [];
      matched[bestCell].push(ocrIdx);
    }
  }
  return matched;
}

/**
 * Build the final HTML string with OCR text injected into matched cells.
 * @param {string[]} predStructures
 * @param {Object<number, number[]>} matchedIndex
 * @param {Array<[string, number]>} ocrContents
 * @returns {string}
 */
function buildPredHtml(predStructures, matchedIndex, ocrContents) {
  const endHtml = [];
  let tdIndex = 0;
  for (const tag of predStructures) {
    if (tag == null) continue;
    const tagStr = String(tag);
    if (!tagStr.includes('</td>')) {
      endHtml.push(tagStr);
      continue;
    }
    if (tagStr === '<td></td>') endHtml.push('<td>');

    if (Object.prototype.hasOwnProperty.call(matchedIndex, tdIndex)) {
      const cellIndices = matchedIndex[tdIndex];
      let bWith = false;
      if (cellIndices.length > 1 && ocrContents[cellIndices[0]][0].includes('<b>')) {
        bWith = true;
        endHtml.push('<b>');
      }
      const contents = [];
      for (let i = 0; i < cellIndices.length; i++) {
        let content = ocrContents[cellIndices[i]][0] ?? '';
        if (cellIndices.length > 1) {
          if (content.length === 0) continue;
          if (content[0] === ' ') content = content.slice(1);
          content = content.replace(/<b>/g, '').replace(/<\/b>/g, '');
          content = content.trim();
          if (content.length === 0) continue;
          if (i !== cellIndices.length - 1 && content.endsWith(' ')) {
            content = content.replace(/\s+$/, '');
          }
        }
        contents.push(content);
      }
      endHtml.push(contents.join(' '));
      if (bWith) endHtml.push('</b>');
    }

    if (tagStr === '<td></td>') {
      endHtml.push('</td>');
    } else {
      endHtml.push(tagStr);
    }
    tdIndex++;
  }

  const filterElements = new Set(['<thead>', '</thead>', '<tbody>', '</tbody>']);
  return endHtml.filter(v => !filterElements.has(v)).join('');
}

/**
 * Process a single table: normalize, filter, match, and build HTML.
 * @param {string[]} predStruct
 * @param {Array} cellBboxes
 * @param {Array} dtBoxes
 * @param {Array<[string, number]>} recRes
 * @returns {string|null}
 */
function processOne(predStruct, cellBboxes, dtBoxes, recRes) {
  if (dtBoxes == null || recRes == null) return null;
  const normCells = normalizeCellBboxes(cellBboxes);
  const normDt = normalizeDtBoxes(dtBoxes);
  const filtered = filterOcrResult(normCells, normDt, recRes);
  const matchedIndex = matchResult(normCells, filtered.dtBoxes);
  return buildPredHtml(predStruct, matchedIndex, filtered.recRes);
}

/**
 * Table matcher: assigns OCR text to table cells based on spatial overlap.
 */
export class TableMatch {
  constructor() {}

  /**
   * Batch run with element-level error handling.
   * Failed individual tables are skipped; AbortException always propagates.
   * @param {Array<string[]>} predStructuresArr
   * @param {Array<Array>} cellBboxesArr
   * @param {Array} dtBoxes
   * @param {Array} recRes
   * @returns {Array<string|null>}
   */
  run(predStructuresArr, cellBboxesArr, dtBoxes, recRes) {
    const results = [];
    for (let i = 0; i < predStructuresArr.length; i++) {
      try {
        const struct = Array.isArray(predStructuresArr[i][0]) && typeof predStructuresArr[i][0][0] === 'string'
          ? predStructuresArr[i][0]
          : predStructuresArr[i];
        const html = processOne(struct, cellBboxesArr[i] ?? [], dtBoxes, recRes);
        results.push(html);
      } catch (err) {
        if (err instanceof AbortException) throw err;
        console.warn(formatPipelineError({
          stage: 'table',
          module: 'TableMatch',
          message: `Error matching table ${i}: ${err?.message ?? err}`,
          pageIndex: i,
          recoverable: true,
        }));
        results.push(null);
      }
    }
    return results;
  }
}

export default TableMatch;
