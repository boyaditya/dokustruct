// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: rapid_table_self/table_matcher/main.py → main.js
// TableMatch: IOU-based OCR result → table cell matching

import { computeIou, distance } from "./utils.js";
import { isBoxContained, calculateIou, isSingleAxisContained } from "../table_structure/unet/utils/utils_table_recover.js";

/**
 * Match OCR results to cells - EXACT Python parity.
 * PORTING NOTE: Matches Python's match_result logic (IOU + distance sorting).
 */
function matchOcrResultsToCells(dtBoxes, recRes, cellBboxes) {
  // Convert cell bboxes from 8-value (quad) to 4-value (rect) if needed
  const cellBboxes4 = cellBboxes.map(bbox => {
    if (bbox.length === 8) {
      const xs = [bbox[0], bbox[2], bbox[4], bbox[6]];
      const ys = [bbox[1], bbox[3], bbox[5], bbox[7]];
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    return bbox;
  });
  
  const matched = {};
  const minIou = 0.1 ** 8;
  
  // Python logic: for each OCR box, find best matching cell
  for (let i = 0; i < dtBoxes.length; i++) {
    const gtBox = dtBoxes[i];
    const distances = [];
    
    for (let j = 0; j < cellBboxes4.length; j++) {
      const predBox = cellBboxes4[j];
      const dist = distance(gtBox, predBox);
      const iou = computeIou(gtBox, predBox);
      distances.push({ cellIdx: j, dist, iou, score: 1.0 - iou });
    }
    
    // Sort by (1-IOU, distance) - prioritize high IOU, then low distance
    const sorted = [...distances].sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.dist - b.dist;
    });
    
    // Check if best match meets min IOU threshold
    if (sorted[0].score >= 1 - minIou) continue;
    
    // Assign OCR to best matching cell
    const bestCellIdx = sorted[0].cellIdx;
    if (!matched[bestCellIdx]) {
      matched[bestCellIdx] = [];
    }
    matched[bestCellIdx].push(i);
  }
  
  // Convert matched dict to array format
  const cellMatches = cellBboxes.map(() => []);
  for (const [cellIdxStr, ocrIndices] of Object.entries(matched)) {
    const cellIdx = parseInt(cellIdxStr);
    for (const ocrIdx of ocrIndices) {
      cellMatches[cellIdx].push({
        box: dtBoxes[ocrIdx],
        text: recRes[ocrIdx][0],
        score: recRes[ocrIdx][1],
      });
    }
  }
  
  return cellMatches;
}

/**
 * Merge OCR results for a single cell (Python parity).
 * PORTING NOTE: Python get_pred_html joins with single space, no distance calculation
 */
function mergeCellOcrTexts(ocrList) {
  if (ocrList.length === 0) return "";
  
  // Python logic: join all texts with single space, strip each text
  const texts = ocrList.map(item => {
    let text = item.text || "";
    text = text.trim();
    return text;
  }).filter(t => t.length > 0);
  
  return texts.join(" ");
}

/**
 * Filter OCR results to remove boxes above the table (Python parity).
 * PORTING NOTE: filter_ocr_result from Python
 */
function filterOcrResult(cellBboxes, dtBoxes, recRes) {
  if (cellBboxes.length === 0 || dtBoxes.length === 0) {
    return { dtBoxes, recRes };
  }
  
  // Find minimum y coordinate of all cells
  let y1 = Infinity;
  for (const bbox of cellBboxes) {
    // bbox is [x1,y1,x2,y2,x3,y3,x4,y4]
    const yMin = Math.min(bbox[1], bbox[3], bbox[5], bbox[7]);
    y1 = Math.min(y1, yMin);
  }
  
  // Filter out OCR boxes that are completely above the table
  const newDtBoxes = [];
  const newRecRes = [];
  
  for (let i = 0; i < dtBoxes.length; i++) {
    const box = dtBoxes[i];
    // Get max y of OCR box
    const yMax = Math.max(box[1], box[3]);
    
    // If OCR box is below table top, keep it
    if (yMax >= y1) {
      newDtBoxes.push(box);
      newRecRes.push(recRes[i]);
    }
  }
  
  return { dtBoxes: newDtBoxes, recRes: newRecRes };
}

/**
 * Build final HTML by injecting OCR text into cell-matched structure.
 * EXACT Python parity: get_pred_html() logic
 */
function getPredHtml(predStructures, cellBboxes, dtBoxes, recRes) {
  if (!Array.isArray(predStructures)) {
    console.warn('getPredHtml: predStructures not array', predStructures);
    return "";
  }
  
  // Filter OCR results first (Python parity)
  const filtered = filterOcrResult(cellBboxes, dtBoxes, recRes);
  dtBoxes = filtered.dtBoxes;
  recRes = filtered.recRes;
  
  const cellMatches = matchOcrResultsToCells(dtBoxes, recRes, cellBboxes);
  
  const endHtml = [];
  let tdIndex = 0;

  // EXACT Python logic
  for (const tag of predStructures) {
    if (tag === undefined || tag === null) continue;
    const tagStr = String(tag);
    
    // Python: if "</td>" not in tag: end_html.append(tag); continue
    if (!tagStr.includes("</td>")) {
      endHtml.push(tagStr);
      continue;
    }
    
    // Python: if "<td></td>" == tag: end_html.append("<td>")
    if (tagStr === "<td></td>") {
      endHtml.push("<td>");
    }
    
    // Inject matched OCR text
    if (tdIndex < cellMatches.length && cellMatches[tdIndex].length > 0) {
      const text = mergeCellOcrTexts(cellMatches[tdIndex]);
      endHtml.push(text);
    }
    
    // Python: if tag == "<td></td>": end_html.append("</td>") else: end_html.append(tag)
    if (tagStr === "<td></td>") {
      endHtml.push("</td>");
    } else {
      endHtml.push(tagStr);
    }
    
    tdIndex++;
  }
  
  // Python: Filter <thead></thead><tbody></tbody> elements
  const filterElements = ["<thead>", "</thead>", "<tbody>", "</tbody>"];
  const filtered2 = endHtml.filter(v => !filterElements.includes(v));
  
  return filtered2.join("");
}

export class TableMatch {
  constructor(cfg = {}) {
    this.filterOcrResult = cfg.filterOcrResult !== false;
  }

  run(predStructuresArr, cellBboxesArr, dtBoxes, recRes) {
    const results = [];
    for (let i = 0; i < predStructuresArr.length; i++) {
      try {
        const html = getPredHtml(
          predStructuresArr[i],
          cellBboxesArr[i] ?? [],
          dtBoxes,
          recRes
        );
        results.push(html);
      } catch (e) {
        console.warn("TableMatch.run: error processing table", e);
        results.push("");
      }
    }
    return results;
  }
}

export default TableMatch;
