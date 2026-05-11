// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: span_block_fix.py → span_block_fix.js
 *
 * Direct port — pure logic, no numpy/PIL/cv2 usage.
 * All operations are on plain JS objects and arrays.
 *
 * WORKAROUND: list.remove(span) with object identity
 * REASON: JS arrays don't have a .remove() with identity semantics
 * SOLUTION: splice(indexOf(span), 1) using same reference.
 *
 * WORKAROUND: del block['spans'] (Python key delete)
 * REASON: JS idiom difference
 * SOLUTION: delete block.spans
 */

import { calculateOverlapAreaInBbox1AreaRatio } from './boxbase.js';
import { BlockType, ContentType } from './enum_class.js';
import { isOverlapsYExceedsThreshold, isOverlapsXExceedsThreshold } from './ocr_utils.js';

const VERTICAL_SPAN_HEIGHT_TO_WIDTH_RATIO_THRESHOLD = 2;
const VERTICAL_SPAN_IN_BLOCK_THRESHOLD = 0.8;

/**
 * Assign spans to their containing blocks.
 * PORTING NOTE: fill_spans_in_blocks(blocks, spans, radio) → fillSpansInBlocks(...)
 *
 * @param {Array[]} blocks   - raw bbox tuples from addBboxes
 * @param {Array<object>} spans
 * @param {number} radio     - overlap ratio threshold
 * @returns {[Array<object>, Array<object>]} [blockWithSpans, remainingSpans]
 */
export function fillSpansInBlocks(blocks, spans, radio) {
  const blockWithSpans = [];
  for (const block of blocks) {
    const blockType = block[7];
    const blockBbox = block.slice(0, 4);
    const blockDict = { type: blockType, bbox: blockBbox };

    const groupedTypes = new Set([
      BlockType.IMAGE_BODY, BlockType.IMAGE_CAPTION, BlockType.IMAGE_FOOTNOTE,
      BlockType.TABLE_BODY, BlockType.TABLE_CAPTION, BlockType.TABLE_FOOTNOTE,
    ]);
    if (groupedTypes.has(blockType)) {
      blockDict.group_id = block.length > 13 ? block[13] : null;
    }

    const blockSpans = [];
    for (const span of spans) {
      let tempRadio = radio;
      const spanBbox = span.bbox;
      if (span.type === ContentType.IMAGE || span.type === ContentType.TABLE) {
        tempRadio = 0.9;
      }
      if (
        calculateOverlapAreaInBbox1AreaRatio(spanBbox, blockBbox) > tempRadio &&
        spanBlockTypeCompatible(span.type, blockType)
      ) {
        blockSpans.push(span);
      }
    }

    blockDict.spans = blockSpans;
    blockDict.original_label = block[10] ?? null;
    blockDict.original_order = block[11] ?? null;
    blockDict.polygon_points = block.length > 14 ? block[14] : null;
    blockWithSpans.push(blockDict);

    // Remove placed spans from the global list
    for (const span of blockSpans) {
      const idx = spans.indexOf(span);
      if (idx !== -1) spans.splice(idx, 1);
    }
  }

  return [blockWithSpans, spans];
}

/**
 * Determine if a span type is compatible with a block type.
 * PORTING NOTE: span_block_type_compatible → spanBlockTypeCompatible
 *
 * @param {*} spanType
 * @param {*} blockType
 * @returns {boolean}
 */
export function spanBlockTypeCompatible(spanType, blockType) {
  if ([ContentType.TEXT, ContentType.INLINE_EQUATION, ContentType.CHECKBOX].includes(spanType)) {
    return [
      BlockType.TEXT, BlockType.TITLE,
      BlockType.IMAGE_CAPTION, BlockType.IMAGE_FOOTNOTE,
      BlockType.TABLE_CAPTION, BlockType.TABLE_FOOTNOTE,
      BlockType.DISCARDED,
    ].includes(blockType);
  } else if (spanType === ContentType.INTERLINE_EQUATION) {
    return blockType === BlockType.INTERLINE_EQUATION || blockType === BlockType.TEXT;
  } else if (spanType === ContentType.IMAGE) {
    return blockType === BlockType.IMAGE_BODY;
  } else if (spanType === ContentType.TABLE) {
    return blockType === BlockType.TABLE_BODY;
  }
  return false;
}

/**
 * Fix discarded blocks (ensure all interline equations become inline).
 * PORTING NOTE: fix_discarded_block → fixDiscardedBlock
 *
 * @param {Array<object>} discardedBlockWithSpans
 * @returns {Array<object>}
 */
export function fixDiscardedBlock(discardedBlockWithSpans) {
  return discardedBlockWithSpans.map(fixTextBlock);
}

/**
 * Determine if a text block should be treated as vertical text based on span ratios.
 * PORTING NOTE: is_vertical_text_block_by_spans → isVerticalTextBlockBySpans
 *
 * @param {Array<object>} spans
 * @returns {boolean}
 */
export function isVerticalTextBlockBySpans(spans) {
  let validSpanCount = 0;
  let verticalSpanCount = 0;

  for (const span of spans ?? []) {
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
 * PORTING NOTE: fix_text_block(block) → fixTextBlock(block)
 *
 * @param {object} block
 * @returns {object}
 */
export function fixTextBlock(block) {
  // Convert interline equations to inline in text blocks
  for (const span of block.spans ?? []) {
    if (span.type === ContentType.INTERLINE_EQUATION) {
      span.type = ContentType.INLINE_EQUATION;
    }
  }

  const spans = block.spans ?? [];

  let sortBlockLines;
  if (isVerticalTextBlockBySpans(spans)) {
    const blockLines = mergeSpansToVerticalLine(spans);
    sortBlockLines = verticalLineSortSpansFromTopToBottom(blockLines);
  } else {
    const blockLines = mergeSpansToLine(spans);
    sortBlockLines = lineSortSpansByLeftToRight(blockLines);
  }

  block.lines = sortBlockLines;
  delete block.spans;
  return block;
}

/**
 * Merge spans into horizontal lines by Y-axis overlap.
 * PORTING NOTE: merge_spans_to_line → mergeSpansToLine
 *
 * @param {Array<object>} spans
 * @param {number} [threshold=0.6]
 * @returns {Array<Array<object>>}
 */
export function mergeSpansToLine(spans, threshold = 0.6) {
  if (spans.length === 0) return [];

  const specialTypes = new Set([ContentType.INTERLINE_EQUATION, ContentType.IMAGE, ContentType.TABLE]);
  const sorted = [...spans].sort((a, b) => a.bbox[1] - b.bbox[1]);

  const lines = [];
  let currentLine = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const span = sorted[i];
    const hasSpecial = specialTypes.has(span.type) || currentLine.some(s => specialTypes.has(s.type));
    if (hasSpecial) {
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
 * PORTING NOTE: merge_spans_to_vertical_line → mergeSpansToVerticalLine
 *
 * @param {Array<object>} spans
 * @param {number} [threshold=0.6]
 * @returns {Array<Array<object>>}
 */
export function mergeSpansToVerticalLine(spans, threshold = 0.6) {
  if (spans.length === 0) return [];

  const specialTypes = new Set([ContentType.INTERLINE_EQUATION, ContentType.IMAGE, ContentType.TABLE]);
  const sorted = [...spans].sort((a, b) => b.bbox[2] - a.bbox[2]); // right-to-left

  const verticalLines = [];
  let currentLine = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const span = sorted[i];
    const hasSpecial = specialTypes.has(span.type) || currentLine.some(s => specialTypes.has(s.type));
    if (hasSpecial) {
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

/**
 * Sort spans in each line from left to right and compute line bbox.
 * PORTING NOTE: line_sort_spans_by_left_to_right → lineSortSpansByLeftToRight
 *
 * @param {Array<Array<object>>} lines
 * @returns {Array<object>}
 */
export function lineSortSpansByLeftToRight(lines) {
  return lines.map(line => {
    line.sort((a, b) => a.bbox[0] - b.bbox[0]);
    const lineBbox = [
      Math.min(...line.map(s => s.bbox[0])),
      Math.min(...line.map(s => s.bbox[1])),
      Math.max(...line.map(s => s.bbox[2])),
      Math.max(...line.map(s => s.bbox[3])),
    ];
    return { bbox: lineBbox, spans: line };
  });
}

/**
 * Sort spans in each vertical line from top to bottom.
 * PORTING NOTE: vertical_line_sort_spans_from_top_to_bottom → verticalLineSortSpansFromTopToBottom
 *
 * @param {Array<Array<object>>} verticalLines
 * @returns {Array<object>}
 */
export function verticalLineSortSpansFromTopToBottom(verticalLines) {
  return verticalLines.map(line => {
    line.sort((a, b) => a.bbox[1] - b.bbox[1]);
    const lineBbox = [
      Math.min(...line.map(s => s.bbox[0])),
      Math.min(...line.map(s => s.bbox[1])),
      Math.max(...line.map(s => s.bbox[2])),
      Math.max(...line.map(s => s.bbox[3])),
    ];
    return { bbox: lineBbox, spans: line };
  });
}

/**
 * Fix blocks by type: text blocks get line structure; equation/image/table get interline fix.
 * PORTING NOTE: fix_block_spans(block_with_spans) → fixBlockSpans(blockWithSpans)
 *
 * @param {Array<object>} blockWithSpans
 * @returns {Array<object>}
 */
export function fixBlockSpans(blockWithSpans) {
  const fixBlocks = [];
  for (const block of blockWithSpans) {
    const blockType = block.type;
    if ([
      BlockType.TEXT, BlockType.TITLE,
      BlockType.IMAGE_CAPTION, BlockType.TABLE_CAPTION, BlockType.TABLE_FOOTNOTE,
    ].includes(blockType)) {
      fixBlocks.push(fixTextBlock(block));
    } else if ([
      BlockType.INTERLINE_EQUATION, BlockType.IMAGE_BODY, BlockType.TABLE_BODY,
    ].includes(blockType)) {
      fixBlocks.push(fixInterlineBlock(block));
    }
    // Skip other types
  }
  return fixBlocks;
}

/**
 * Fix an interline equation / image / table block.
 * PORTING NOTE: fix_interline_block → fixInterlineBlock
 *
 * @param {object} block
 * @returns {object}
 */
export function fixInterlineBlock(block) {
  const blockLines = mergeSpansToLine(block.spans ?? []);
  const sortBlockLines = lineSortSpansByLeftToRight(blockLines);
  block.lines = sortBlockLines;
  delete block.spans;
  return block;
}
