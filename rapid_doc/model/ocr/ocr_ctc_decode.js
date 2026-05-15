/**
 * CTC decoding and word-level grouping for OCR text recognition.
 */

// ─── CTC decode ───────────────────────────────────────────────────────────────

/**
 * CTC greedy decode with optional character position tracking.
 * @param {Float32Array} preds - [T, numChars] flattened logits
 * @param {number} T - time steps
 * @param {number} numChars
 * @param {string[]} charList - character vocabulary (index 0 = blank)
 * @param {boolean} returnWordBox - track character positions for word boxes
 * @returns {{ text: string, score: number, selection?: boolean[], validCols?: number[] }}
 */
export function ctcDecode(preds, T, numChars, charList, returnWordBox = false) {
  let text = '';
  let scoreSum = 0;
  let scoreCount = 0;
  let prevIdx = null;

  const selection = returnWordBox ? new Array(T).fill(false) : null;

  const hasLeadingBlank = charList.length > 0 && charList[0] === 'blank';
  const directIndexMode = hasLeadingBlank && charList.length === numChars;
  const shiftedIndexMode = !directIndexMode && (numChars === charList.length + 1);
  const blankIdx = 0;

  for (let t = 0; t < T; t++) {
    const off = t * numChars;
    let maxVal = preds[off];
    let maxIdx = 0;

    for (let c = 1; c < numChars; c++) {
      const val = preds[off + c];
      if (val > maxVal) { maxVal = val; maxIdx = c; }
    }

    const isDuplicate = prevIdx !== null && maxIdx === prevIdx;
    if (maxIdx !== blankIdx && !isDuplicate) {
      const charIdx = shiftedIndexMode ? (maxIdx - 1) : maxIdx;
      const ch = charList[charIdx];
      if (ch !== undefined) {
        text += ch;
        scoreSum += maxVal;
        scoreCount++;
        if (selection) selection[t] = true;
      }
    }
    prevIdx = maxIdx;
  }

  const score = scoreCount > 0 ? scoreSum / scoreCount : 0;
  const result = { text, score };

  if (returnWordBox && selection) {
    const validCols = [];
    for (let t = 0; t < T; t++) {
      if (selection[t]) validCols.push(t);
    }
    result.selection = selection;
    result.validCols = validCols;
  }

  return result;
}

// ─── getWordInfo ──────────────────────────────────────────────────────────────

const CHINESE_REGEX = /[\u4e00-\u9fa5]/;
const COL_WIDTH_SPLIT_THRESHOLD = 5;

/**
 * Group decoded characters into words with position tracking.
 * @param {string} text - Decoded text
 * @param {number[]} validCols - Column indices of valid characters
 * @returns {{ words: string[][], wordCols: number[][], wordTypes: string[], lineTxtLen: number, confs: any[] }}
 */
export function getWordInfo(text, validCols) {
  if (!validCols || validCols.length === 0) {
    return { words: [], wordCols: [], wordTypes: [], lineTxtLen: 0, confs: [] };
  }

  const hasChinese = (char) => CHINESE_REGEX.test(char);
  const colWidth = computeColWidths(validCols, text, hasChinese);

  const wordList = [];
  const wordColList = [];
  const stateList = [];

  let wordContent = [];
  let wordColContent = [];
  let state = null;

  for (let cI = 0; cI < text.length; cI++) {
    const char = text[cI];

    if (/\s/.test(char)) {
      if (wordContent.length > 0) {
        wordList.push(wordContent);
        wordColList.push(wordColContent);
        stateList.push(state);
        wordContent = [];
        wordColContent = [];
      }
      continue;
    }

    const cState = hasChinese(char) ? 'CN' : 'EN_NUM';
    if (state === null) state = cState;

    if (state !== cState || (colWidth[cI] && colWidth[cI] > COL_WIDTH_SPLIT_THRESHOLD)) {
      if (wordContent.length > 0) {
        wordList.push(wordContent);
        wordColList.push(wordColContent);
        stateList.push(state);
        wordContent = [];
        wordColContent = [];
      }
      state = cState;
    }

    wordContent.push(char);
    wordColContent.push(validCols[cI]);
  }

  if (wordContent.length > 0) {
    wordList.push(wordContent);
    wordColList.push(wordColContent);
    stateList.push(state);
  }

  return {
    words: wordList,
    wordCols: wordColList,
    wordTypes: stateList,
    lineTxtLen: validCols.length,
    confs: [],
  };
}

/**
 * Compute column width gaps between consecutive valid columns.
 * @private
 */
function computeColWidths(validCols, text, hasChinese) {
  const colWidth = new Array(validCols.length);
  for (let i = 1; i < validCols.length; i++) {
    colWidth[i] = validCols[i] - validCols[i - 1];
  }
  colWidth[0] = Math.min(hasChinese(text[0]) ? 3 : 2, validCols[0]);
  return colWidth;
}
