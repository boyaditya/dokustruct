// Copyright (c) Opendatalab. All rights reserved.

/**
 * Count physical <td>/<th> elements in an HTML string.
 * Mirrors count_table_cells_physical() in Python: basic substring count
 * on lowercased html (handles attributes since match is "<td" / "<th").
 * @param {string|null} html
 * @returns {number}
 */
export function countTableCellsPhysical(html) {
  if (!html) return 0;
  const lower = html.toLowerCase();
  // Match "<td" and "<th" occurrences (handles attributes + self-closing).
  let tdCount = 0;
  let thCount = 0;
  let idx = lower.indexOf('<td');
  while (idx !== -1) { tdCount++; idx = lower.indexOf('<td', idx + 3); }
  idx = lower.indexOf('<th');
  while (idx !== -1) { thCount++; idx = lower.indexOf('<th', idx + 3); }
  return tdCount + thCount;
}

/**
 * Parse HTML and collect <td>/<th> cells (ordered, all descendants).
 * @param {string} html
 * @returns {Element[]}
 * @private
 */
function _collectCells(html) {
  if (!html) return [];
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(doc.querySelectorAll('td, th'));
  } catch {
    return [];
  }
}

/**
 * Select the best table model output (wired vs wireless).
 * 1:1 port of select_best_table_model() in Python. The decision
 * combines physical cell count, OCR text matches, blank cells, and a
 * heuristic on non-blank cell counts. Falls back to wired by default.
 *
 * @param {Array} ocrResult   - OCR results structured as [boxes, texts, scores]
 * @param {string|null} wiredHtml
 * @param {string|null} wirelessHtml
 * @returns {{ bestHtml: string, modelType: string }}
 */
export function selectBestTableModel(ocrResult, wiredHtml, wirelessHtml) {
  const wired = wiredHtml || '';
  const wireless = wirelessHtml || '';

  const wiredLen = countTableCellsPhysical(wired);
  const wirelessLen = countTableCellsPhysical(wireless);
  const gapOfLen = wirelessLen - wiredLen;

  // Count OCR texts appearing in each rendering.
  let wirelessTextCount = 0;
  let wiredTextCount = 0;
  const texts = Array.isArray(ocrResult) && Array.isArray(ocrResult[1])
    ? ocrResult[1]
    : [];
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) continue;
    if (wireless.includes(text)) wirelessTextCount++;
    if (wired.includes(text)) wiredTextCount++;
  }

  // Count blank cells (no non-whitespace text).
  const wirelessCells = _collectCells(wireless);
  const wiredCells = _collectCells(wired);
  const wirelessBlankCount = wirelessCells.filter(
    c => !(c.textContent ?? '').trim()
  ).length;
  const wiredBlankCount = wiredCells.filter(
    c => !(c.textContent ?? '').trim()
  ).length;

  const wirelessNonBlank = wirelessLen - wirelessBlankCount;
  const wiredNonBlank = wiredLen - wiredBlankCount;

  // Heuristic switch flag: only consider when wireless has more non-blank cells.
  let switchFlag = false;
  if (wirelessNonBlank > wiredNonBlank) {
    const wiredTableScale = Math.round(Math.sqrt(wiredNonBlank));
    const wiredScalePlus2Cols = wiredNonBlank + wiredTableScale * 2;
    const wiredScaleSquaredPlus2Rows = wiredTableScale * (wiredTableScale + 2);
    if (wirelessNonBlank + 3 >= Math.max(wiredScalePlus2Cols, wiredScaleSquaredPlus2Rows)) {
      switchFlag = true;
    }
  }

  const preferWireless =
    switchFlag ||
    (gapOfLen >= 0 && gapOfLen <= 5 && wiredLen <= Math.round(wirelessLen * 0.75)) ||
    (gapOfLen === 0 && wiredLen <= 4) ||
    (wiredTextCount <= wirelessTextCount * 0.6 && wirelessTextCount >= 10);

  if (preferWireless) {
    return { bestHtml: wireless, modelType: 'wireless' };
  }
  return { bestHtml: wired, modelType: 'wired' };
}
