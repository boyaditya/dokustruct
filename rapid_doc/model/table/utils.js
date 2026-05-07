// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table/utils.py → utils.js
// selectBestTableModel + countTableCellsPhysical
// Python BeautifulSoup → browser DOMParser

/**
 * Count physical <td> and <th> elements in an HTML string.
 * PORTING NOTE: count_table_cells_physical(html) → DOMParser (replaces BeautifulSoup)
 * @param {string|null} html
 * @returns {number}
 */
export function countTableCellsPhysical(html) {
  if (!html) return 0;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    return doc.querySelectorAll("td, th").length;
  } catch {
    // Fallback: regex count
    return (html.match(/<(?:td|th)[\s>]/gi) || []).length;
  }
}

/**
 * Select the best table model output based on cell count.
 * PORTING NOTE: select_best_table_model(ocr_result, wired_html, wireless_html)
 * Returns the model type string ("wired" or "wireless") with the higher cell count.
 *
 * @param {Array|null} ocrResult - OCR results (used to decide preference)
 * @param {string|null} wiredHtml - HTML from wired table model
 * @param {string|null} wirelessHtml - HTML from wireless table model
 * @returns {{ bestHtml: string|null, modelType: string }}
 */
export function selectBestTableModel(ocrResult, wiredHtml, wirelessHtml) {
  const wiredCount = countTableCellsPhysical(wiredHtml);
  const wirelessCount = countTableCellsPhysical(wirelessHtml);

  if (wiredCount >= wirelessCount) {
    return { bestHtml: wiredHtml, modelType: "wired" };
  }
  return { bestHtml: wirelessHtml, modelType: "wireless" };
}
