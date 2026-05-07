// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: rapid_table_self/utils/utils.py → utils.js

/**
 * Check if a string is a URL.
 * @param {string} s
 * @returns {boolean}
 */
export function isUrl(s) {
  return typeof s === "string" && (s.startsWith("http://") || s.startsWith("https://"));
}

/**
 * Format OCR results into table-compatible bounding boxes.
 * PORTING NOTE: format_ocr_results(ocr_results, img_h, img_w) → JS array
 * @param {Array<{bbox: number[], text: string, score?: number}>} ocrResults
 * @param {number} imgH
 * @param {number} imgW
 * @returns {{ dtBoxes: number[][], recRes: [string, number][] }}
 */
export function formatOcrResults(ocrResults, imgH, imgW) {
  if (!ocrResults || ocrResults.length === 0) {
    return { dtBoxes: [], recRes: [] };
  }
  const dtBoxes = [];
  const recRes = [];
  for (const item of ocrResults) {
    const bbox = item.bbox ?? item;
    // Normalize to [x0,y0,x1,y1] absolute coords
    let x0, y0, x1, y1;
    if (Array.isArray(bbox[0])) {
      // polygon [[x,y],[x,y],[x,y],[x,y]]
      const xs = bbox.map(pt => pt[0]);
      const ys = bbox.map(pt => pt[1]);
      x0 = Math.min(...xs); y0 = Math.min(...ys);
      x1 = Math.max(...xs); y1 = Math.max(...ys);
    } else {
      [x0, y0, x1, y1] = bbox;
    }
    dtBoxes.push([x0, y0, x1, y1]);
    recRes.push([item.text ?? "", item.score ?? 1.0]);
  }
  return { dtBoxes, recRes };
}

/**
 * Read a YAML file from URL (basic key:value parser).
 * @param {string} url
 * @returns {Promise<object>}
 */
export async function readYaml(url) {
  const resp = await fetch(url);
  const text = await resp.text();
  const result = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 1).trim();
    if (val === "null" || val === "~") val = null;
    else if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (!isNaN(Number(val)) && val !== "") val = Number(val);
    result[key] = val;
  }
  return result;
}

/**
 * Compute SHA-256 of an ArrayBuffer.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<string>}
 */
export async function getFileSha256(data) {
  const buf = data instanceof Uint8Array ? data.buffer : data;
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** No-op stubs */
export function importPackage(_pkgName) { return null; }
export function mkdir(_dirPath) { /* no-op in browser */ }
export function saveImg(_img, _path) { /* no-op */ }
export function saveTxt(_text, _path) { /* no-op */ }
