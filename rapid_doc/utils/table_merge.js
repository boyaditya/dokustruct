// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: table_merge.py → table_merge.js (0.9.4 refactor)
 *
 * WORKAROUND: BeautifulSoup → DOMParser / DOM APIs
 * REASON: BeautifulSoup is Python-only
 * SOLUTION: Use browser-native DOMParser and DOM traversal.
 */

import { BlockType, SplitFlag } from './enum_class.js';
import { mergeParaWithText } from '../backend/pipeline/pipeline_middle_json_mkcontent.js';
import { fullToHalf } from './char_utils.js';

export const CONTINUATION_END_MARKERS = [
  "(续)",
  "(续表)",
  "(续上表)",
  "(continued)",
  "(cont.)",
  "(cont’d)",
  "(…continued)",
  "续表",
];

export const CONTINUATION_INLINE_MARKERS = [
  "(continued)",
];

export const MAX_HEADER_ROWS = 5;

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
// Row metrics / signatures
// ---------------------------------------------------------------------------

function normalizeCellText(cell) {
  return fullToHalf(cell.textContent ?? '').replace(/\s+/g, '');
}

function displayCellText(cell) {
  return fullToHalf((cell.textContent ?? '').trim());
}

function scanRows(rows, initialOccupied = null, startRowIdx = 0) {
  const occupied = new Map();
  let maxCols = 0;

  if (initialOccupied) {
    for (const [rowOffsetStr, cols] of Object.entries(initialOccupied)) {
      const rowOffset = Number(rowOffsetStr);
      const set = cols instanceof Set ? new Set(cols) : new Set(cols || []);
      if (!set.size) continue;
      occupied.set(rowOffset, set);
      for (const c of set) {
        if (c + 1 > maxCols) maxCols = c + 1;
      }
    }
  }

  const rowEffectiveCols = [];
  const rowMetrics = [];
  let lastNonemptyRowMetrics = null;

  const getOccupiedRow = (idx) => {
    if (!occupied.has(idx)) occupied.set(idx, new Set());
    return occupied.get(idx);
  };

  for (let localIdx = 0; localIdx < rows.length; localIdx++) {
    const row = rows[localIdx];
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

    rowEffectiveCols.push(effectiveCols);

    const metrics = {
      row_idx: startRowIdx + localIdx,
      effective_cols: effectiveCols,
      actual_cols: actualCols,
      visual_cols: cells.length,
    };
    rowMetrics.push(metrics);
    if (cells.length) lastNonemptyRowMetrics = metrics;
  }

  const tailOccupied = {};
  for (const [rowIdx, cols] of occupied.entries()) {
    if (rowIdx >= rows.length && cols.size) {
      tailOccupied[rowIdx - rows.length] = new Set(cols);
    }
  }

  return {
    row_effective_cols: rowEffectiveCols,
    row_metrics: rowMetrics,
    total_cols: maxCols,
    last_nonempty_row_metrics: lastNonemptyRowMetrics,
    tail_occupied: tailOccupied,
  };
}

function buildRowSignature(row, effectiveCols) {
  const cells = Array.from(row.querySelectorAll('td, th'));
  const colspans = cells.map(cell => parseInt(cell.getAttribute('colspan') ?? '1', 10));
  const rowspans = cells.map(cell => parseInt(cell.getAttribute('rowspan') ?? '1', 10));
  const normalizedTexts = cells.map(cell => normalizeCellText(cell));
  const displayTexts = cells.map(cell => displayCellText(cell));

  return {
    effective_cols: effectiveCols,
    colspans,
    rowspans,
    normalized_texts: normalizedTexts,
    display_texts: displayTexts,
    cell_count: colspans.length,
  };
}

function buildFrontCache(rows, maxHeaderRows = MAX_HEADER_ROWS) {
  const frontLimit = Math.min(rows.length, maxHeaderRows + 1);
  const frontRows = rows.slice(0, frontLimit);
  const frontScan = scanRows(frontRows);

  const frontHeaderInfo = [];
  for (let idx = 0; idx < Math.min(frontRows.length, maxHeaderRows); idx++) {
    frontHeaderInfo.push(buildRowSignature(frontRows[idx], frontScan.row_effective_cols[idx]));
  }

  const frontFirstDataRowMetrics = {};
  frontScan.row_metrics.forEach((metrics, idx) => {
    frontFirstDataRowMetrics[idx] = metrics;
  });

  return [frontHeaderInfo, frontFirstDataRowMetrics];
}

// ---------------------------------------------------------------------------
// Table state helpers
// ---------------------------------------------------------------------------

function findTableBodyBlock(tableBlock) {
  for (const block of tableBlock.blocks ?? []) {
    if (block.type === BlockType.TABLE_BODY) return block;
  }
  return null;
}

function findTableBodySpan(tableBlock) {
  const bodyBlock = findTableBodyBlock(tableBlock);
  const firstLine = bodyBlock?.lines?.[0];
  const firstSpan = firstLine?.spans?.[0];
  return firstSpan ?? null;
}

function isContinuationCaption(captionBlock) {
  const captionText = fullToHalf(mergeParaWithText(captionBlock).trim()).toLowerCase();
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
  const captionBbox = captionBlock.bbox;
  if (!bodyBbox || !captionBbox) return false;

  return captionBbox[1] >= bodyBbox[3];
}

function getPostTableCaptionBlocks(tableBlock) {
  return (tableBlock.blocks ?? []).filter(block =>
    block.type === BlockType.TABLE_CAPTION &&
    isPostTableNonContinuationCaption(tableBlock, block)
  );
}

function restorePostTableCaptionsAsText(pageInfo, tableBlock, captionBlocks) {
  if (!captionBlocks?.length) return;

  const paraBlocks = pageInfo?.para_blocks ?? [];
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
  const scan = scanRows(state.rows);
  state.row_effective_cols = scan.row_effective_cols;
  state.total_cols = scan.total_cols;
  state.last_data_row_metrics = scan.last_nonempty_row_metrics;
  state.tail_occupied = scan.tail_occupied;
  const [headerInfo, firstDataMetrics] = buildFrontCache(state.rows);
  state.front_header_info = headerInfo;
  state.front_first_data_row_metrics = firstDataMetrics;
}

export function buildTableStateFromHtml(html, maxHeaderRows = MAX_HEADER_ROWS) {
  if (!html) return null;

  const soup = parseTable(html);
  const tbody = soup.querySelector('tbody') ?? soup.querySelector('table');
  const rows = Array.from(soup.querySelectorAll('tr'));
  if (!rows.length) return null;

  const scan = scanRows(rows);
  const [frontHeaderInfo, frontFirstDataRowMetrics] = buildFrontCache(rows, maxHeaderRows);

  return {
    owner_block: {},
    body_span: {},
    soup,
    tbody,
    rows,
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
  const scan = scanRows(rows);
  const [frontHeaderInfo, frontFirstDataRowMetrics] = buildFrontCache(rows, maxHeaderRows);

  return {
    owner_block: tableBlock,
    body_span: bodySpan,
    soup,
    tbody,
    rows,
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
  state.body_span.html = tableToString(state.soup);
  state.dirty = false;
}

// ---------------------------------------------------------------------------
// Row/column calculations
// ---------------------------------------------------------------------------

export function calculateTableTotalColumns(doc) {
  const rows = Array.from(doc.querySelectorAll('tr'));
  return rows.length ? scanRows(rows).total_cols : 0;
}

function buildTableOccupiedMatrix(doc) {
  const rows = Array.from(doc.querySelectorAll('tr'));
  if (!rows.length) return {};
  const scan = scanRows(rows);
  const matrix = {};
  scan.row_effective_cols.forEach((cols, idx) => {
    matrix[idx] = cols;
  });
  return matrix;
}

export function calculateRowEffectiveColumns(doc, rowIdx) {
  const matrix = buildTableOccupiedMatrix(doc);
  return matrix[rowIdx] ?? 0;
}

export function calculateRowColumns(row) {
  return Array.from(row.querySelectorAll('td, th'))
    .reduce((sum, cell) => sum + parseInt(cell.getAttribute('colspan') ?? '1', 10), 0);
}

export function calculateVisualColumns(row) {
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
        const targetIdx = rIdx + ro;
        const occ = getOccupiedRow(targetIdx);
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
    const colspan = parseInt(cell.getAttribute('colspan') ?? '1', 10);
    colIdx += colspan;
  }

  return mapping;
}

function calculateRowRenderedSegments(rows, targetRowIndex) {
  const [targetOccupied, totalCols] = scanRowVisualSources(rows, targetRowIndex);
  if (!totalCols) return 0;

  let segmentCount = 0;
  let previousMarker = null;

  for (let colIdx = 0; colIdx < totalCols; colIdx++) {
    const marker = targetOccupied.get(colIdx) ?? null;
    if (!marker) {
      previousMarker = null;
      continue;
    }
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
    if (
      row1.effective_cols === row2.effective_cols &&
      arrayEqual(row1.normalized_texts, row2.normalized_texts)
    ) {
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
  if (headerCount <= 0 || !rows.length) return headerCount;

  let expandedHeaderCount = Math.min(headerCount, rows.length);
  let rowIdx = 0;

  while (rowIdx < expandedHeaderCount) {
    const row = rows[rowIdx];
    for (const cell of row.querySelectorAll('td, th')) {
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

export function canMergeByStructure(currentState, previousState, currentBbox = null, previousBbox = null) {
  if (currentBbox && previousBbox) {
    const [x0t1,,x1t1] = currentBbox;
    const [x0t2,,x1t2] = previousBbox;
    const table1Width = x1t1 - x0t1;
    const table2Width = x1t2 - x0t2;
    if (table1Width > 0 && table2Width > 0) {
      if (Math.abs(table1Width - table2Width) / Math.min(table1Width, table2Width) >= 0.1) return false;
    }
  }

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

  const [x0t1,,x1t1] = currentTableBlock.bbox;
  const [x0t2,,x1t2] = previousTableBlock.bbox;
  const table1Width = x1t1 - x0t1;
  const table2Width = x1t2 - x0t2;

  if (Math.abs(table1Width - table2Width) / Math.min(table1Width, table2Width) >= 0.1) return false;

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

function checkRowColumnsMatch(row1, row2) {
  const cells1 = Array.from(row1.querySelectorAll('td, th'));
  const cells2 = Array.from(row2.querySelectorAll('td, th'));
  if (cells1.length !== cells2.length) return false;
  for (let i = 0; i < cells1.length; i++) {
    const cs1 = parseInt(cells1[i].getAttribute('colspan') ?? '1', 10);
    const cs2 = parseInt(cells2[i].getAttribute('colspan') ?? '1', 10);
    if (cs1 !== cs2) return false;
  }
  return true;
}

function adjustTableRowsColspan(
  rows,
  startIdx,
  endIdx,
  rowEffectiveCols,
  referenceStructure,
  referenceVisualCols,
  targetCols,
  matchReferenceRow,
) {
  for (let rowIdx = startIdx; rowIdx < endIdx; rowIdx++) {
    const row = rows[rowIdx];
    const cells = Array.from(row.querySelectorAll('td, th'));
    if (!cells.length) continue;

    const currentRowEffectiveCols = rowEffectiveCols[rowIdx] ?? 0;
    const currentRowCols = calculateRowColumns(row);

    if (currentRowEffectiveCols >= targetCols || currentRowCols >= targetCols) continue;

    if (calculateVisualColumns(row) === referenceVisualCols) {
      if (cells.length === referenceStructure.length && checkRowColumnsMatch(row, matchReferenceRow)) {
        for (let cellIdx = 0; cellIdx < cells.length; cellIdx++) {
          const referenceColspan = referenceStructure[cellIdx];
          if (referenceColspan > 1) {
            cells[cellIdx].setAttribute('colspan', String(referenceColspan));
          } else {
            cells[cellIdx].removeAttribute('colspan');
          }
        }
      }
    } else {
      const colsDiff = targetCols - currentRowEffectiveCols;
      if (colsDiff > 0) {
        const lastCell = cells[cells.length - 1];
        const currentSpan = parseInt(lastCell.getAttribute('colspan') ?? '1', 10);
        lastCell.setAttribute('colspan', String(currentSpan + colsDiff));
      }
    }
  }
}

function cellHasSemanticContent(cell) {
  if ((cell.textContent ?? '').trim()) return true;
  return !!cell.querySelector('img, svg, math, eq, table, figure, object, embed, canvas');
}

function rowHasSemanticContent(row) {
  return Array.from(row.querySelectorAll('td, th')).some(cell => cellHasSemanticContent(cell));
}

function insertCellBeforeVisualColumn(rows, targetRowIndex, startVcol, cell) {
  const targetRow = rows[targetRowIndex];
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

  const currentRow = rows[rowIdx];
  const currentCells = Array.from(currentRow.querySelectorAll('td, th'));
  const currentVcolMap = buildVisualColMapping(rows, rowIdx);
  const carriedCells = [];

  for (let i = 0; i < currentCells.length; i++) {
    const cell = currentCells[i];
    const startVcol = currentVcolMap[i];
    const rowspan = parseInt(cell.getAttribute('rowspan') ?? '1', 10);
    if (rowspan <= 1 || cellHasSemanticContent(cell)) continue;

    const carriedCell = cell.cloneNode(true);
    const newRowspan = rowspan - 1;
    if (newRowspan > 1) {
      carriedCell.setAttribute('rowspan', String(newRowspan));
    } else {
      carriedCell.removeAttribute('rowspan');
    }
    carriedCells.push([startVcol, carriedCell]);
  }

  carriedCells.sort((a, b) => b[0] - a[0]);
  for (const [startVcol, carriedCell] of carriedCells) {
    insertCellBeforeVisualColumn(rows, nextRowIdx, startVcol, carriedCell);
  }
}

function applyCellMerge(previousState, currentState, headerCount) {
  const cellMerge = currentState.owner_block?.cell_merge;
  if (!cellMerge) return;

  const rows2 = currentState.rows;
  if (headerCount >= rows2.length) return;
  if (!previousState.rows.length) return;

  const firstDataRow = rows2[headerCount];
  const lastRow = previousState.rows[previousState.rows.length - 1];

  const cells1 = Array.from(lastRow.querySelectorAll('td, th'));
  const cells2 = Array.from(firstDataRow.querySelectorAll('td, th'));

  const lastRowIdx = previousState.rows.length - 1;
  const vcolMap1 = buildVisualColMapping(previousState.rows, lastRowIdx);
  const vcolMap2 = buildVisualColMapping(rows2, headerCount);

  const vcolToCell1 = new Map();
  for (let ci = 0; ci < vcolMap1.length; ci++) {
    const startVcol = vcolMap1[ci];
    const colspan = parseInt(cells1[ci].getAttribute('colspan') ?? '1', 10);
    for (let c = startVcol; c < startVcol + colspan; c++) vcolToCell1.set(c, ci);
  }

  const vcolToCell2 = new Map();
  for (let ci = 0; ci < vcolMap2.length; ci++) {
    const startVcol = vcolMap2[ci];
    const colspan = parseInt(cells2[ci].getAttribute('colspan') ?? '1', 10);
    for (let c = startVcol; c < startVcol + colspan; c++) vcolToCell2.set(c, ci);
  }

  const transferredPairs = new Set();
  for (let vi = 0; vi < cellMerge.length; vi++) {
    if (cellMerge[vi] !== 1) continue;
    const ci1 = vcolToCell1.get(vi);
    const ci2 = vcolToCell2.get(vi);
    if (ci1 == null || ci2 == null) continue;
    const pairKey = `${ci1},${ci2}`;
    if (transferredPairs.has(pairKey)) continue;

    const srcCell = cells2[ci2];
    const dstCell = cells1[ci1];
    const children = Array.from(srcCell.childNodes);
    for (const child of children) dstCell.appendChild(child);
    transferredPairs.add(pairKey);
  }

  const clearedCi2 = new Set();
  for (let vi = 0; vi < cellMerge.length; vi++) {
    if (cellMerge[vi] !== 1) continue;
    const ci2 = vcolToCell2.get(vi);
    if (ci2 == null || clearedCi2.has(ci2)) continue;
    const cell = cells2[ci2];
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    clearedCi2.add(ci2);
  }

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

export function performTableMerge(previousState, currentState, previousTableBlock, waitMergeTableFootnotes) {
  let [headerCount] = detectTableHeaders(previousState, currentState);
  headerCount = expandHeaderCountByRowspan(currentState.rows, headerCount);

  const rows1 = previousState.rows;
  const rows2 = currentState.rows;

  let previousAdjusted = false;

  if (rows1.length && rows2.length && headerCount < rows2.length) {
    const lastRow1 = rows1[rows1.length - 1];
    const firstDataRow2 = rows2[headerCount];
    const tableCols1 = previousState.total_cols;
    const tableCols2 = currentState.total_cols;

    if (tableCols1 > tableCols2) {
      const referenceStructure = Array.from(lastRow1.querySelectorAll('td, th'))
        .map(cell => parseInt(cell.getAttribute('colspan') ?? '1', 10));
      const referenceVisualCols = calculateVisualColumns(lastRow1);
      adjustTableRowsColspan(
        rows2,
        headerCount,
        rows2.length,
        currentState.row_effective_cols,
        referenceStructure,
        referenceVisualCols,
        tableCols1,
        firstDataRow2,
      );
    } else if (tableCols2 > tableCols1) {
      const referenceStructure = Array.from(firstDataRow2.querySelectorAll('td, th'))
        .map(cell => parseInt(cell.getAttribute('colspan') ?? '1', 10));
      const referenceVisualCols = calculateVisualColumns(firstDataRow2);
      adjustTableRowsColspan(
        rows1,
        0,
        rows1.length,
        previousState.row_effective_cols,
        referenceStructure,
        referenceVisualCols,
        tableCols2,
        lastRow1,
      );
      previousAdjusted = true;
    }
  }

  if (previousAdjusted) refreshTableStateMetrics(previousState);

  applyCellMerge(previousState, currentState, headerCount);

  const appendedRows = rows2.slice(headerCount);
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
    const appendedScan = scanRows(
      mergedRows,
      previousState.tail_occupied,
      appendStartIdx,
    );
    previousState.row_effective_cols.push(...appendedScan.row_effective_cols);
    previousState.total_cols = Math.max(previousState.total_cols, appendedScan.total_cols);
    if (appendedScan.last_nonempty_row_metrics) {
      previousState.last_data_row_metrics = appendedScan.last_nonempty_row_metrics;
    }
    previousState.tail_occupied = appendedScan.tail_occupied;
  }

  previousTableBlock.blocks = (previousTableBlock.blocks ?? [])
    .filter(block => block.type !== BlockType.TABLE_FOOTNOTE);

  for (const tableFootnote of waitMergeTableFootnotes) {
    const tempFootnote = { ...tableFootnote, [SplitFlag.CROSS_PAGE]: true };
    previousTableBlock.blocks.push(tempFootnote);
  }

  previousState.dirty = true;
}

export function mergeTable(pageInfoList) {
  const stateCache = new Map();
  const mergedAwayBlocks = new Set();

  for (let pageIdx = pageInfoList.length - 1; pageIdx >= 0; pageIdx--) {
    if (pageIdx === 0) continue;

    const pageInfo = pageInfoList[pageIdx];
    const previousPageInfo = pageInfoList[pageIdx - 1];

    if (!(pageInfo?.para_blocks?.length && pageInfo.para_blocks[0].type === BlockType.TABLE)) continue;
    if (!(previousPageInfo?.para_blocks?.length && previousPageInfo.para_blocks[previousPageInfo.para_blocks.length - 1].type === BlockType.TABLE)) continue;

    const currentTableBlock = pageInfo.para_blocks[0];
    const previousTableBlock = previousPageInfo.para_blocks[previousPageInfo.para_blocks.length - 1];

    const currentState = getOrCreateTableState(currentTableBlock, stateCache);
    const previousState = getOrCreateTableState(previousTableBlock, stateCache);
    if (!currentState || !previousState) continue;

    const postTableCaptionBlocks = getPostTableCaptionBlocks(currentTableBlock);
    const waitMergeTableFootnotes = (currentTableBlock.blocks ?? [])
      .filter(block => block.type === BlockType.TABLE_FOOTNOTE);

    if (!canMergeTables(currentState, previousState)) continue;

    performTableMerge(
      previousState,
      currentState,
      previousTableBlock,
      waitMergeTableFootnotes,
    );

    restorePostTableCaptionsAsText(
      pageInfo,
      currentTableBlock,
      postTableCaptionBlocks,
    );

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
// Utils
// ---------------------------------------------------------------------------

function arrayEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export { fullToHalf };
