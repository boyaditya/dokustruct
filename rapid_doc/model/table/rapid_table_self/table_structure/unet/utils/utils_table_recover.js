// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table_structure/unet/utils/utils_table_recover.py → utils_table_recover.js
// PORTING NOTE: table_structure/unet/table_recover.py → utils_table_recover.js

/**
 * Sort text boxes in order from top to bottom, left to right.
 */
export function sortedBoxes(dtBoxes) {
  const numBoxes = dtBoxes.length;
  if (numBoxes === 0) return [];
  let boxes = dtBoxes.map(b => b.length === 8 ? [[b[0], b[1]], [b[2], b[3]], [b[4], b[5]], [b[6], b[7]]] : b);
  boxes.sort((a, b) => {
    if (a[0][1] !== b[0][1]) return a[0][1] - b[0][1];
    return a[0][0] - b[0][0];
  });
  for (let i = 0; i < numBoxes - 1; i++) {
    for (let j = i; j >= 0; j--) {
      if (Math.abs(boxes[j + 1][0][1] - boxes[j][0][1]) < 10 && boxes[j + 1][0][0] < boxes[j][0][0]) {
        [boxes[j], boxes[j + 1]] = [boxes[j + 1], boxes[j]];
      } else { break; }
    }
  }
  return boxes;
}

export function calculateIou(box1, box2) {
  const [b1_x1, b1_y1, b1_x2, b1_y2] = box1, [b2_x1, b2_y1, b2_x2, b2_y2] = box2;
  if (b1_x2 < b2_x1 || b1_x1 > b2_x2 || b1_y2 < b2_y1 || b1_y1 > b2_y2) return 0.0;
  const iX1 = Math.max(b1_x1, b2_x1), iY1 = Math.max(b1_y1, b2_y1), iX2 = Math.min(b1_x2, b2_x2), iY2 = Math.min(b1_y2, b2_y2);
  const iA = Math.max(0, iX2 - iX1) * Math.max(0, iY2 - iY1);
  const b1A = (b1_x2 - b1_x1) * (b1_y2 - b1_y1), b2A = (b2_x2 - b2_x1) * (b2_y2 - b2_y1);
  const uA = b1A + b2A - iA;
  return uA === 0 ? 1.0 : iA / uA;
}

export function isBoxContained(box1, box2, threshold = 0.2) {
  const [b1_x1, b1_y1, b1_x2, b1_y2] = box1, [b2_x1, b2_y1, b2_x2, b2_y2] = box2;
  if (b1_x2 < b2_x1 || b1_x1 > b2_x2 || b1_y2 < b2_y1 || b1_y1 > b2_y2) return null;
  const b1A = (b1_x2 - b1_x1) * (b1_y2 - b1_y1), b2A = (b2_x2 - b2_x1) * (b2_y2 - b2_y1);
  const iX1 = Math.max(b1_x1, b2_x1), iY1 = Math.max(b1_y1, b2_y1), iX2 = Math.min(b1_x2, b2_x2), iY2 = Math.min(b1_y2, b2_y2);
  const iA = Math.max(0, iX2 - iX1) * Math.max(0, iY2 - iY1);
  if ((b1A - iA) / b1A < threshold) return 1;
  if ((b2A - iA) / b2A < threshold) return 2;
  return null;
}

export function isSingleAxisContained(box1, box2, axis = "x", threshold = 0.2) {
  const [b1_x1, b1_y1, b1_x2, b1_y2] = box1, [b2_x1, b2_y1, b2_x2, b2_y2] = box2;
  let b1S, b2S, iS;
  if (axis === "x") { b1S = b1_x2 - b1_x1; b2S = b2_x2 - b2_x1; iS = Math.min(b1_x2, b2_x2) - Math.max(b1_x1, b2_x1); }
  else { b1S = b1_y2 - b1_y1; b2S = b2_y2 - b2_y1; iS = Math.min(b1_y2, b2_y2) - Math.max(b1_y1, b2_y1); }
  if ((b1S - iS) / b1S < threshold) return 1;
  if ((b2S - iS) / b2S < threshold) return 2;
  return null;
}

export function sortedOcrBoxes(dtBoxes, threshold = 0.2) {
  const n = dtBoxes.length; if (n === 0) return [[], []];
  const indexed = dtBoxes.map((box, idx) => ({ box, idx }));
  indexed.sort((a, b) => a.box[1] !== b.box[1] ? a.box[1] - b.box[1] : a.box[0] - b.box[0]);
  const _boxes = indexed.map(x => x.box), indices = indexed.map(x => x.idx);
  const thresholdPx = 20; // Python uses 20 for pixel threshold
  for (let i = 0; i < n - 1; i++) {
    for (let j = i; j >= 0; j--) {
      const cIdx = isSingleAxisContained(_boxes[j], _boxes[j + 1], "y", threshold);
      if (cIdx !== null && _boxes[j + 1][0] < _boxes[j][0] && Math.abs(_boxes[j][1] - _boxes[j + 1][1]) < thresholdPx) {
        [_boxes[j], _boxes[j + 1]] = [_boxes[j + 1], _boxes[j]];
        [indices[j], indices[j + 1]] = [indices[j + 1], indices[j]];
      } else { break; }
    }
  }
  return [_boxes, indices];
}

export function box42PolyToBox41(p) { return [p[0][0], p[0][1], p[2][0], p[2][1]]; }

export function matchOcrCell(dtRecBoxes, predBboxes) {
  const matched = {};
  const notMatch = [];
  
  for (let i = 0; i < dtRecBoxes.length; i++) {
    const gt = dtRecBoxes[i];
    const ocrB = box42PolyToBox41(gt[0]);
    let matchedAny = false;
    
    for (let j = 0; j < predBboxes.length; j++) {
      const prB = box42PolyToBox41(predBboxes[j]);
      const contained = isBoxContained(ocrB, prB, 0.6);
      const iou = calculateIou(ocrB, prB);
      
      if (contained === 1 || iou > 0.8) {
        matchedAny = true;
        if (!matched[j]) matched[j] = [gt];
        else matched[j].push(gt);
      }
    }
    
    if (!matchedAny) notMatch.push(gt);
  }
  
  return [matched, notMatch];
}

export function gatherOcrListByRow(ocrList, threshold = 0.2) {
  const list = [...ocrList];
  const thresholdPx = 20;
  
  // Python logic: iterate and merge in-place, no pre-sorting
  for (let i = 0; i < list.length; i++) {
    if (!list[i]) continue;
    for (let j = i + 1; j < list.length; j++) {
      if (!list[j]) continue;
      const cur = list[i], nxt = list[j];
      
      // Use isSingleAxisContained like Python
      if (isSingleAxisContained(cur[0], nxt[0], "y", threshold)) {
        const dis = Math.max(nxt[0][0] - cur[0][2], 0);
        cur[1] = cur[1] + " ".repeat(Math.floor(dis / thresholdPx)) + nxt[1];
        cur[0][0] = Math.min(cur[0][0], nxt[0][0]); cur[0][1] = Math.min(cur[0][1], nxt[0][1]);
        cur[0][2] = Math.max(cur[0][2], nxt[0][2]); cur[0][3] = Math.max(cur[0][3], nxt[0][3]);
        list[j] = null;
      }
    }
  }
  return list.filter(x => x !== null);
}

export function plotHtmlTable(logicPoints, cellBoxMap) {
  let mR = 0, mC = 0;
  for (const p of logicPoints) { mR = Math.max(mR, p[1] + 1); mC = Math.max(mC, p[3] + 1); }
  const grid = Array.from({ length: mR }, () => Array(mC).fill(null));
  let vSR = 65535, vSC = 65535, vEC = 0;
  for (let i = 0; i < logicPoints.length; i++) {
    const [rs, re, cs, ce] = logicPoints[i], texts = cellBoxMap[i] || [];
    if (texts.length > 0 && texts.join("").trim().length > 0) {
      vSR = Math.min(rs, vSR); vSC = Math.min(cs, vSC); vEC = Math.max(ce, vEC);
    }
    for (let r = rs; r <= re; r++) {
      for (let c = cs; c <= ce; c++) grid[r][c] = [i, rs, re, cs, ce];
    }
  }
  let html = "<html><body><table>";
  for (let r = 0; r < mR; r++) {
    if (r < vSR) continue;
    let rowH = "<tr>";
    for (let c = 0; c < mC; c++) {
      if (c < vSC || c > vEC) continue;
      if (!grid[r][c]) rowH += "<td></td>";
      else {
        const [i, rs, re, cs, ce] = grid[r][c];
        if (r === rs && c === cs) {
          if (!cellBoxMap[i]) continue;
          const text = (cellBoxMap[i] || []).map(t => String(t).replace(/[\r\n]+/g, "").trim()).filter(t => t.length > 0).join("<br>");
          rowH += `<td rowspan=${re - rs + 1} colspan=${ce - cs + 1}>${text}</td>`;
        }
      }
    }
    html += rowH + "</tr>";
  }
  return html + "</table></body></html>";
}

export class TableRecover {
  run(polygons, rowThresh = 10, colThresh = 15) {
    const rows = this.getRows(polygons, rowThresh);
    const { benchmarkCols, colWidths, numCols } = this.getBenchmarkCols(rows, polygons, colThresh);
    const { rowHeights, numRows } = this.getBenchmarkRows(rows, polygons);
    const { logicPointsMap } = this.getMergeCells(polygons, rows, numRows, numCols, benchmarkCols, colWidths, rowHeights);
    return { logicPoints: polygons.map((_, i) => logicPointsMap[i]) };
  }

  getRows(polygons, thresh) {
    const y = polygons.map(p => p[0][1]);
    if (y.length === 1) return { 0: [0] };
    const res = {}, split = [];
    for (let i = 0; i < y.length - 1; i++) if (Math.abs(y[i+1] - y[i]) > thresh) split.push(i);
    if (split.length === 0) return { 0: y.map((_, i) => i) };
    if (split[split.length-1] !== y.length-1) split.push(y.length-1);
    let s = 0;
    for (let r = 0; r < split.length; r++) { res[r] = Array.from({length: split[r]-s+1}, (_, i) => s+i); s = split[r]+1; }
    return res;
  }

  getBenchmarkCols(rows, polygons, thresh) {
    // Find longest row (row with most cells)
    let longestRowIdx = 0, maxLen = -1;
    for (const [idx, cells] of Object.entries(rows)) {
      if (cells.length > maxLen) { 
        maxLen = cells.length; 
        longestRowIdx = parseInt(idx); 
      }
    }
    
    const longestRow = rows[longestRowIdx];
    const longestXStart = longestRow.map(i => polygons[i][0][0]);
    const longestXEnd = longestRow.map(i => polygons[i][2][0]);
    let minX = longestXStart[0];
    let maxX = longestXEnd[longestXEnd.length - 1];
    
    // Python parity: update column boundaries based on all rows
    const updateLongestCol = (colXList, curV, insertLast) => {
      for (let i = 0; i < colXList.length; i++) {
        // Skip if value already exists within threshold
        if (curV - thresh <= colXList[i] && colXList[i] <= curV + thresh) {
          return { minX, maxX };
        }
        
        // Insert at beginning if smaller than min
        if (curV < minX) {
          colXList.unshift(curV);
          minX = curV;
          return { minX, maxX };
        }
        
        // Insert at end if larger than max
        if (curV > maxX) {
          if (insertLast) colXList.push(curV);
          maxX = curV;
          return { minX, maxX };
        }
        
        // Insert in middle if between two values
        if (curV < colXList[i]) {
          colXList.splice(i, 0, curV);
          return { minX, maxX };
        }
      }
      return { minX, maxX };
    };
    
    // Process all rows to find all column boundaries
    for (const rowCells of Object.values(rows)) {
      for (const cellIdx of rowCells) {
        const startX = polygons[cellIdx][0][0];
        const endX = polygons[cellIdx][2][0];
        
        ({ minX, maxX } = updateLongestCol(longestXStart, startX, true));
        ({ minX, maxX } = updateLongestCol(longestXStart, endX, false));
      }
    }
    
    // Calculate column widths
    const colWidths = [];
    for (let i = 0; i < longestXStart.length - 1; i++) {
      colWidths.push(longestXStart[i + 1] - longestXStart[i]);
    }
    colWidths.push(maxX - longestXStart[longestXStart.length - 1]);
    
    return { 
      benchmarkCols: longestXStart, 
      colWidths: colWidths, 
      numCols: longestXStart.length 
    };
  }

  getBenchmarkRows(rows, polygons) {
    const rIdx = Object.keys(rows).sort((a,b) => a-b), bY = rIdx.map(r => polygons[rows[r][0]][0][1]);
    const h = bY.slice(0,-1).map((v, i) => bY[i+1]-v);
    const last = rows[rIdx[rIdx.length-1]], maxH = Math.max(...last.map(i => Math.sqrt((polygons[i][1][0]-polygons[i][0][0])**2 + (polygons[i][1][1]-polygons[i][0][1])**2)));
    h.push(maxH); return { rowHeights: h, numRows: bY.length };
  }

  getMergeCells(polygons, rows, numRows, numCols, benchmarkCols, colWidths, rowHeights) {
    const map = {};
    const mergeThresh = 10; // Python uses 10
    const rowIndices = Object.keys(rows).map(k => parseInt(k)).sort((a, b) => a - b);
    
    for (let rI = 0; rI < rowIndices.length; rI++) {
      const curRow = rowIndices[rI];
      const colList = rows[curRow];
      const oneColResult = {};
      const oneRowResult = {};
      
      for (const oneCol of colList) {
        const box = polygons[oneCol];
        
        // Calculate box width (distance from top-left to top-right)
        const boxWidth = Math.sqrt(
          (box[3][0] - box[0][0]) ** 2 + (box[3][1] - box[0][1]) ** 2
        );
        
        // Python parity: find closest column start position
        let locColIdx = 0;
        let minDist = Infinity;
        for (let c = 0; c < benchmarkCols.length; c++) {
          const dist = Math.abs(benchmarkCols[c] - box[0][0]);
          if (dist < minDist) {
            minDist = dist;
            locColIdx = c;
          }
        }
        
        // Column start should be max of accumulated columns and located index
        const colStart = Math.max(
          Object.values(oneColResult).reduce((sum, val) => sum + val, 0),
          locColIdx
        );
        
        // Calculate column span
        let colSpan = 1;
        for (let i = colStart; i < numCols; i++) {
          const colCumSum = colWidths.slice(colStart, i + 1).reduce((a, b) => a + b, 0);
          
          if (i === colStart && colCumSum > boxWidth) {
            colSpan = 1;
            break;
          } else if (Math.abs(colCumSum - boxWidth) <= mergeThresh) {
            colSpan = i + 1 - colStart;
            break;
          } else if (colCumSum > boxWidth) {
            // Python correction logic
            const idx = Math.abs(colCumSum - boxWidth) < Math.abs(colCumSum - colWidths[i] - boxWidth)
              ? i
              : i - 1;
            colSpan = idx + 1 - colStart;
            break;
          }
          
          // Last column
          if (i === numCols - 1) {
            colSpan = numCols - colStart;
          }
        }
        
        oneColResult[oneCol] = colSpan;
        const colEnd = colSpan + colStart - 1;
        
        // Calculate box height (distance from top-left to bottom-left)
        const boxHeight = Math.sqrt(
          (box[1][0] - box[0][0]) ** 2 + (box[1][1] - box[0][1]) ** 2
        );
        
        // Calculate row span
        const rowStart = curRow;
        let rowSpan = 1;
        
        for (let j = rowStart; j < numRows; j++) {
          const rowCumSum = rowHeights.slice(rowStart, j + 1).reduce((a, b) => a + b, 0);
          
          if (j === rowStart && rowCumSum > boxHeight) {
            rowSpan = 1;
            break;
          } else if (Math.abs(boxHeight - rowCumSum) <= mergeThresh) {
            rowSpan = j + 1 - rowStart;
            break;
          } else if (rowCumSum > boxHeight) {
            // Python correction logic
            const idx = Math.abs(rowCumSum - boxHeight) < Math.abs(rowCumSum - rowHeights[j] - boxHeight)
              ? j
              : j - 1;
            rowSpan = idx + 1 - rowStart;
            break;
          }
          
          // Last row
          if (j === numRows - 1) {
            rowSpan = numRows - rowStart;
          }
        }
        
        oneRowResult[oneCol] = rowSpan;
        const rowEnd = rowSpan + rowStart - 1;
        
        // Store logic points
        map[oneCol] = [rowStart, rowEnd, colStart, colEnd];
      }
    }
    
    return { logicPointsMap: map };
  }
}
