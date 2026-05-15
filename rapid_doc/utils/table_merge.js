// Copyright (c) Opendatalab. All rights reserved.
/**
 * Cross-page table merge utilities.
 *
 * WORKAROUND: BeautifulSoup → DOMParser / DOM APIs
 * REASON: BeautifulSoup is Python-only; browser-native DOMParser used instead.
 */

import { BlockType, SplitFlag } from './enum_class.js';
import { extractBlockPlainText, fullToHalf } from './char_utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONTINUATION_END_MARKERS = [
  "(续)",
  "(续表)",
  "(续上表)",
  "(continued)",
  "(cont.)",
  "(cont'd)",
  "(…continued)",
  "续表",
];

export const CONTINUATION_INLINE_MARKERS = [
  "(continued)",
];

export const MAX_HEADER_ROWS = 5;

/** Minimum width ratio difference to reject merge (10%) */
const WIDTH_RATIO_THRESHOLD = 0.1;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function parseTable(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

function tableToString(doc) {
  return doc.querySelector('table')?.outerHTML ?? '';
}

// ---------------------------------------------------------------------------
// Cell text helpers
// ---------------------------------------------------------------------------

function normalizeCellText(cell) {
  if (!cell) return '';
  return fullToHalf(cell.textContent ?? '').replace(/\s+/g, '');
}

function displayCellText(cell) {
  if (!cell) return '';
  return fullToHalf((cell.textContent ?? '').trim());
}

// ---------------------------------------------------------------------------
// Row scanning — builds occupied grid and metrics
// ---------------------------------------------------------------------------

/**
 * Initializes the occupied map from a pre-existing tail_occupied structure.
 */
function initOccupiedFromTail(initialOccupied) {
  const occupied = new Map();
  let maxCols = 0;
  if (!initialOccupied) return { occupied, maxCols };

  for (const [rowOffsetStr, cols] of Object.entries(initialOccupied)) {
    const rowOffset = Number(rowOffsetStr);
    const set = cols instanceof Set ? new Set(cols) : new Set(cols || []);
    if (!set.size) continue;
    occupied.set(rowOffset, set);
    for (const c of set) {
      if (c + 1 > maxCols) maxCols = c + 1;
    }
  }
  return { occupied, maxCols };
}

/**
 * Processes a single row to compute its effective columns and update the occupied grid.
 */
function processRowOccupancy(row, localIdx, occupied, maxCols) {
  const getOccupiedRow = (idx) => {
    if (!occupied.has(idx)) occupied.set(idx, new Set());
    return occupied.get(idx);
  };

  const occupiedRow = getOccupiedRow(localIdx);
  let colIdx = 0;
  const cells = Array.from(row.querySelectorAll('td, th'));
  let actualCols = 0;

  for (const cell of cells) {
    while (occupiedRow.has(colIdx)) colIdx += 1;
    const colspan = parseInt(cell.getAttribute('colspan') ?? '1', 10);
    const rowspan = parseInt(cell.getAttribute('rowspan') ?? '1', 10);
    actualCols += colspan;

    for (let rowOffset = 0; rowOffset < rowspan; rowOffset++) {
      const targetIdx = localIdx + rowOffset;
      const occ = getOccupiedRow(targetIdx);
      for (let c = colIdx; c < colIdx + colspan; c++) occ.add(c);
    }
    colIdx += colspan;
    if (colIdx > maxCols) maxCols = colIdx;
  }

  let effectiveCols = 0;
  if (occupiedRow.size) {
    let maxOccupied = -1;
    for (const c of occupiedRow) {
      if (c > maxOccupied) maxOccupied = c;
    }
    effectiveCols = maxOccupied + 1;
    if (effectiveCols > maxCols) maxCols = effectiveCols;
  }

  return { effectiveCols, actualCols, cellCount: cells.length, maxCols };
}

function scanRows(rows, initialOccupied = null, startRowIdx = 0) {
  if (!rows || !rows.length) {
    return { row_effective_cols: [], row_metrics: [], total_cols: 0, last_nonempty_row_metrics: null, tail_occupied: {} };
  }

  const { occupied, maxCols: initialMaxCols } = initOccupiedFromTail(initialOccupied);
  let maxCols = initialMaxCols;
  const rowEffectiveCols = [];
  const rowMetrics = [];
  let lastNonemptyRowMetrics = null;

  for (let localIdx = 0; localIdx < rows.length; localIdx++) {
    const result = processRowOccupancy(rows[localIdx], localIdx, occupied, maxCols);
    maxCols = result.maxCols;
    rowEffectiveCols.push(result.effectiveCols);

    const metrics = {
      row_idx: startRowIdx + localIdx,
      effective_cols: result.effectiveCols,
      actual_cols: result.actualCols,
      visual_cols: result.cellCount,
    };
    rowMetrics.push(metrics);
    if (result.cellCount) lastNonemptyRowMetrics = metrics;
  }

  const tailOccupied = {};
  for (const [rowIdx, cols] of occupied.entries()) {
    if (rowIdx >= rows.length && cols.size) {
      tailOccupied[rowIdx - rows.length] = new Set(cols);
    }
  }

  return { row_effective_cols: rowEffectiveCols, row_metrics: rowMetrics, total_cols: maxCols, last_nonempty_row_metrics: lastNonemptyRowMetrics, tail_occupied: tailOccupied };
}

// ---------------------------------------------------------------------------
// Row signature building
// ---------------------------------------------------------------------------

function buildRowSignature(row, effectiveCols) {
  if (!row) return { effective_cols: 0, colspans: [], rowspans: [], normalized_texts: [], display_texts: [], cell_count: 0 };
  const cells = Array.from(row.querySelectorAll('td, th'));
  return {
    effective_cols: effectiveCols,
    colspans: cells.map(cell => parseInt(cell.getAttribute('colspan') ?? '1', 10)),
    rowspans: cells.map(cell => parseInt(cell.getAttribute('rowspan') ?? '1', 10)),
    normalized_texts: cells.map(cell => normalizeCellText(cell)),
    display_texts: cells.map(cell => displayCellText(cell)),
    cell_count: cells.length,
  };
}

function buildFrontCache(rows, maxHeaderRows = MAX_HEADER_ROWS) {
  if (!rows || !rows.length) return [[], {}];
  const frontLimit = Math.min(rows.length, maxHeaderRows + 1);
  const frontRows = rows.slice(0, frontLimit);
  const frontScan = scanRows(frontRows);

  const frontHeaderInfo = [];
  for (let idx = 0; idx < Math.min(frontRows.length, maxHeaderRows); idx++) {
    frontHeaderInfo.push(buildRowSignature(frontRows[idx], frontScan.row_effective_cols[idx]));
  }

  const frontFirstDataRowMetrics = {};
  frontScan.row_metrics.forEach((metrics, idx) => { frontFirstDataRowMetrics[idx] = metrics; });
  return [frontHeaderInfo, frontFirstDataRowMetrics];
}

// ---------------------------------------------------------------------------
// Table state helpers
// ---------------------------------------------------------------------------

function findTableBodyBlock(tableBlock) {
  if (!tableBlock?.blocks) return null;
  for (const block of tableBlock.blocks) {
    if (block.type === BlockType.TABLE_BODY) return block;
  }
  return null;
}

function findTableBodySpan(tableBlock) {
  const bodyBlock = findTableBodyBlock(tableBlock);
  return bodyBlock?.lines?.[0]?.spans?.[0] ?? null;
}

function isContinuationCaption(captionBlock) {
  if (!captionBlock) return false;
  const captionText = fullToHalf(extractBlockPlainText(captionBlock).trim()).toLowerCase();
  return (
    CONTINUATION_END_MARKERS.some(marker => captionText.endsWith(marker.toLowerCase())) ||
    CONTINUATION_INLINE_MARKERS.some(marker => captionText.includes(marker.toLowerCase()))
  );
}

function isPostTableNonContinuationCaption(tableBlock, captionBlock) {
  if (isContinuationCaption(captionBlock)) return false;
  const bodyBlock = findTableBodyBlock(tableBlock);
  if (!bodyBlock) return false;
  const bodyBbox = bodyBlock.bbox;
  const captionBbox = captionBlock?.bbox;
  if (!bodyBbox || !captionBbox) return false;
  return captionBbox[1] >= bodyBbox[3];
}

function getPostTableCaptionBlocks(tableBlock) {
  if (!tableBlock?.blocks) return [];
  return tableBlock.blocks.filter(block =>
    block.type === BlockType.TABLE_CAPTION &&
    isPostTableNonContinuationCaption(tableBlock, block)
  );
}

function restorePostTableCaptionsAsText(pageInfo, tableBlock, captionBlocks) {
  if (!captionBlocks?.length) return;
  const paraBlocks = pageInfo?.para_blocks;
  if (!Array.isArray(paraBlocks)) return;

  const insertIdx = paraBlocks.indexOf(tableBlock);
  if (insertIdx === -1) return;

  const restoredBlocks = captionBlocks.map(block => {
    const textBlock = structuredClone(block);
    textBlock.type = BlockType.TEXT;
    return textBlock;
  });
  paraBlocks.splice(insertIdx + 1, 0, ...restoredBlocks);

  const captionSet = new Set(captionBlocks);
  tableBlock.blocks = (tableBlock.blocks ?? []).filter(block => !captionSet.has(block));
}

function refreshTableStateMetrics(state) {
  if (!state?.rows) return;
  const scan = scanRows(state.rows);
  state.row_effective_cols = scan.row_effective_cols;
  state.total_cols = scan.total_cols;
  state.last_data_row_metrics = scan.last_nonempty_row_metrics;
  state.tail_occupied = scan.tail_occupied;
  const [headerInfo, firstDataMetrics] = buildFrontCache(state.rows);
  state.front_header_info = headerInfo;
  state.front_first_data_row_metrics = firstDataMetrics;
}

// ---------------------------------------------------------------------------
// Table state construction
// ---------------------------------------------------------------------------

export function buildTableStateFromHtml(html, maxHeaderRows = MAX_HEADER_ROWS) {
  if (!html) return null;
  const soup = parseTable(html);
  const tbody = soup.querySelector('tbody') ?? soup.querySelector('table');
  const rows = Array.from(soup.querySelectorAll('tr'));
  if (!rows.length) return null;

  const scan = scanRows(rows);
  const [frontHeaderInfo, frontFirstDataRowMetrics] = buildFrontCache(rows, maxHeaderRows);

  return {
    owner_block: {}, body_span: {}, soup, tbody, rows,
    total_cols: scan.total_cols,
    front_header_info: frontHeaderInfo,
    front_first_data_row_metrics: frontFirstDataRowMetrics,
    last_data_row_metrics: scan.last_nonempty_row_metrics,
    row_effective_cols: scan.row_effective_cols,
    tail_occupied: scan.tail_occupied,
    dirty: false,
  };
}

function buildTableState(tableBlock, maxHeaderRows = MAX_HEADER_ROWS) {
  const bodySpan = findTableBodySpan(tableBlock);
  if (!bodySpan) return null;
  const html = bodySpan.html ?? '';
  if (!html) return null;

  const soup = parseTable(html);
  const tbody = soup.querySelector('tbody') ?? soup.querySelector('table');
  const rows = Array.from(soup.querySelectorAll('tr'));
  if (!rows.length) return null;

  const scan = scanRows(rows);
  const [frontHeaderInfo, frontFirstDataRowMetrics] = buildFrontCache(rows, maxHeaderRows);

  return {
    owner_block: tableBlock, body_span: bodySpan, soup, tbody, rows,
    total_cols: scan.total_cols,
    front_header_info: frontHeaderInfo,
    front_first_data_row_metrics: frontFirstDataRowMetrics,
    last_data_row_metrics: scan.last_nonempty_row_metrics,
    row_effective_cols: scan.row_effective_cols,
    tail_occupied: scan.tail_occupied,
    dirty: false,
  };
}

function getOrCreateTableState(tableBlock, stateCache, maxHeaderRows = MAX_HEADER_ROWS) {
  if (stateCache.has(tableBlock)) return stateCache.get(tableBlock);
  const state = buildTableState(tableBlock, maxHeaderRows);
  if (state) stateCache.set(tableBlock, state);
  return state;
}

function serializeTableStateHtml(state) {
  if (!state?.body_span) return;
  state.body_span.html = tableToString(state.soup);
  state.dirty = false;
}

// ---------------------------------------------------------------------------
// Row/column calculations
// ---------------------------------------------------------------------------

export function calculateTableTotalColumns(doc) {
  if (!doc) return 0;
  const rows = Array.from(doc.querySelectorAll('tr'));
  return rows.length ? scanRows(rows).total_cols : 0;
}

export function calculateRowEffectiveColumns(doc, rowIdx) {
  if (!doc) return 0;
  const rows = Array.from(doc.querySelectorAll('tr'));
  if (!rows.length) return 0;
  const scan = scanRows(rows);
  return scan.row_effective_cols[rowIdx] ?? 0;
}

export function calculateRowColumns(row) {
  if (!row) return 0;
  return Array.from(row.querySelectorAll('td, th'))
    .reduce((sum, cell) => sum + parseInt(cell.getAttribute('colspan') ?? '1', 10), 0);
}

export function calculateVisualColumns(row) {
  if (!row) return 0;
  return row.querySelectorAll('td, th').length;
}

function scanRowVisualSources(rows, targetRowIndex) {
  let idx = targetRowIndex;
  if (idx < 0) idx += rows.length;
  if (idx < 0 || idx >= rows.length) return [new Map(), 0];

  const occupied = new Map();
  let totalCols = 0;
  const getOccupiedRow = (rowIdx) => {
    if (!occupied.has(rowIdx)) occupied.set(rowIdx, new Map());
    return occupied.get(rowIdx);
  };

  for (let rIdx = 0; rIdx <= idx; rIdx++) {
    const occupiedRow = getOccupiedRow(rIdx);
    let colIdx = 0;
    const cells = Array.from(rows[rIdx].querySelectorAll('td, th'));
    for (let cellIdx = 0; cellIdx < cells.length; cellIdx++) {
      while (occupiedRow.has(colIdx)) colIdx += 1;
      const cell = cells[cellIdx];
      const colspan = parseInt(cell.getAttribute('colspan') ?? '1', 10);
      const rowspan = parseInt(cell.getAttribute('rowspan') ?? '1', 10);
      const marker = [rIdx, cellIdx];
      for (let ro = 0; ro < rowspan; ro++) {
        const occ = getOccupiedRow(rIdx + ro);
        for (let c = colIdx; c < colIdx + colspan; c++) occ.set(c, marker);
      }
      colIdx += colspan;
      if (colIdx > totalCols) totalCols = colIdx;
    }
  }
  return [occupied.get(idx) ?? new Map(), totalCols];
}

function buildVisualColMapping(rows, targetRowIndex) {
  let idx = targetRowIndex;
  if (idx < 0) idx += rows.length;
  if (idx < 0 || idx >= rows.length) return [];

  const [targetOccupied] = scanRowVisualSources(rows, idx);
  let colIdx = 0;
  const mapping = [];
  const targetCells = Array.from(rows[idx].querySelectorAll('td, th'));

  for (const cell of targetCells) {
    while (targetOccupied.has(colIdx) && targetOccupied.get(colIdx)[0] < idx) colIdx += 1;
    mapping.push(colIdx);
    colIdx += parseInt(cell.getAttribute('colspan') ?? '1', 10);
  }
  return mapping;
}

function calculateRowRenderedSegments(rows, targetRowIndex) {
  if (!rows || !rows.length) return 0;
  const [targetOccupied, totalCols] = scanRowVisualSources(rows, targetRowIndex);
  if (!totalCols) return 0;

  let segmentCount = 0;
  let previousMarker = null;
  for (let colIdx = 0; colIdx < totalCols; colIdx++) {
    const marker = targetOccupied.get(colIdx) ?? null;
    if (!marker) { previousMarker = null; continue; }
    if (!previousMarker || marker[0] !== previousMarker[0] || marker[1] !== previousMarker[1]) {
      segmentCount += 1;
      previousMarker = marker;
    }
  }
  return segmentCount;
}

// ---------------------------------------------------------------------------
// Header detection / merge checks
// ---------------------------------------------------------------------------

export function detectTableHeaders(state1, state2, maxHeaderRows = MAX_HEADER_ROWS) {
  if (!state1?.front_header_info || !state2?.front_header_info) return [0, false, []];
  const frontRows1 = state1.front_header_info.slice(0, maxHeaderRows);
  const frontRows2 = state2.front_header_info.slice(0, maxHeaderRows);
  const minRows = Math.min(frontRows1.length, frontRows2.length, maxHeaderRows);

  let headerRows = 0;
  let headersMatch = true;
  const headerTexts = [];

  for (let rowIdx = 0; rowIdx < minRows; rowIdx++) {
    const row1 = frontRows1[rowIdx];
    const row2 = frontRows2[rowIdx];
    const structureMatch = (
      row1.cell_count === row2.cell_count &&
      row1.effective_cols === row2.effective_cols &&
      arrayEqual(row1.colspans, row2.colspans) &&
      arrayEqual(row1.rowspans, row2.rowspans) &&
      arrayEqual(row1.normalized_texts, row2.normalized_texts)
    );
    if (structureMatch) {
      headerRows += 1;
      headerTexts.push([...row1.display_texts]);
    } else {
      headersMatch = headerRows > 0;
      break;
    }
  }

  if (headerRows === 0) {
    const visual = detectTableHeadersVisual(state1, state2, maxHeaderRows);
    headerRows = visual[0];
    headersMatch = visual[1];
    headerTexts.push(...visual[2]);
  }
  return [headerRows, headersMatch, headerTexts];
}

function detectTableHeadersVisual(state1, state2, maxHeaderRows = MAX_HEADER_ROWS) {
  const frontRows1 = state1.front_header_info.slice(0, maxHeaderRows);
  const frontRows2 = state2.front_header_info.slice(0, maxHeaderRows);
  const minRows = Math.min(frontRows1.length, frontRows2.length, maxHeaderRows);

  let headerRows = 0;
  let headersMatch = true;
  const headerTexts = [];

  for (let rowIdx = 0; rowIdx < minRows; rowIdx++) {
    const row1 = frontRows1[rowIdx];
    const row2 = frontRows2[rowIdx];
    if (row1.effective_cols === row2.effective_cols && arrayEqual(row1.normalized_texts, row2.normalized_texts)) {
      headerRows += 1;
      headerTexts.push([...row1.display_texts]);
    } else {
      headersMatch = headerRows > 0;
      break;
    }
  }
  if (headerRows === 0) headersMatch = false;
  return [headerRows, headersMatch, headerTexts];
}

function expandHeaderCountByRowspan(rows, headerCount) {
  if (headerCount <= 0 || !rows?.length) return headerCount;
  let expandedHeaderCount = Math.min(headerCount, rows.length);
  let rowIdx = 0;

  while (rowIdx < expandedHeaderCount) {
    for (const cell of rows[rowIdx].querySelectorAll('td, th')) {
      const rowspan = parseInt(cell.getAttribute('rowspan') ?? '1', 10);
      if (rowspan > 1) {
        expandedHeaderCount = Math.max(expandedHeaderCount, rowIdx + rowspan);
        expandedHeaderCount = Math.min(expandedHeaderCount, rows.length);
      }
    }
    rowIdx += 1;
  }
  return expandedHeaderCount;
}

/** Checks if two tables have compatible widths for merging. */
function areTableWidthsCompatible(bbox1, bbox2) {
  if (!bbox1 || !bbox2) return true;
  const [x0t1, , x1t1] = bbox1;
  const [x0t2, , x1t2] = bbox2;
  const width1 = x1t1 - x0t1;
  const width2 = x1t2 - x0t2;
  if (width1 <= 0 || width2 <= 0) return true;
  return Math.abs(width1 - width2) / Math.min(width1, width2) < WIDTH_RATIO_THRESHOLD;
}

export function canMergeByStructure(currentState, previousState, currentBbox = null, previousBbox = null) {
  if (!areTableWidthsCompatible(currentBbox, previousBbox)) return false;
  if (previousState.total_cols === currentState.total_cols) return true;
  return checkRowsMatch(previousState, currentState);
}

export function canMergeTables(currentState, previousState) {
  const currentTableBlock = currentState.owner_block;
  const previousTableBlock = previousState.owner_block;

  if (!currentTableBlock?.blocks || !previousTableBlock?.blocks) {
    throw new Error(
      "canMergeTables() requires owner_block with 'blocks' key. " +
      "For HTML-only states from buildTableStateFromHtml(), use canMergeByStructure() instead."
    );
  }

  const footnoteCount = previousTableBlock.blocks.filter(b => b.type === BlockType.TABLE_FOOTNOTE).length;
  const captionBlocks = currentTableBlock.blocks.filter(b => b.type === BlockType.TABLE_CAPTION);
  const mergeCaptionBlocks = captionBlocks.filter(b => !isPostTableNonContinuationCaption(currentTableBlock, b));

  if (mergeCaptionBlocks.length) {
    const hasContinuation = mergeCaptionBlocks.some(b => isContinuationCaption(b));
    if (!hasContinuation) return false;
    if (footnoteCount > 1) return false;
  } else if (footnoteCount > 0) {
    return false;
  }

  if (!areTableWidthsCompatible(currentTableBlock.bbox, previousTableBlock.bbox)) return false;
  if (previousState.total_cols === currentState.total_cols) return true;
  return checkRowsMatch(previousState, currentState);
}

export function checkRowsMatch(previousState, currentState) {
  const lastRowMetrics = previousState.last_data_row_metrics;
  if (!lastRowMetrics) return false;

  let [headerCount] = detectTableHeaders(previousState, currentState);
  headerCount = expandHeaderCountByRowspan(currentState.rows, headerCount);
  const firstDataMetrics = currentState.front_first_data_row_metrics[headerCount];
  if (!firstDataMetrics) return false;

  const previousSegments = calculateRowRenderedSegments(previousState.rows, lastRowMetrics.row_idx);
  const currentSegments = calculateRowRenderedSegments(currentState.rows, firstDataMetrics.row_idx);

  return (
    lastRowMetrics.effective_cols === firstDataMetrics.effective_cols ||
    lastRowMetrics.actual_cols === firstDataMetrics.actual_cols ||
    previousSegments === currentSegments
  );
}

// ---------------------------------------------------------------------------
// Colspan adjustment helpers
// ---------------------------------------------------------------------------

function checkRowColumnsMatch(row1, row2) {
  if (!row1 || !row2) return false;
  const cells1 = Array.from(row1.querySelectorAll('td, th'));
  const cells2 = Array.from(row2.querySelectorAll('td, th'));
  if (cells1.length !== cells2.length) return false;
  for (let i = 0; i < cells1.length; i++) {
    if (parseInt(cells1[i].getAttribute('colspan') ?? '1', 10) !== parseInt(cells2[i].getAttribute('colspan') ?? '1', 10)) return false;
  }
  return true;
}

/** Applies reference colspan structure to a single row if it matches the reference visual layout. */
function applyColspanToRow(row, effectiveCols, referenceStructure, referenceVisualCols, targetCols, matchReferenceRow) {
  const cells = Array.from(row.querySelectorAll('td, th'));
  if (!cells.length) return;

  const currentRowCols = calculateRowColumns(row);
  if ((effectiveCols ?? 0) >= targetCols || currentRowCols >= targetCols) return;

  if (calculateVisualColumns(row) === referenceVisualCols) {
    if (cells.length === referenceStructure.length && checkRowColumnsMatch(row, matchReferenceRow)) {
      for (let cellIdx = 0; cellIdx < cells.length; cellIdx++) {
        const refColspan = referenceStructure[cellIdx];
        if (refColspan > 1) {
          cells[cellIdx].setAttribute('colspan', String(refColspan));
        } else {
          cells[cellIdx].removeAttribute('colspan');
        }
      }
    }
  } else {
    const colsDiff = targetCols - (effectiveCols ?? 0);
    if (colsDiff > 0) {
      const lastCell = cells[cells.length - 1];
      const currentSpan = parseInt(lastCell.getAttribute('colspan') ?? '1', 10);
      lastCell.setAttribute('colspan', String(currentSpan + colsDiff));
    }
  }
}

function adjustTableRowsColspan(rows, startIdx, endIdx, rowEffectiveCols, referenceStructure, referenceVisualCols, targetCols, matchReferenceRow) {
  for (let rowIdx = startIdx; rowIdx < endIdx; rowIdx++) {
    applyColspanToRow(rows[rowIdx], rowEffectiveCols[rowIdx], referenceStructure, referenceVisualCols, targetCols, matchReferenceRow);
  }
}

// ---------------------------------------------------------------------------
// Cell merge helpers
// ---------------------------------------------------------------------------

function cellHasSemanticContent(cell) {
  if (!cell) return false;
  if ((cell.textContent ?? '').trim()) return true;
  return !!cell.querySelector('img, svg, math, eq, table, figure, object, embed, canvas');
}

function rowHasSemanticContent(row) {
  if (!row) return false;
  return Array.from(row.querySelectorAll('td, th')).some(cell => cellHasSemanticContent(cell));
}

function insertCellBeforeVisualColumn(rows, targetRowIndex, startVcol, cell) {
  const targetRow = rows[targetRowIndex];
  if (!targetRow) return;
  const targetCells = Array.from(targetRow.querySelectorAll('td, th'));
  const targetVcolMap = buildVisualColMapping(rows, targetRowIndex);

  for (let idx = 0; idx < targetVcolMap.length; idx++) {
    if (targetVcolMap[idx] > startVcol) {
      targetRow.insertBefore(cell, targetCells[idx]);
      return;
    }
  }
  targetRow.appendChild(cell);
}

function carryRowspanStructureToNextRow(rows, rowIdx) {
  const nextRowIdx = rowIdx + 1;
  if (nextRowIdx >= rows.length) return;

  const currentCells = Array.from(rows[rowIdx].querySelectorAll('td, th'));
  const currentVcolMap = buildVisualColMapping(rows, rowIdx);
  const carriedCells = [];

  for (let i = 0; i < currentCells.length; i++) {
    const cell = currentCells[i];
    const rowspan = parseInt(cell.getAttribute('rowspan') ?? '1', 10);
    if (rowspan <= 1 || cellHasSemanticContent(cell)) continue;

    const carriedCell = cell.cloneNode(true);
    const newRowspan = rowspan - 1;
    if (newRowspan > 1) {
      carriedCell.setAttribute('rowspan', String(newRowspan));
    } else {
      carriedCell.removeAttribute('rowspan');
    }
    carriedCells.push([currentVcolMap[i], carriedCell]);
  }

  carriedCells.sort((a, b) => b[0] - a[0]);
  for (const [startVcol, carriedCell] of carriedCells) {
    insertCellBeforeVisualColumn(rows, nextRowIdx, startVcol, carriedCell);
  }
}

/** Builds a visual-column-to-cell-index mapping for a row's cells. */
function buildVcolToCellMap(cells, vcolMap) {
  const map = new Map();
  for (let ci = 0; ci < vcolMap.length; ci++) {
    const startVcol = vcolMap[ci];
    const colspan = parseInt(cells[ci].getAttribute('colspan') ?? '1', 10);
    for (let c = startVcol; c < startVcol + colspan; c++) map.set(c, ci);
  }
  return map;
}

/** Transfers cell content from source cells to destination cells based on cell_merge flags. */
function transferCellContent(cells1, cells2, vcolToCell1, vcolToCell2, cellMerge) {
  const transferredPairs = new Set();
  for (let vi = 0; vi < cellMerge.length; vi++) {
    if (cellMerge[vi] !== 1) continue;
    const ci1 = vcolToCell1.get(vi);
    const ci2 = vcolToCell2.get(vi);
    if (ci1 == null || ci2 == null) continue;
    const pairKey = `${ci1},${ci2}`;
    if (transferredPairs.has(pairKey)) continue;
    const children = Array.from(cells2[ci2].childNodes);
    for (const child of children) cells1[ci1].appendChild(child);
    transferredPairs.add(pairKey);
  }
}

/** Clears content from source cells that were merged. */
function clearMergedSourceCells(cells2, vcolToCell2, cellMerge) {
  const clearedCi2 = new Set();
  for (let vi = 0; vi < cellMerge.length; vi++) {
    if (cellMerge[vi] !== 1) continue;
    const ci2 = vcolToCell2.get(vi);
    if (ci2 == null || clearedCi2.has(ci2)) continue;
    const cell = cells2[ci2];
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    clearedCi2.add(ci2);
  }
}

function applyCellMerge(previousState, currentState, headerCount) {
  const cellMerge = currentState.owner_block?.cell_merge;
  if (!cellMerge) return;
  const rows2 = currentState.rows;
  if (headerCount >= rows2.length || !previousState.rows?.length) return;

  const firstDataRow = rows2[headerCount];
  const lastRow = previousState.rows[previousState.rows.length - 1];
  const cells1 = Array.from(lastRow.querySelectorAll('td, th'));
  const cells2 = Array.from(firstDataRow.querySelectorAll('td, th'));

  const lastRowIdx = previousState.rows.length - 1;
  const vcolMap1 = buildVisualColMapping(previousState.rows, lastRowIdx);
  const vcolMap2 = buildVisualColMapping(rows2, headerCount);
  const vcolToCell1 = buildVcolToCellMap(cells1, vcolMap1);
  const vcolToCell2 = buildVcolToCellMap(cells2, vcolMap2);

  transferCellContent(cells1, cells2, vcolToCell1, vcolToCell2, cellMerge);
  clearMergedSourceCells(cells2, vcolToCell2, cellMerge);

  if (!rowHasSemanticContent(firstDataRow)) {
    carryRowspanStructureToNextRow(rows2, headerCount);
    firstDataRow.parentNode?.removeChild(firstDataRow);
    const idx = rows2.indexOf(firstDataRow);
    if (idx !== -1) rows2.splice(idx, 1);
  }
}

// ---------------------------------------------------------------------------
// Merge execution
// ---------------------------------------------------------------------------

/** Adjusts colspan differences between two tables before merging. Returns true if previous was adjusted. */
function adjustColspanForMerge(previousState, currentState, headerCount) {
  const rows1 = previousState.rows;
  const rows2 = currentState.rows;
  if (!rows1.length || !rows2.length || headerCount >= rows2.length) return false;

  const lastRow1 = rows1[rows1.length - 1];
  const firstDataRow2 = rows2[headerCount];
  const tableCols1 = previousState.total_cols;
  const tableCols2 = currentState.total_cols;

  if (tableCols1 > tableCols2) {
    const refStructure = Array.from(lastRow1.querySelectorAll('td, th')).map(c => parseInt(c.getAttribute('colspan') ?? '1', 10));
    adjustTableRowsColspan(rows2, headerCount, rows2.length, currentState.row_effective_cols, refStructure, calculateVisualColumns(lastRow1), tableCols1, firstDataRow2);
    return false;
  }
  if (tableCols2 > tableCols1) {
    const refStructure = Array.from(firstDataRow2.querySelectorAll('td, th')).map(c => parseInt(c.getAttribute('colspan') ?? '1', 10));
    adjustTableRowsColspan(rows1, 0, rows1.length, previousState.row_effective_cols, refStructure, calculateVisualColumns(firstDataRow2), tableCols2, lastRow1);
    return true;
  }
  return false;
}

/** Appends data rows from the current table into the previous table's DOM. */
function appendRowsToPreviousTable(previousState, currentState, headerCount) {
  const appendedRows = currentState.rows.slice(headerCount);
  const appendStartIdx = previousState.rows.length;
  const mergedRows = [];

  if (previousState.tbody && currentState.tbody) {
    for (const row of appendedRows) {
      row.parentNode?.removeChild(row);
      previousState.tbody.appendChild(row);
      mergedRows.push(row);
    }
  }
  previousState.rows.push(...mergedRows);

  if (mergedRows.length) {
    const appendedScan = scanRows(mergedRows, previousState.tail_occupied, appendStartIdx);
    previousState.row_effective_cols.push(...appendedScan.row_effective_cols);
    previousState.total_cols = Math.max(previousState.total_cols, appendedScan.total_cols);
    if (appendedScan.last_nonempty_row_metrics) {
      previousState.last_data_row_metrics = appendedScan.last_nonempty_row_metrics;
    }
    previousState.tail_occupied = appendedScan.tail_occupied;
  }
}

export function performTableMerge(previousState, currentState, previousTableBlock, waitMergeTableFootnotes) {
  if (!previousState || !currentState) return;

  let [headerCount] = detectTableHeaders(previousState, currentState);
  headerCount = expandHeaderCountByRowspan(currentState.rows, headerCount);

  const previousAdjusted = adjustColspanForMerge(previousState, currentState, headerCount);
  if (previousAdjusted) refreshTableStateMetrics(previousState);

  applyCellMerge(previousState, currentState, headerCount);
  appendRowsToPreviousTable(previousState, currentState, headerCount);

  previousTableBlock.blocks = (previousTableBlock.blocks ?? []).filter(block => block.type !== BlockType.TABLE_FOOTNOTE);
  for (const tableFootnote of (waitMergeTableFootnotes ?? [])) {
    previousTableBlock.blocks.push({ ...tableFootnote, [SplitFlag.CROSS_PAGE]: true });
  }
  previousState.dirty = true;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function mergeTable(pageInfoList) {
  if (!Array.isArray(pageInfoList) || pageInfoList.length < 2) return;

  const stateCache = new Map();
  const mergedAwayBlocks = new Set();

  for (let pageIdx = pageInfoList.length - 1; pageIdx >= 1; pageIdx--) {
    const pageInfo = pageInfoList[pageIdx];
    const previousPageInfo = pageInfoList[pageIdx - 1];

    if (!isFirstBlockTable(pageInfo) || !isLastBlockTable(previousPageInfo)) continue;

    const currentTableBlock = pageInfo.para_blocks[0];
    const previousTableBlock = previousPageInfo.para_blocks[previousPageInfo.para_blocks.length - 1];

    const currentState = getOrCreateTableState(currentTableBlock, stateCache);
    const previousState = getOrCreateTableState(previousTableBlock, stateCache);
    if (!currentState || !previousState) continue;

    const postTableCaptionBlocks = getPostTableCaptionBlocks(currentTableBlock);
    const waitMergeTableFootnotes = (currentTableBlock.blocks ?? []).filter(block => block.type === BlockType.TABLE_FOOTNOTE);

    if (!canMergeTables(currentState, previousState)) continue;

    performTableMerge(previousState, currentState, previousTableBlock, waitMergeTableFootnotes);
    restorePostTableCaptionsAsText(pageInfo, currentTableBlock, postTableCaptionBlocks);

    mergedAwayBlocks.add(currentTableBlock);
    for (const block of currentTableBlock.blocks ?? []) {
      block.lines = [];
      block[SplitFlag.LINES_DELETED] = true;
    }
  }

  for (const state of stateCache.values()) {
    if (state.dirty && !mergedAwayBlocks.has(state.owner_block)) {
      serializeTableStateHtml(state);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFirstBlockTable(pageInfo) {
  return !!(pageInfo?.para_blocks?.length && pageInfo.para_blocks[0].type === BlockType.TABLE);
}

function isLastBlockTable(pageInfo) {
  return !!(pageInfo?.para_blocks?.length && pageInfo.para_blocks[pageInfo.para_blocks.length - 1].type === BlockType.TABLE);
}

function arrayEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export { fullToHalf };
