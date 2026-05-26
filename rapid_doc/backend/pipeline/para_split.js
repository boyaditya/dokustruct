// Copyright (c) RapidAI. All rights reserved.
// Pure data transformation — no async required.

import { ContentType, BlockType, SplitFlag } from "../../utils/enum_class.js";
import { detectLang } from "../../utils/language.js";

const LINE_STOP_FLAG = ['.', '!', '?', '。', '！', '？', ')', '）', '"', '"', ':', '：', ';', '；'];
const LIST_END_FLAG = ['.', '。', ';', '；'];

const CJK_LANGUAGES = new Set(['zh', 'ja', 'ko']);
const LEFT_CLOSE_RATIO_THRESHOLD = 0.8;
const RIGHT_CLOSE_RATIO_THRESHOLD = 0.5;
const EXTERNAL_SIDES_RATIO_THRESHOLD = 0.5;
const BLOCK_ASPECT_RATIO_THRESHOLD = 0.4;
const WIDE_BLOCK_WEIGHT_RATIO = 0.5;
const NARROW_CLOSED_AREA_FACTOR = 0.36;
const WIDE_CLOSED_AREA_FACTOR = 0.26;
const RIGHT_GAP_RATIO = 0.1;

/**
 * @readonly
 * @enum {string}
 */
export const ListLineTag = Object.freeze({
  IS_LIST_START_LINE: 'is_list_start_line',
  IS_LIST_END_LINE: 'is_list_end_line',
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pre-process blocks into groups: continuous text blocks → one group, others individual.
 * @param {object[]} blocks
 * @returns {object[]} groups
 */
function processBlocks(blocks) {
  if (!blocks || !blocks.length) return [];

  const result = [];
  let currentGroup = [];

  const flushCurrentGroup = () => {
    if (currentGroup.length > 0) {
      result.push({ group_type: "text", blocks: currentGroup });
      currentGroup = [];
    }
  };

  for (let i = 0; i < blocks.length; i++) {
    const currentBlock = blocks[i];

    if (currentBlock.type === "text") {
      currentBlock.bbox_fs = computeBlockBboxFs(currentBlock);
      currentGroup.push(currentBlock);
    } else {
      flushCurrentGroup();
      result.push({ group_type: currentBlock.type, blocks: [currentBlock] });
    }

    if (i + 1 < blocks.length) {
      const nextBlock = blocks[i + 1];
      if (nextBlock.type === "title" || nextBlock.type === "interline_equation") {
        flushCurrentGroup();
      }
    }
  }
  flushCurrentGroup();
  return result;
}

/**
 * Compute the bounding box from lines, falling back to block bbox.
 * @param {object} block
 * @returns {number[]}
 */
function computeBlockBboxFs(block) {
  const lines = block.lines;
  if (!lines || !lines.length) {
    return block.bbox ? [...block.bbox] : [0, 0, 0, 0];
  }
  return [
    Math.min(...lines.map(l => l.bbox[0])),
    Math.min(...lines.map(l => l.bbox[1])),
    Math.max(...lines.map(l => l.bbox[2])),
    Math.max(...lines.map(l => l.bbox[3])),
  ];
}

/**
 * Classify a block as LIST, INDEX, or TEXT based on line geometry.
 * @param {object} block
 * @returns {string} BlockType
 */
function isListOrIndexBlock(block) {
  const lines = block.lines;
  if (!lines || lines.length < 2) return BlockType.TEXT;

  const firstLine = lines[0];
  const lineHeight = firstLine.bbox[3] - firstLine.bbox[1];
  if (lineHeight <= 0) return BlockType.TEXT;

  const blockWeight = block.bbox_fs[2] - block.bbox_fs[0];
  const blockHeight = block.bbox_fs[3] - block.bbox_fs[1];
  const [pageWeight] = block.page_size || [1, 1];
  const blockWeightRatio = pageWeight > 0 ? blockWeight / pageWeight : 0;

  const multipleParaFlag = detectMultipleParagraphs(lines, block, lineHeight);
  const { linesTextList, blockLang } = extractTextAndLang(lines);
  const alignment = computeAlignment(lines, block, lineHeight, blockWeight, blockWeightRatio, blockLang);
  const lineFlags = computeLineFlags(linesTextList);

  return classifyBlock(
    lines, block, linesTextList, lineHeight, blockWeight, blockHeight,
    alignment, lineFlags, multipleParaFlag
  );
}

/**
 * Detect if block contains multiple paragraphs based on first/last line indentation.
 */
function detectMultipleParagraphs(lines, block, lineHeight) {
  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  return (
    firstLine.bbox[0] - block.bbox_fs[0] > lineHeight / 2 &&
    Math.abs(lastLine.bbox[0] - block.bbox_fs[0]) < lineHeight / 2 &&
    block.bbox_fs[2] - lastLine.bbox[2] > lineHeight
  );
}

/**
 * Extract text content from lines and detect language.
 */
function extractTextAndLang(lines) {
  const linesTextList = [];
  for (const line of lines) {
    let lineText = '';
    if (line.spans) {
      for (const span of line.spans) {
        if (span.type === ContentType.TEXT) {
          lineText += (span.content || '').trim();
        }
      }
    }
    linesTextList.push(lineText);
  }
  const blockText = linesTextList.join('');
  const blockLang = detectLang(blockText);
  return { linesTextList, blockLang };
}

/**
 * Compute alignment statistics for all lines in a block.
 */
function computeAlignment(lines, block, lineHeight, blockWeight, blockWeightRatio, blockLang) {
  let leftCloseNum = 0;
  let leftNotCloseNum = 0;
  let rightNotCloseNum = 0;
  let rightCloseNum = 0;
  let centerCloseNum = 0;
  let externalSidesNotCloseNum = 0;

  for (const line of lines) {
    const lineMidX = (line.bbox[0] + line.bbox[2]) / 2;
    const blockMidX = (block.bbox_fs[0] + block.bbox_fs[2]) / 2;

    if (
      line.bbox[0] - block.bbox_fs[0] > 0.7 * lineHeight &&
      block.bbox_fs[2] - line.bbox[2] > 0.7 * lineHeight
    ) externalSidesNotCloseNum++;

    if (Math.abs(lineMidX - blockMidX) < lineHeight / 2) centerCloseNum++;

    if (Math.abs(block.bbox_fs[0] - line.bbox[0]) < lineHeight / 2) {
      leftCloseNum++;
    } else if (line.bbox[0] - block.bbox_fs[0] > lineHeight) {
      leftNotCloseNum++;
    }

    if (Math.abs(block.bbox_fs[2] - line.bbox[2]) < lineHeight) {
      rightCloseNum++;
    } else {
      let closedArea;
      if (CJK_LANGUAGES.has(blockLang)) {
        closedArea = WIDE_CLOSED_AREA_FACTOR * blockWeight;
      } else {
        closedArea = blockWeightRatio >= WIDE_BLOCK_WEIGHT_RATIO
          ? WIDE_CLOSED_AREA_FACTOR * blockWeight
          : NARROW_CLOSED_AREA_FACTOR * blockWeight;
      }
      if (block.bbox_fs[2] - line.bbox[2] > closedArea) rightNotCloseNum++;
    }
  }

  return {
    leftCloseNum, leftNotCloseNum, rightNotCloseNum,
    rightCloseNum, centerCloseNum, externalSidesNotCloseNum,
  };
}

/**
 * Compute line-level flags (numeric start/end, punctuation end).
 */
function computeLineFlags(linesTextList) {
  let numStartCount = 0;
  let numEndCount = 0;
  let flagEndCount = 0;

  for (const lineText of linesTextList) {
    if (lineText.length > 0) {
      if (LIST_END_FLAG.includes(lineText[lineText.length - 1])) flagEndCount++;
      if (/^\d/.test(lineText)) numStartCount++;
      if (/\d$/.test(lineText)) numEndCount++;
    }
  }

  const total = linesTextList.length;
  const lineNumFlag = total > 0 && (numStartCount / total >= 0.8 || numEndCount / total >= 0.8);
  const lineEndFlag = total > 0 && (flagEndCount / total >= 0.8);

  return { numStartCount, flagEndCount, lineNumFlag, lineEndFlag };
}

/**
 * Final classification logic based on alignment and line flags.
 */
function classifyBlock(
  lines, block, linesTextList, lineHeight, blockWeight, blockHeight,
  alignment, lineFlags, multipleParaFlag
) {
  const { leftCloseNum, leftNotCloseNum, rightNotCloseNum, rightCloseNum, centerCloseNum, externalSidesNotCloseNum } = alignment;
  const { numStartCount, flagEndCount, lineNumFlag, lineEndFlag } = lineFlags;
  const lineCount = lines.length;

  if (
    (leftCloseNum / lineCount >= LEFT_CLOSE_RATIO_THRESHOLD || rightCloseNum / lineCount >= LEFT_CLOSE_RATIO_THRESHOLD) &&
    lineNumFlag
  ) {
    for (const line of lines) line[ListLineTag.IS_LIST_START_LINE] = true;
    return BlockType.INDEX;
  }

  if (
    externalSidesNotCloseNum >= 2 &&
    centerCloseNum === lineCount &&
    externalSidesNotCloseNum / lineCount >= EXTERNAL_SIDES_RATIO_THRESHOLD &&
    blockHeight / blockWeight > BLOCK_ASPECT_RATIO_THRESHOLD
  ) {
    for (const line of lines) line[ListLineTag.IS_LIST_START_LINE] = true;
    return BlockType.LIST;
  }

  if (
    leftCloseNum >= 2 &&
    (rightNotCloseNum >= 2 || lineEndFlag || leftNotCloseNum >= 2) &&
    !multipleParaFlag
  ) {
    classifyListLines(lines, block, linesTextList, lineHeight, blockWeight, leftCloseNum, rightCloseNum, flagEndCount, lineEndFlag, numStartCount);
    return BlockType.LIST;
  }

  return BlockType.TEXT;
}

/**
 * Assign list start/end line tags based on alignment patterns.
 */
function classifyListLines(lines, block, linesTextList, lineHeight, blockWeight, leftCloseNum, rightCloseNum, flagEndCount, lineEndFlag, numStartCount) {
  const lineCount = lines.length;

  if (leftCloseNum / lineCount > LEFT_CLOSE_RATIO_THRESHOLD) {
    if (flagEndCount === 0 && rightCloseNum / lineCount < RIGHT_CLOSE_RATIO_THRESHOLD) {
      for (const line of lines) {
        if (Math.abs(block.bbox_fs[0] - line.bbox[0]) < lineHeight / 2) {
          line[ListLineTag.IS_LIST_START_LINE] = true;
        }
      }
    } else if (lineEndFlag) {
      for (let i = 0; i < lines.length; i++) {
        const lt = linesTextList[i];
        if (lt.length > 0 && LIST_END_FLAG.includes(lt[lt.length - 1])) {
          lines[i][ListLineTag.IS_LIST_END_LINE] = true;
          if (i + 1 < lines.length) lines[i + 1][ListLineTag.IS_LIST_START_LINE] = true;
        }
      }
    } else {
      let lineStartFlag = false;
      for (let i = 0; i < lines.length; i++) {
        if (lineStartFlag) { lines[i][ListLineTag.IS_LIST_START_LINE] = true; lineStartFlag = false; }
        if (Math.abs(block.bbox_fs[2] - lines[i].bbox[2]) > RIGHT_GAP_RATIO * blockWeight) {
          lines[i][ListLineTag.IS_LIST_END_LINE] = true;
          lineStartFlag = true;
        }
      }
    }
  } else if (numStartCount >= 2 && numStartCount === flagEndCount) {
    for (let i = 0; i < lines.length; i++) {
      const lt = linesTextList[i];
      if (lt.length > 0) {
        if (/^\d/.test(lt)) lines[i][ListLineTag.IS_LIST_START_LINE] = true;
        if (LIST_END_FLAG.includes(lt[lt.length - 1])) lines[i][ListLineTag.IS_LIST_END_LINE] = true;
      }
    }
  } else {
    for (const line of lines) {
      if (Math.abs(block.bbox_fs[0] - line.bbox[0]) < lineHeight / 2) line[ListLineTag.IS_LIST_START_LINE] = true;
      if (Math.abs(block.bbox_fs[2] - line.bbox[2]) > lineHeight) line[ListLineTag.IS_LIST_END_LINE] = true;
    }
  }
}

/**
 * Merge two consecutive text blocks if conditions are met.
 * @param {object} block1 - current block (end of group)
 * @param {object} block2 - previous block (beginning of group)
 * @returns {[object, object]}
 */
function mergeTextBlocks(block1, block2) {
  if (!block1.lines || !block1.lines.length) return [block1, block2];
  if (!block2.lines || !block2.lines.length) return [block1, block2];

  const firstLine = block1.lines[0];
  const lineHeight = firstLine.bbox[3] - firstLine.bbox[1];
  const block1Weight = block1.bbox[2] - block1.bbox[0];
  const block2Weight = block2.bbox[2] - block2.bbox[0];
  const minBlockWeight = Math.min(block1Weight, block2Weight);

  if (Math.abs(block1.bbox_fs[0] - firstLine.bbox[0]) >= lineHeight / 2) return [block1, block2];

  const lastLine = block2.lines[block2.lines.length - 1];
  if (!lastLine?.spans?.length) return [block1, block2];

  const lastSpan = lastLine.spans[lastLine.spans.length - 1];
  const lastLineHeight = lastLine.bbox[3] - lastLine.bbox[1];

  if (!firstLine.spans?.length) return [block1, block2];
  const firstSpan = firstLine.spans[0];
  if (!firstSpan.content?.length) return [block1, block2];

  const spanStartWithNum = /^\d/.test(firstSpan.content);
  const spanStartWithBigChar = /^[A-Z]/.test(firstSpan.content);

  if (
    Math.abs(block2.bbox_fs[2] - lastLine.bbox[2]) < lastLineHeight &&
    !LINE_STOP_FLAG.some(f => lastSpan.content?.endsWith(f)) &&
    Math.abs(block1Weight - block2Weight) < minBlockWeight &&
    !spanStartWithNum &&
    !spanStartWithBigChar
  ) {
    if (block1.page_num !== block2.page_num) {
      for (const line of block1.lines) {
        for (const span of (line.spans || [])) {
          span[SplitFlag.CROSS_PAGE] = true;
        }
      }
    }
    block2.lines.push(...block1.lines);
    block1.lines = [];
    block1[SplitFlag.LINES_DELETED] = true;
  }

  return [block1, block2];
}

/**
 * Merge two consecutive list blocks.
 * @param {object} block1
 * @param {object} block2
 * @returns {[object, object]}
 */
function mergeListBlocks(block1, block2) {
  if (!block1.lines?.length) return [block1, block2];

  if (block1.page_num !== block2.page_num) {
    for (const line of block1.lines) {
      if (!line.spans) continue;
      for (const span of line.spans) {
        span[SplitFlag.CROSS_PAGE] = true;
      }
    }
  }
  block2.lines.push(...block1.lines);
  block1.lines = [];
  block1[SplitFlag.LINES_DELETED] = true;
  return [block1, block2];
}

/**
 * Check if all blocks in a group are list-like (≤3 lines each).
 * @param {object[]} textBlocksGroup
 * @returns {boolean}
 */
function isListGroup(textBlocksGroup) {
  return textBlocksGroup.every(block => !block.lines || block.lines.length <= 3);
}

/**
 * Merge blocks within each page group.
 * @param {object[]} blocks
 */
function paraMergePage(blocks) {
  if (!blocks || !blocks.length) return;

  const pageTextBlocksGroups = processBlocks(blocks);

  for (const group of pageTextBlocksGroups) {
    const blocksInGroup = group.blocks;
    if (!blocksInGroup?.length) continue;

    if (group.group_type === "text") {
      for (const block of blocksInGroup) {
        block.type = isListOrIndexBlock(block);
      }
    }

    if (blocksInGroup.length > 1 && group.group_type === "text") {
      const isListGrp = isListGroup(blocksInGroup);

      for (let i = blocksInGroup.length - 1; i >= 0; i--) {
        const currentBlock = blocksInGroup[i];
        if (i - 1 < 0) continue;

        const prevBlock = blocksInGroup[i - 1];
        if (currentBlock.type === "text" && prevBlock.type === "text" && !isListGrp) {
          mergeTextBlocks(currentBlock, prevBlock);
        } else if (
          (currentBlock.type === BlockType.LIST && prevBlock.type === BlockType.LIST) ||
          (currentBlock.type === BlockType.INDEX && prevBlock.type === BlockType.INDEX)
        ) {
          mergeListBlocks(currentBlock, prevBlock);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Split page info list into paragraphs.
 * @param {object[]} pageInfoList
 */
export function paraSplit(pageInfoList) {
  if (!pageInfoList || !pageInfoList.length) return;

  const allBlocks = [];

  for (const pageInfo of pageInfoList) {
    const blocks = structuredClone(pageInfo.preproc_blocks || []);
    for (const block of blocks) {
      block.page_num = pageInfo.page_idx;
      block.page_size = pageInfo.page_size;
    }
    allBlocks.push(...blocks);
  }

  paraMergePage(allBlocks);

  for (const pageInfo of pageInfoList) {
    pageInfo.para_blocks = [];
    for (const block of allBlocks) {
      if ('page_num' in block && block.page_num === pageInfo.page_idx) {
        pageInfo.para_blocks.push(block);
        delete block.page_num;
        delete block.page_size;
      }
    }
  }
}
