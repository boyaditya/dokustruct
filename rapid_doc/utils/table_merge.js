// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: table_merge.py → table_merge.js
 *
 * WORKAROUND: BeautifulSoup → DOMParser / JSDOM
 * REASON: BeautifulSoup is Python-only
 * SOLUTION: Use browser-native DOMParser for HTML table manipulation.
 *   In non-browser environments (Node.js), caller must provide a global DOMParser
 *   or use the `linkedom` / `jsdom` package.
 *
 * WORKAROUND: bs4 soup.find / soup.find_all → querySelector / querySelectorAll
 * REASON: API difference
 * SOLUTION: Direct DOM API mapping.
 *
 * WORKAROUND: tag.extract() / tbody.append() → Node.removeChild / appendChild
 * REASON: bs4 extract() moves node from tree; JS equivalent is parentNode.removeChild + appendChild.
 *
 * WORKAROUND: str(soup1) → soup1.documentElement.outerHTML (inner table)
 * REASON: BeautifulSoup str() returns the parsed fragment; DOMParser wraps in full document
 * SOLUTION: Extract innerHTML of the parsed table element.
 */

import { BlockType, SplitFlag } from './enum_class.js';
import { mergeParaWithText } from '../backend/pipeline/pipeline_middle_json_mkcontent.js';

// ────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────

/**
 * Parse an HTML table string to a Document.
 * @param {string} html
 * @returns {Document}
 */
function parseTable(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

/**
 * Get the outer HTML of the first <table> element inside a document.
 * @param {Document} doc
 * @returns {string}
 */
function tableToString(doc) {
  return doc.querySelector('table')?.outerHTML ?? '';
}

/**
 * Convert full-width characters (FF01–FF5E) to half-width ASCII equivalents.
 * PORTING NOTE: full_to_half → fullToHalf
 *
 * @param {string} text
 * @returns {string}
 */
export function fullToHalf(text) {
  return [...text].map(c => {
    const code = c.codePointAt(0);
    return (code >= 0xFF01 && code <= 0xFF5E) ? String.fromCodePoint(code - 0xFEE0) : c;
  }).join('');
}

/**
 * Count total columns in a table considering rowspan/colspan.
 * PORTING NOTE: calculate_table_total_columns → calculateTableTotalColumns
 *
 * @param {Document} doc
 * @returns {number}
 */
export function calculateTableTotalColumns(doc) {
  const rows = Array.from(doc.querySelectorAll('tr'));
  if (!rows.length) return 0;

  let maxCols = 0;
  const occupied = {};

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    let colIdx = 0;
    const cells = Array.from(rows[rowIdx].querySelectorAll('td, th'));
    occupied[rowIdx] = occupied[rowIdx] ?? {};

    for (const cell of cells) {
      while (occupied[rowIdx][colIdx]) colIdx++;
      const colspan = parseInt(cell.getAttribute('colspan') ?? '1', 10);
      const rowspan = parseInt(cell.getAttribute('rowspan') ?? '1', 10);
      for (let r = rowIdx; r < rowIdx + rowspan; r++) {
        occupied[r] = occupied[r] ?? {};
        for (let c = colIdx; c < colIdx + colspan; c++) occupied[r][c] = true;
      }
      colIdx += colspan;
      if (colIdx > maxCols) maxCols = colIdx;
    }
  }
  return maxCols;
}

/**
 * Count columns in a single row (respecting colspan).
 * PORTING NOTE: calculate_row_columns → calculateRowColumns
 *
 * @param {Element} row
 * @returns {number}
 */
export function calculateRowColumns(row) {
  return Array.from(row.querySelectorAll('td, th'))
    .reduce((sum, cell) => sum + parseInt(cell.getAttribute('colspan') ?? '1', 10), 0);
}

/**
 * Count visual cells in a row (ignoring colspan).
 * PORTING NOTE: calculate_visual_columns → calculateVisualColumns
 *
 * @param {Element} row
 * @returns {number}
 */
export function calculateVisualColumns(row) {
  return row.querySelectorAll('td, th').length;
}

/**
 * Detect matching header rows between two table Documents.
 * PORTING NOTE: detect_table_headers → detectTableHeaders
 *
 * @param {Document} doc1
 * @param {Document} doc2
 * @param {number} [maxHeaderRows=5]
 * @returns {[number, boolean, string[][]]}
 */
export function detectTableHeaders(doc1, doc2, maxHeaderRows = 5) {
  const rows1 = Array.from(doc1.querySelectorAll('tr'));
  const rows2 = Array.from(doc2.querySelectorAll('tr'));
  const minRows = Math.min(rows1.length, rows2.length, maxHeaderRows);

  let headerRows = 0;
  let headersMatch = true;
  const headerTexts = [];

  for (let i = 0; i < minRows; i++) {
    const cells1 = Array.from(rows1[i].querySelectorAll('td, th'));
    const cells2 = Array.from(rows2[i].querySelectorAll('td, th'));
    let structureMatch = true;

    if (cells1.length !== cells2.length) {
      structureMatch = false;
    } else {
      for (let k = 0; k < cells1.length; k++) {
        const c1 = cells1[k], c2 = cells2[k];
        const cs1 = parseInt(c1.getAttribute('colspan') ?? '1', 10);
        const rs1 = parseInt(c1.getAttribute('rowspan') ?? '1', 10);
        const cs2 = parseInt(c2.getAttribute('colspan') ?? '1', 10);
        const rs2 = parseInt(c2.getAttribute('rowspan') ?? '1', 10);
        const t1 = fullToHalf(c1.textContent).replace(/\s+/g, '');
        const t2 = fullToHalf(c2.textContent).replace(/\s+/g, '');
        if (cs1 !== cs2 || rs1 !== rs2 || t1 !== t2) { structureMatch = false; break; }
      }
    }

    if (structureMatch) {
      headerRows++;
      headerTexts.push(cells1.map(c => fullToHalf(c.textContent.trim())));
    } else {
      headersMatch = headerRows > 0;
      break;
    }
  }

  if (headerRows === 0) headersMatch = false;
  return [headerRows, headersMatch, headerTexts];
}

/**
 * Check if last row of doc1 matches first data row of doc2.
 * PORTING NOTE: check_rows_match → checkRowsMatch
 *
 * @param {Document} doc1
 * @param {Document} doc2
 * @returns {boolean}
 */
export function checkRowsMatch(doc1, doc2) {
  const rows1 = Array.from(doc1.querySelectorAll('tr'));
  const rows2 = Array.from(doc2.querySelectorAll('tr'));
  if (!rows1.length || !rows2.length) return false;

  let lastRow = null;
  for (let i = rows1.length - 1; i >= 0; i--) {
    if (rows1[i].querySelectorAll('td, th').length) { lastRow = rows1[i]; break; }
  }

  const [headerCount] = detectTableHeaders(doc1, doc2);
  const firstDataRow = rows2.length > headerCount ? rows2[headerCount] : null;

  if (!lastRow || !firstDataRow) return false;

  const lastCols = calculateRowColumns(lastRow);
  const firstCols = calculateRowColumns(firstDataRow);
  const lastVisual = calculateVisualColumns(lastRow);
  const firstVisual = calculateVisualColumns(firstDataRow);

  return lastCols === firstCols || lastVisual === firstVisual;
}

/**
 * Check if two rows have matching colspan structures.
 * PORTING NOTE: check_row_columns_match → checkRowColumnsMatch
 *
 * @param {Element} row1
 * @param {Element} row2
 * @returns {boolean}
 */
function checkRowColumnsMatch(row1, row2) {
  const cells1 = Array.from(row1.querySelectorAll('td, th'));
  const cells2 = Array.from(row2.querySelectorAll('td, th'));
  if (cells1.length !== cells2.length) return false;
  for (let i = 0; i < cells1.length; i++) {
    if (parseInt(cells1[i].getAttribute('colspan') ?? '1', 10) !== parseInt(cells2[i].getAttribute('colspan') ?? '1', 10)) return false;
  }
  return true;
}

/**
 * Adjust colspan attributes in a range of rows to match a target column count.
 * PORTING NOTE: adjust_table_rows_colspan → adjustTableRowsColspan
 *
 * @param {Element[]} rows
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {number[]} referenceStructure
 * @param {number} referenceVisualCols
 * @param {number} targetCols
 * @param {number} currentCols
 * @param {Element} referenceRow
 */
function adjustTableRowsColspan(rows, startIdx, endIdx, referenceStructure, referenceVisualCols, targetCols, currentCols, referenceRow) {
  for (let i = startIdx; i < endIdx; i++) {
    const row = rows[i];
    const cells = Array.from(row.querySelectorAll('td, th'));
    if (!cells.length) continue;
    const currentRowCols = calculateRowColumns(row);
    if (currentRowCols >= targetCols) continue;

    if (calculateVisualColumns(row) === referenceVisualCols && checkRowColumnsMatch(row, referenceRow)) {
      if (cells.length <= referenceStructure.length) {
        cells.forEach((cell, j) => {
          if (j < referenceStructure.length && referenceStructure[j] > 1) {
            cell.setAttribute('colspan', String(referenceStructure[j]));
          }
        });
      }
    } else {
      const lastCell = cells[cells.length - 1];
      const currentSpan = parseInt(lastCell.getAttribute('colspan') ?? '1', 10);
      lastCell.setAttribute('colspan', String(currentSpan + (targetCols - currentCols)));
    }
  }
}

/**
 * Determine if two table blocks can be merged, and return parsed soup objects.
 * PORTING NOTE: can_merge_tables → canMergeTables
 *
 * @param {object} currentTableBlock
 * @param {object} previousTableBlock
 * @returns {[boolean, Document|null, Document|null, string, string]}
 */
export function canMergeTables(currentTableBlock, previousTableBlock) {
  // Check for "(续)" (continued) caption
  const captionBlocks = currentTableBlock.blocks.filter(b => b.type === BlockType.TABLE_CAPTION);
  if (captionBlocks.length > 0) {
    const hasContinued = captionBlocks.some(b => fullToHalf(mergeParaWithText(b).trim()).endsWith('(续)'));
    if (!hasContinued) return [false, null, null, '', ''];
  }

  if (previousTableBlock.blocks.some(b => b.type === BlockType.TABLE_FOOTNOTE)) {
    return [false, null, null, '', ''];
  }

  let currentHtml = '', previousHtml = '';
  for (const block of currentTableBlock.blocks) {
    if (block.type === BlockType.TABLE_BODY && block.lines?.length && block.lines[0].spans?.length) {
      currentHtml = block.lines[0].spans[0].html ?? '';
    }
  }
  for (const block of previousTableBlock.blocks) {
    if (block.type === BlockType.TABLE_BODY && block.lines?.length && block.lines[0].spans?.length) {
      previousHtml = block.lines[0].spans[0].html ?? '';
    }
  }
  if (!currentHtml || !previousHtml) return [false, null, null, '', ''];

  // Width similarity check
  const [x0t1,,x1t1] = currentTableBlock.bbox;
  const [x0t2,,x1t2] = previousTableBlock.bbox;
  const w1 = x1t1 - x0t1, w2 = x1t2 - x0t2;
  if (Math.abs(w1 - w2) / Math.min(w1, w2) >= 0.1) return [false, null, null, '', ''];

  const soup1 = parseTable(previousHtml);
  const soup2 = parseTable(currentHtml);

  const cols1 = calculateTableTotalColumns(soup1);
  const cols2 = calculateTableTotalColumns(soup2);
  const tablesMatch = cols1 === cols2;
  const rowsMatch = checkRowsMatch(soup1, soup2);

  return [(tablesMatch || rowsMatch), soup1, soup2, currentHtml, previousHtml];
}

/**
 * Merge the rows of soup2 into soup1, returning merged HTML string.
 * PORTING NOTE: perform_table_merge → performTableMerge
 *
 * @param {Document} soup1
 * @param {Document} soup2
 * @param {object} previousTableBlock
 * @param {Array<object>} waitMergeTableFootnotes
 * @returns {string}
 */
export function performTableMerge(soup1, soup2, previousTableBlock, waitMergeTableFootnotes) {
  const [headerCount] = detectTableHeaders(soup1, soup2);

  const tbody1 = soup1.querySelector('tbody') ?? soup1.querySelector('table');
  const rows1 = Array.from(soup1.querySelectorAll('tr'));
  const rows2 = Array.from(soup2.querySelectorAll('tr'));

  if (rows1.length && rows2.length && headerCount < rows2.length) {
    const lastRow1 = rows1[rows1.length - 1];
    const firstDataRow2 = rows2[headerCount];

    const tableCols1 = calculateTableTotalColumns(soup1);
    const tableCols2 = calculateTableTotalColumns(soup2);

    if (tableCols1 >= tableCols2) {
      const refStructure = Array.from(lastRow1.querySelectorAll('td, th')).map(c => parseInt(c.getAttribute('colspan') ?? '1', 10));
      adjustTableRowsColspan(rows2, headerCount, rows2.length, refStructure, calculateVisualColumns(lastRow1), tableCols1, tableCols2, firstDataRow2);
    } else {
      const refStructure = Array.from(firstDataRow2.querySelectorAll('td, th')).map(c => parseInt(c.getAttribute('colspan') ?? '1', 10));
      adjustTableRowsColspan(rows1, 0, rows1.length, refStructure, calculateVisualColumns(firstDataRow2), tableCols2, tableCols1, lastRow1);
    }
  }

  if (tbody1) {
    const soup1LastRowContents = rows1.length ? Array.from(rows1[rows1.length - 1].children) : [];
    for (const row of rows2.slice(headerCount)) {
      // Extract row from soup2
      row.parentNode?.removeChild(row);

      const currentCells = Array.from(row.querySelectorAll('td, th'));
      if (currentCells.length === soup1LastRowContents.length) {
        currentCells.forEach((cell, idx) => {
          try {
            const lastCell = soup1LastRowContents[idx];
            if (lastCell?.hasAttribute?.('colspan')) cell.setAttribute('colspan', lastCell.getAttribute('colspan'));
            if (lastCell?.hasAttribute?.('rowspan')) cell.setAttribute('rowspan', lastCell.getAttribute('rowspan'));
          } catch { /* ignore */ }
        });
      }
      tbody1.appendChild(row);
    }
  }

  // Add footnotes to previous table block
  for (const fn of waitMergeTableFootnotes) {
    const tmp = { ...fn, [SplitFlag.CROSS_PAGE]: true };
    previousTableBlock.blocks.push(tmp);
  }

  return tableToString(soup1);
}

/**
 * Merge cross-page tables in-place on the page info list.
 * PORTING NOTE: merge_table(page_info_list) → mergeTable(pageInfoList)
 *
 * @param {Array<object>} pageInfoList
 */
export function mergeTable(pageInfoList) {
  for (let pageIdx = pageInfoList.length - 1; pageIdx >= 0; pageIdx--) {
    if (pageIdx === 0) continue;

    const pageInfo = pageInfoList[pageIdx];
    const prevPageInfo = pageInfoList[pageIdx - 1];

    if (!(pageInfo.para_blocks?.length && pageInfo.para_blocks[0].type === BlockType.TABLE)) continue;
    const currentTableBlock = pageInfo.para_blocks[0];

    if (!(prevPageInfo.para_blocks?.length && prevPageInfo.para_blocks[prevPageInfo.para_blocks.length - 1].type === BlockType.TABLE)) continue;
    const previousTableBlock = prevPageInfo.para_blocks[prevPageInfo.para_blocks.length - 1];

    const waitMergeTableFootnotes = currentTableBlock.blocks.filter(b => b.type === BlockType.TABLE_FOOTNOTE);

    const [canMerge, soup1, soup2] = canMergeTables(currentTableBlock, previousTableBlock);
    if (!canMerge) continue;

    const mergedHtml = performTableMerge(soup1, soup2, previousTableBlock, waitMergeTableFootnotes);

    // Update previous table block html
    for (const block of previousTableBlock.blocks) {
      if (block.type === BlockType.TABLE_BODY && block.lines?.length && block.lines[0].spans?.length) {
        block.lines[0].spans[0].html = mergedHtml;
        break;
      }
    }

    // Clear current page table
    for (const block of currentTableBlock.blocks) {
      block.lines = [];
      block[SplitFlag.LINES_DELETED] = true;
    }
  }
}
