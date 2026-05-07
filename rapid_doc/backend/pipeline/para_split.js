// Copyright (c) RapidAI. All rights reserved.
// PORTING NOTE: para_split.py → para_split.js
// Pure data transformation — no async required.

import { ContentType, BlockType, SplitFlag } from "../../utils/enum_class.js";
import { detectLang } from "../../utils/language.js";

const LINE_STOP_FLAG = ['.', '!', '?', '。', '！', '？', ')', '）', '"', '”', ':', '：', ';', '；'];
const LIST_END_FLAG = ['.', '。', ';', '；'];

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
 * PORTING NOTE: __process_blocks(blocks) → processBlocks(blocks)
 * @param {object[]} blocks
 * @returns {object[]} groups
 */
function processBlocks(blocks) {
  const result = [];
  let currentGroup = [];

  function flushCurrentGroup() {
    if (currentGroup.length > 0) {
      result.push({ group_type: "text", blocks: currentGroup });
      currentGroup = [];
    }
  }

  for (let i = 0; i < blocks.length; i++) {
    const currentBlock = blocks[i];

    if (currentBlock.type === "text") {
      // Recalculate bbox_fs from lines
      currentBlock.bbox_fs = currentBlock.bbox ? [...currentBlock.bbox] : [0, 0, 0, 0];
      if (currentBlock.lines && currentBlock.lines.length > 0) {
        currentBlock.bbox_fs = [
          Math.min(...currentBlock.lines.map(l => l.bbox[0])),
          Math.min(...currentBlock.lines.map(l => l.bbox[1])),
          Math.max(...currentBlock.lines.map(l => l.bbox[2])),
          Math.max(...currentBlock.lines.map(l => l.bbox[3])),
        ];
      }
      currentGroup.push(currentBlock);
    } else {
      flushCurrentGroup();
      result.push({ group_type: currentBlock.type, blocks: [currentBlock] });
    }

    // If next block is title or interline_equation, break current text group
    if (i + 1 < blocks.length) {
      const nextBlock = blocks[i + 1];
      if (["title", "interline_equation"].includes(nextBlock.type)) {
        flushCurrentGroup();
      }
    }
  }
  flushCurrentGroup();
  return result;
}

/**
 * Classify a block as LIST, INDEX, or TEXT based on line geometry.
 * PORTING NOTE: __is_list_or_index_block(block) → isListOrIndexBlock(block)
 * @param {object} block
 * @returns {string} BlockType
 */
function isListOrIndexBlock(block) {
  const lines = block.lines;
  if (!lines || lines.length < 2) return BlockType.TEXT;

  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  const lineHeight = firstLine.bbox[3] - firstLine.bbox[1];
  const blockWeight = block.bbox_fs[2] - block.bbox_fs[0];
  const blockHeight = block.bbox_fs[3] - block.bbox_fs[1];
  const [pageWeight] = block.page_size || [1, 1];

  const blockWeightRatio = pageWeight > 0 ? blockWeight / pageWeight : 0;

  let leftCloseNum = 0;
  let leftNotCloseNum = 0;
  let rightNotCloseNum = 0;
  let rightCloseNum = 0;
  let centerCloseNum = 0;
  let externalSidesNotCloseNum = 0;
  let multiplParaFlag = false;

  if (
    firstLine.bbox[0] - block.bbox_fs[0] > lineHeight / 2 &&
    Math.abs(lastLine.bbox[0] - block.bbox_fs[0]) < lineHeight / 2 &&
    block.bbox_fs[2] - lastLine.bbox[2] > lineHeight
  ) {
    multiplParaFlag = true;
  }

  const linesTextList = [];
  let blockText = '';
  for (const line of lines) {
    let lineText = '';
    for (const span of line.spans) {
      if (span.type === ContentType.TEXT) {
        lineText += (span.content || '').trim();
      }
    }
    linesTextList.push(lineText);
    blockText = linesTextList.join('');
  }

  const blockLang = detectLang(blockText);

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
      if (blockLang === 'zh' || blockLang === 'ja' || blockLang === 'ko') {
        closedArea = 0.26 * blockWeight;
      } else {
        closedArea = blockWeightRatio >= 0.5 ? 0.26 * blockWeight : 0.36 * blockWeight;
      }
      if (block.bbox_fs[2] - line.bbox[2] > closedArea) rightNotCloseNum++;
    }
  }

  let lineEndFlag = false;
  let lineNumFlag = false;
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
  if (linesTextList.length > 0) {
    if (numStartCount / linesTextList.length >= 0.8 || numEndCount / linesTextList.length >= 0.8) lineNumFlag = true;
    if (flagEndCount / linesTextList.length >= 0.8) lineEndFlag = true;
  }

  // INDEX: left or right flush + numeric rule
  if (
    (leftCloseNum / lines.length >= 0.8 || rightCloseNum / lines.length >= 0.8) &&
    lineNumFlag
  ) {
    for (const line of lines) line[ListLineTag.IS_LIST_START_LINE] = true;
    return BlockType.INDEX;
  }

  // Centered list
  if (
    externalSidesNotCloseNum >= 2 &&
    centerCloseNum === lines.length &&
    externalSidesNotCloseNum / lines.length >= 0.5 &&
    blockHeight / blockWeight > 0.4
  ) {
    for (const line of lines) line[ListLineTag.IS_LIST_START_LINE] = true;
    return BlockType.LIST;
  }

  if (
    leftCloseNum >= 2 &&
    (rightNotCloseNum >= 2 || lineEndFlag || leftNotCloseNum >= 2) &&
    !multiplParaFlag
  ) {
    if (leftCloseNum / lines.length > 0.8) {
      if (flagEndCount === 0 && rightCloseNum / lines.length < 0.5) {
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
          if (Math.abs(block.bbox_fs[2] - lines[i].bbox[2]) > 0.1 * blockWeight) {
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
    return BlockType.LIST;
  }

  return BlockType.TEXT;
}

/**
 * Merge two consecutive text blocks if conditions are met.
 * PORTING NOTE: __merge_2_text_blocks(block1, block2) → merge2TextBlocks(block1, block2)
 * @param {object} block1 - current block (end of group)
 * @param {object} block2 - previous block (beginning of group)
 * @returns {[object, object]}
 */
function merge2TextBlocks(block1, block2) {
  if (!block1.lines || block1.lines.length === 0) return [block1, block2];

  const firstLine = block1.lines[0];
  const lineHeight = firstLine.bbox[3] - firstLine.bbox[1];
  const block1Weight = block1.bbox[2] - block1.bbox[0];
  const block2Weight = block2.bbox[2] - block2.bbox[0];
  const minBlockWeight = Math.min(block1Weight, block2Weight);

  if (Math.abs(block1.bbox_fs[0] - firstLine.bbox[0]) >= lineHeight / 2) return [block1, block2];

  const lastLine = block2.lines[block2.lines.length - 1];
  if (!lastLine || lastLine.spans.length === 0) return [block1, block2];

  const lastSpan = lastLine.spans[lastLine.spans.length - 1];
  const lh2 = lastLine.bbox[3] - lastLine.bbox[1];
  if (!firstLine.spans || firstLine.spans.length === 0) return [block1, block2];

  const firstSpan = firstLine.spans[0];
  if (!firstSpan.content || firstSpan.content.length === 0) return [block1, block2];

  const spanStartWithNum = /^\d/.test(firstSpan.content);
  const spanStartWithBigChar = /^[A-Z]/.test(firstSpan.content);

  if (
    Math.abs(block2.bbox_fs[2] - lastLine.bbox[2]) < lh2 &&
    !LINE_STOP_FLAG.some(f => lastSpan.content && lastSpan.content.endsWith(f)) &&
    Math.abs(block1Weight - block2Weight) < minBlockWeight &&
    !spanStartWithNum &&
    !spanStartWithBigChar
  ) {
    if (block1.page_num !== block2.page_num) {
      for (const line of block1.lines) {
        for (const span of line.spans) {
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
function merge2ListBlocks(block1, block2) {
  if (block1.page_num !== block2.page_num) {
    for (const line of block1.lines) {
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
  return textBlocksGroup.every(block => block.lines.length <= 3);
}

/**
 * Merge blocks within each page group.
 * PORTING NOTE: __para_merge_page(blocks) → paraMergePage(blocks)
 * @param {object[]} blocks
 */
function paraMergePage(blocks) {
  const pageTextBlocksGroups = processBlocks(blocks);

  for (const group of pageTextBlocksGroups) {
    const blocksInGroup = group.blocks;

    if (blocksInGroup.length > 0 && group.group_type === "text") {
      for (const block of blocksInGroup) {
        block.type = isListOrIndexBlock(block);
      }
    }

    if (blocksInGroup.length > 1 && group.group_type === "text") {
      const isListGrp = isListGroup(blocksInGroup);

      for (let i = blocksInGroup.length - 1; i >= 0; i--) {
        const currentBlock = blocksInGroup[i];
        if (i - 1 >= 0) {
          const prevBlock = blocksInGroup[i - 1];
          if (currentBlock.type === "text" && prevBlock.type === "text" && !isListGrp) {
            merge2TextBlocks(currentBlock, prevBlock);
          } else if (
            (currentBlock.type === BlockType.LIST && prevBlock.type === BlockType.LIST) ||
            (currentBlock.type === BlockType.INDEX && prevBlock.type === BlockType.INDEX)
          ) {
            merge2ListBlocks(currentBlock, prevBlock);
          }
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
 * PORTING NOTE: para_split(page_info_list) → paraSplit(pageInfoList)
 * @param {object[]} pageInfoList
 */
export function paraSplit(pageInfoList) {
  const allBlocks = [];

  for (const pageInfo of pageInfoList) {
    const blocks = JSON.parse(JSON.stringify(pageInfo.preproc_blocks || [])); // deep copy
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

// Alias para_split → paraSplit (snake_case compat)
export { paraSplit as para_split };
