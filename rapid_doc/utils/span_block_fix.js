// Copyright (c) Opendatalab. All rights reserved.

import { calculateOverlapAreaInBbox1AreaRatio } from './boxbase.js';
import { BlockType, ContentType } from './enum_class.js';
import { isOverlapsYExceedsThreshold, isOverlapsXExceedsThreshold } from './ocr_utils.js';

// ────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────

const VERTICAL_SPAN_HEIGHT_TO_WIDTH_RATIO_THRESHOLD = 2;
const VERTICAL_SPAN_IN_BLOCK_THRESHOLD = 0.8;

const GROUPED_BLOCK_TYPES = new Set([
  BlockType.IMAGE_BODY, BlockType.IMAGE_CAPTION, BlockType.IMAGE_FOOTNOTE,
  BlockType.TABLE_BODY, BlockType.TABLE_CAPTION, BlockType.TABLE_FOOTNOTE,
]);

const TEXT_BLOCK_TYPES = [
  BlockType.TEXT, BlockType.TITLE,
  BlockType.IMAGE_CAPTION, BlockType.TABLE_CAPTION, BlockType.TABLE_FOOTNOTE,
];

const INTERLINE_BLOCK_TYPES = [
  BlockType.INTERLINE_EQUATION, BlockType.IMAGE_BODY, BlockType.TABLE_BODY,
];

const TEXT_COMPATIBLE_BLOCK_TYPES = [
  BlockType.TEXT, BlockType.TITLE,
  BlockType.IMAGE_CAPTION, BlockType.IMAGE_FOOTNOTE,
  BlockType.TABLE_CAPTION, BlockType.TABLE_FOOTNOTE,
  BlockType.DISCARDED,
];

const SPECIAL_SPAN_TYPES = new Set([
  ContentType.INTERLINE_EQUATION, ContentType.IMAGE, ContentType.TABLE,
]);

const IMAGE_TABLE_OVERLAP_RATIO = 0.9;

// ────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────

/**
 * Assign spans to their containing blocks.
 * @param {Array[]} blocks - raw bbox tuples from addBboxes
 * @param {Array<object>} spans
 * @param {number} radio - overlap ratio threshold
 * @returns {[Array<object>, Array<object>]} [blockWithSpans, remainingSpans]
 */
export function fillSpansInBlocks(blocks, spans, radio) {
  if (!Array.isArray(blocks) || !Array.isArray(spans)) return [[], spans ?? []];

  const blockWithSpans = [];
  for (const block of blocks) {
    const blockDict = buildBlockDict(block);
    const blockSpans = findMatchingSpans(spans, blockDict.bbox, block[7], radio);

    blockDict.spans = blockSpans;
    blockDict.original_label = block[10] ?? null;
    blockDict.original_order = block[11] ?? null;
    blockDict.polygon_points = block.length > 14 ? block[14] : null;
    blockWithSpans.push(blockDict);

    for (const span of blockSpans) {
      const idx = spans.indexOf(span);
      if (idx !== -1) spans.splice(idx, 1);
    }
  }

  return [blockWithSpans, spans];
}

function buildBlockDict(block) {
  const blockType = block[7];
  const blockBbox = block.slice(0, 4);
  const blockDict = { type: blockType, bbox: blockBbox };

  if (GROUPED_BLOCK_TYPES.has(blockType)) {
    blockDict.group_id = block.length > 13 ? block[13] : null;
  }

  return blockDict;
}

function findMatchingSpans(spans, blockBbox, blockType, radio) {
  const matched = [];
  for (const span of spans) {
    const spanBbox = span?.bbox;
    if (!spanBbox) continue;

    const threshold = (span.type === ContentType.IMAGE || span.type === ContentType.TABLE)
      ? IMAGE_TABLE_OVERLAP_RATIO
      : radio;

    if (calculateOverlapAreaInBbox1AreaRatio(spanBbox, blockBbox) > threshold &&
        spanBlockTypeCompatible(span.type, blockType)) {
      matched.push(span);
    }
  }
  return matched;
}

/**
 * Determine if a span type is compatible with a block type.
 * @param {*} spanType
 * @param {*} blockType
 * @returns {boolean}
 */
export function spanBlockTypeCompatible(spanType, blockType) {
  if ([ContentType.TEXT, ContentType.INLINE_EQUATION, ContentType.CHECKBOX].includes(spanType)) {
    return TEXT_COMPATIBLE_BLOCK_TYPES.includes(blockType);
  }
  if (spanType === ContentType.INTERLINE_EQUATION) {
    return blockType === BlockType.INTERLINE_EQUATION || blockType === BlockType.TEXT;
  }
  if (spanType === ContentType.IMAGE) {
    return blockType === BlockType.IMAGE_BODY;
  }
  if (spanType === ContentType.TABLE) {
    return blockType === BlockType.TABLE_BODY;
  }
  return false;
}

/**
 * Fix discarded blocks (ensure all interline equations become inline).
 * @param {Array<object>} discardedBlockWithSpans
 * @returns {Array<object>}
 */
export function fixDiscardedBlock(discardedBlockWithSpans) {
  if (!Array.isArray(discardedBlockWithSpans)) return [];
  return discardedBlockWithSpans.map(fixTextBlock);
}

/**
 * Determine if a text block should be treated as vertical text based on span ratios.
 * @param {Array<object>} spans
 * @returns {boolean}
 */
export function isVerticalTextBlockBySpans(spans) {
  if (!Array.isArray(spans) || spans.length === 0) return false;

  let validSpanCount = 0;
  let verticalSpanCount = 0;

  for (const span of spans) {
    const bbox = span?.bbox;
    if (!bbox || bbox.length < 4) continue;

    const spanWidth = bbox[2] - bbox[0];
    const spanHeight = bbox[3] - bbox[1];
    if (spanWidth <= 0 || spanHeight <= 0) continue;

    validSpanCount++;
    if (spanHeight / spanWidth > VERTICAL_SPAN_HEIGHT_TO_WIDTH_RATIO_THRESHOLD) {
      verticalSpanCount++;
    }
  }

  if (validSpanCount === 0) return false;
  return verticalSpanCount / validSpanCount > VERTICAL_SPAN_IN_BLOCK_THRESHOLD;
}

/**
 * Convert spans in a text block into structured lines.
 * @param {object} block
 * @returns {object}
 */
export function fixTextBlock(block) {
  if (!block) return block;

  for (const span of block.spans ?? []) {
    if (span.type === ContentType.INTERLINE_EQUATION) {
      span.type = ContentType.INLINE_EQUATION;
    }
  }

  const spans = block.spans ?? [];

  if (isVerticalTextBlockBySpans(spans)) {
    const blockLines = mergeSpansToVerticalLine(spans);
    block.lines = verticalLineSortSpansFromTopToBottom(blockLines);
  } else {
    const blockLines = mergeSpansToLine(spans);
    block.lines = lineSortSpansByLeftToRight(blockLines);
  }

  delete block.spans;
  return block;
}


// ────────────────────────────────────────────────
// Line merging
// ────────────────────────────────────────────────

/**
 * Merge spans into horizontal lines by Y-axis overlap.
 * @param {Array<object>} spans
 * @param {number} [threshold=0.6]
 * @returns {Array<Array<object>>}
 */
export function mergeSpansToLine(spans, threshold = 0.6) {
  if (!Array.isArray(spans) || spans.length === 0) return [];

  const sorted = [...spans].sort((a, b) => a.bbox[1] - b.bbox[1]);
  const lines = [];
  let currentLine = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const span = sorted[i];
    if (shouldStartNewLine(span, currentLine)) {
      lines.push(currentLine);
      currentLine = [span];
      continue;
    }
    if (isOverlapsYExceedsThreshold(span.bbox, currentLine[currentLine.length - 1].bbox, threshold)) {
      currentLine.push(span);
    } else {
      lines.push(currentLine);
      currentLine = [span];
    }
  }
  if (currentLine.length > 0) lines.push(currentLine);
  return lines;
}

/**
 * Merge spans into vertical lines by X-axis overlap (right-to-left).
 * @param {Array<object>} spans
 * @param {number} [threshold=0.6]
 * @returns {Array<Array<object>>}
 */
export function mergeSpansToVerticalLine(spans, threshold = 0.6) {
  if (!Array.isArray(spans) || spans.length === 0) return [];

  const sorted = [...spans].sort((a, b) => b.bbox[2] - a.bbox[2]);
  const verticalLines = [];
  let currentLine = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const span = sorted[i];
    if (shouldStartNewLine(span, currentLine)) {
      verticalLines.push(currentLine);
      currentLine = [span];
      continue;
    }
    if (isOverlapsXExceedsThreshold(span.bbox, currentLine[currentLine.length - 1].bbox, threshold)) {
      currentLine.push(span);
    } else {
      verticalLines.push(currentLine);
      currentLine = [span];
    }
  }
  if (currentLine.length > 0) verticalLines.push(currentLine);
  return verticalLines;
}

function shouldStartNewLine(span, currentLine) {
  return SPECIAL_SPAN_TYPES.has(span.type) || currentLine.some(s => SPECIAL_SPAN_TYPES.has(s.type));
}

// ────────────────────────────────────────────────
// Line sorting
// ────────────────────────────────────────────────

/**
 * Sort spans in each line from left to right and compute line bbox.
 * @param {Array<Array<object>>} lines
 * @returns {Array<object>}
 */
export function lineSortSpansByLeftToRight(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map(line => {
    line.sort((a, b) => a.bbox[0] - b.bbox[0]);
    return { bbox: computeLineBbox(line), spans: line };
  });
}

/**
 * Sort spans in each vertical line from top to bottom.
 * @param {Array<Array<object>>} verticalLines
 * @returns {Array<object>}
 */
export function verticalLineSortSpansFromTopToBottom(verticalLines) {
  if (!Array.isArray(verticalLines)) return [];
  return verticalLines.map(line => {
    line.sort((a, b) => a.bbox[1] - b.bbox[1]);
    return { bbox: computeLineBbox(line), spans: line };
  });
}

function computeLineBbox(line) {
  if (!line || !line.length) return [0, 0, 0, 0];
  return [
    Math.min(...line.map(s => s.bbox[0])),
    Math.min(...line.map(s => s.bbox[1])),
    Math.max(...line.map(s => s.bbox[2])),
    Math.max(...line.map(s => s.bbox[3])),
  ];
}

// ────────────────────────────────────────────────
// Block fixing
// ────────────────────────────────────────────────

/**
 * Fix blocks by type: text blocks get line structure; equation/image/table get interline fix.
 * @param {Array<object>} blockWithSpans
 * @returns {Array<object>}
 */
export function fixBlockSpans(blockWithSpans) {
  if (!Array.isArray(blockWithSpans)) return [];

  const fixBlocks = [];
  for (const block of blockWithSpans) {
    if (TEXT_BLOCK_TYPES.includes(block.type)) {
      fixBlocks.push(fixTextBlock(block));
    } else if (INTERLINE_BLOCK_TYPES.includes(block.type)) {
      fixBlocks.push(fixInterlineBlock(block));
    }
  }
  return fixBlocks;
}

/**
 * Fix an interline equation / image / table block.
 * @param {object} block
 * @returns {object}
 */
export function fixInterlineBlock(block) {
  if (!block) return block;
  const blockLines = mergeSpansToLine(block.spans ?? []);
  block.lines = lineSortSpansByLeftToRight(blockLines);
  delete block.spans;
  return block;
}
