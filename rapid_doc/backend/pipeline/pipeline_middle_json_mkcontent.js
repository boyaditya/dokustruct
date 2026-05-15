// Copyright (c) RapidAI. All rights reserved.

import { getLatexDelimiterConfig } from "../../utils/config_reader.js";
import { ListLineTag } from "./para_split.js";
import { BlockType, ContentType, MakeMode } from "../../utils/enum_class.js";
import { detectLang } from "../../utils/language.js";

// ---------------------------------------------------------------------------
// LaTeX delimiter configuration
// ---------------------------------------------------------------------------

let _latexDelimitersConfig = null;
try {
  _latexDelimitersConfig = getLatexDelimiterConfig();
} catch {
  _latexDelimitersConfig = null;
}

const defaultDelimiters = {
  display: { left: '$', right: '$' },
  inline: { left: '$', right: '$' },
};

const delimiters = _latexDelimitersConfig || defaultDelimiters;

const displayLeftDelimiter = delimiters.display.left;
const displayRightDelimiter = delimiters.display.right;
const inlineLeftDelimiter = delimiters.inline.left;
const inlineRightDelimiter = delimiters.inline.right;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a line of text ends with one or more letters followed by a hyphen.
 * @param {string} line
 * @returns {boolean}
 */
function isHyphenAtLineEnd(line) {
  return /[A-Za-z]+-\s*$/.test(line);
}

/**
 * Convert full-width characters to half-width.
 * @param {string} text
 * @returns {string}
 */
export function fullToHalf(text) {
  if (!text) return '';
  let result = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (
      (code >= 0xFF21 && code <= 0xFF3A) ||
      (code >= 0xFF41 && code <= 0xFF5A) ||
      (code >= 0xFF10 && code <= 0xFF19)
    ) {
      result += String.fromCodePoint(code - 0xFEE0);
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * Escape special markdown characters in content.
 * @param {string} content
 * @returns {string}
 */
export function escapeSpecialMarkdownChar(content) {
  if (!content) return '';
  const specialChars = ['*', '`', '~'];
  for (const char of specialChars) {
    content = content.split(char).join('\\' + char);
  }
  return content;
}

/**
 * Get title level (1–4, 0 for edge cases).
 * @param {object} block
 * @returns {number}
 */
export function getTitleLevel(block) {
  if (!block) return 1;
  let titleLevel = block.level ?? 1;
  if (titleLevel > 4) titleLevel = 4;
  else if (titleLevel < 1) titleLevel = 0;
  return titleLevel;
}

/**
 * Merge a paragraph block into a markdown text string.
 * @param {object} paraBlock
 * @returns {string}
 */
export function mergeParaWithText(paraBlock) {
  if (!paraBlock) return '';

  const lines = paraBlock.lines || [];
  if (!lines.length) return '';

  let blockText = '';
  for (const line of lines) {
    for (const span of (line.spans || [])) {
      if (span.type === ContentType.TEXT) {
        span.content = fullToHalf(span.content || '');
        blockText += span.content;
      }
    }
  }
  const blockLang = detectLang(blockText);
  const cjkLangs = ['zh', 'ja', 'ko'];

  let paraText = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (i >= 1 && line[ListLineTag.IS_LIST_START_LINE]) {
      paraText += '  \n';
    }

    const spans = line.spans || [];

    for (let j = 0; j < spans.length; j++) {
      const span = spans[j];
      const spanType = span.type;
      let content = '';

      if (spanType === ContentType.TEXT) {
        content = escapeSpecialMarkdownChar(span.content || '');
      } else if (spanType === ContentType.INLINE_EQUATION) {
        if (span.content) content = `${inlineLeftDelimiter}${span.content}${inlineRightDelimiter}`;
      } else if (spanType === ContentType.INTERLINE_EQUATION) {
        if (span.content) content = `\n${displayLeftDelimiter}\n${span.content}\n${displayRightDelimiter}\n`;
      } else if (spanType === ContentType.CHECKBOX) {
        if (span.content) content = span.content;
      }

      content = content.trim();
      if (!content) continue;

      if (cjkLangs.includes(blockLang)) {
        if (j === spans.length - 1 && spanType !== ContentType.INLINE_EQUATION) {
          paraText += content;
        } else {
          paraText += `${content} `;
        }
      } else {
        if ([ContentType.TEXT, ContentType.INLINE_EQUATION, ContentType.CHECKBOX].includes(spanType)) {
          if (j === spans.length - 1 && spanType === ContentType.TEXT && isHyphenAtLineEnd(content)) {
            paraText += content.slice(0, -1);
          } else {
            paraText += `${content} `;
          }
        } else if (spanType === ContentType.INTERLINE_EQUATION) {
          paraText += content;
        }
      }
    }
  }

  return paraText;
}

/**
 * Convert layout paragraph blocks to markdown strings.
 * @param {object[]} parasOfLayout
 * @param {string} mode - MakeMode value
 * @param {string} [imgBuketPath='']
 * @returns {string[]}
 */
export function makeBlocksToMarkdown(parasOfLayout, mode, imgBuketPath = '') {
  if (!parasOfLayout || !parasOfLayout.length) return [];

  const pageMarkdown = [];

  for (const paraBlock of parasOfLayout) {
    if (!paraBlock) continue;

    let paraText = '';
    const paraType = paraBlock.type;

    if ([BlockType.TEXT, BlockType.LIST, BlockType.INDEX].includes(paraType)) {
      paraText = mergeParaWithText(paraBlock);

    } else if (paraType === BlockType.TITLE) {
      const titleLevel = getTitleLevel(paraBlock);
      paraText = `${'#'.repeat(titleLevel)} ${mergeParaWithText(paraBlock)}`;
      paraText = paraText.replace(/-\n/g, '').replace(/\n/g, ' ');

    } else if (paraType === BlockType.INTERLINE_EQUATION) {
      if (!paraBlock.lines?.length || !paraBlock.lines[0]?.spans?.length) continue;
      const span0 = paraBlock.lines[0].spans[0];
      if (span0.content) {
        paraText = mergeParaWithText(paraBlock);
      } else {
        paraText += `![](${imgBuketPath}/${span0.image_path || ''})`;
      }

    } else if (paraType === BlockType.IMAGE) {
      if (mode === MakeMode.NLP_MD) continue;
      if (mode === MakeMode.MM_MD) {
        paraText = buildImageMarkdown(paraBlock, imgBuketPath);
      }

    } else if (paraType === BlockType.TABLE) {
      if (mode === MakeMode.NLP_MD) continue;
      if (mode === MakeMode.MM_MD) {
        paraText = buildTableMarkdown(paraBlock, imgBuketPath);
      }
    }

    if (!paraText || paraText.trim() === '') continue;
    pageMarkdown.push(paraText.trim());
  }

  return pageMarkdown;
}

/**
 * Build markdown string for an image block.
 * @param {object} paraBlock
 * @param {string} imgBuketPath
 * @returns {string}
 */
function buildImageMarkdown(paraBlock, imgBuketPath) {
  let paraText = '';
  const blocks = paraBlock.blocks || [];
  const hasFootnote = blocks.some(b => b.type === BlockType.IMAGE_FOOTNOTE);

  if (hasFootnote) {
    for (const block of blocks) {
      if (block.type === BlockType.IMAGE_CAPTION) paraText += mergeParaWithText(block) + '  \n';
    }
    for (const block of blocks) {
      if (block.type === BlockType.IMAGE_BODY) {
        paraText += extractImagePaths(block, imgBuketPath);
      }
    }
    for (const block of blocks) {
      if (block.type === BlockType.IMAGE_FOOTNOTE) paraText += '  \n' + mergeParaWithText(block);
    }
  } else {
    for (const block of blocks) {
      if (block.type === BlockType.IMAGE_BODY) {
        paraText += extractImagePaths(block, imgBuketPath);
      }
    }
    for (const block of blocks) {
      if (block.type === BlockType.IMAGE_CAPTION) paraText += '  \n' + mergeParaWithText(block);
    }
  }

  return paraText;
}

/**
 * Extract image paths from an image body block as markdown image references.
 * @param {object} block
 * @param {string} imgBuketPath
 * @returns {string}
 */
function extractImagePaths(block, imgBuketPath) {
  let result = '';
  for (const line of (block.lines || [])) {
    for (const span of (line.spans || [])) {
      if (span.type === ContentType.IMAGE && span.image_path) {
        result += `![](${imgBuketPath}/${span.image_path})`;
      }
    }
  }
  return result;
}

/**
 * Build markdown string for a table block.
 * @param {object} paraBlock
 * @param {string} imgBuketPath
 * @returns {string}
 */
function buildTableMarkdown(paraBlock, imgBuketPath) {
  let paraText = '';
  const blocks = paraBlock.blocks || [];

  for (const block of blocks) {
    if (block.type === BlockType.TABLE_CAPTION) paraText += mergeParaWithText(block) + '  \n';
  }
  for (const block of blocks) {
    if (block.type === BlockType.TABLE_BODY) {
      for (const line of (block.lines || [])) {
        for (const span of (line.spans || [])) {
          if (span.type === ContentType.TABLE) {
            if (span.html) paraText += `\n${span.html}\n`;
            else if (span.image_path) paraText += `![](${imgBuketPath}/${span.image_path})`;
          }
        }
      }
    }
  }
  for (const block of blocks) {
    if (block.type === BlockType.TABLE_FOOTNOTE) paraText += '\n' + mergeParaWithText(block) + '  ';
  }

  return paraText;
}

/**
 * Convert a paragraph block to a content-list item.
 * @param {object} paraBlock
 * @param {string} imgBuketPath
 * @param {number} pageIdx
 * @param {number[]} pageSize
 * @returns {object|null}
 */
export function makeBlocksToContentList(paraBlock, imgBuketPath, pageIdx, pageSize) {
  if (!paraBlock) return null;

  const paraType = paraBlock.type;
  let paraContent = null;

  if ([BlockType.TEXT, BlockType.LIST, BlockType.INDEX].includes(paraType)) {
    paraContent = { type: ContentType.TEXT, text: mergeParaWithText(paraBlock) };

  } else if (paraType === BlockType.DISCARDED) {
    paraContent = { type: paraType, text: mergeParaWithText(paraBlock) };

  } else if (paraType === BlockType.TITLE) {
    paraContent = { type: ContentType.TEXT, text: mergeParaWithText(paraBlock) };
    const titleLevel = getTitleLevel(paraBlock);
    if (titleLevel !== 0) paraContent.text_level = titleLevel;

  } else if (paraType === BlockType.INTERLINE_EQUATION) {
    if (!paraBlock.lines?.length || !paraBlock.lines[0]?.spans?.length) return null;
    const span0 = paraBlock.lines[0].spans[0];
    paraContent = {
      type: ContentType.EQUATION,
      img_path: `${imgBuketPath}/${span0.image_path || ''}`,
    };
    if (span0.content) {
      paraContent.text = mergeParaWithText(paraBlock);
      paraContent.text_format = 'latex';
    }

  } else if (paraType === BlockType.IMAGE) {
    paraContent = {
      type: ContentType.IMAGE,
      img_path: '',
      [BlockType.IMAGE_CAPTION]: [],
      [BlockType.IMAGE_FOOTNOTE]: [],
    };
    for (const block of (paraBlock.blocks || [])) {
      if (block.type === BlockType.IMAGE_BODY) {
        for (const line of (block.lines || [])) {
          for (const span of (line.spans || [])) {
            if (span.type === ContentType.IMAGE && span.image_path) {
              paraContent.img_path = `${imgBuketPath}/${span.image_path}`;
            }
          }
        }
      }
      if (block.type === BlockType.IMAGE_CAPTION) {
        paraContent[BlockType.IMAGE_CAPTION].push(mergeParaWithText(block));
      }
      if (block.type === BlockType.IMAGE_FOOTNOTE) {
        paraContent[BlockType.IMAGE_FOOTNOTE].push(mergeParaWithText(block));
      }
    }

  } else if (paraType === BlockType.TABLE) {
    paraContent = {
      type: ContentType.TABLE,
      img_path: '',
      [BlockType.TABLE_CAPTION]: [],
      [BlockType.TABLE_FOOTNOTE]: [],
    };
    for (const block of (paraBlock.blocks || [])) {
      if (block.type === BlockType.TABLE_BODY) {
        for (const line of (block.lines || [])) {
          for (const span of (line.spans || [])) {
            if (span.type === ContentType.TABLE) {
              if (span.html) paraContent[BlockType.TABLE_BODY] = span.html;
              if (span.image_path) paraContent.img_path = `${imgBuketPath}/${span.image_path}`;
            }
          }
        }
      }
      if (block.type === BlockType.TABLE_CAPTION) {
        paraContent[BlockType.TABLE_CAPTION].push(mergeParaWithText(block));
      }
      if (block.type === BlockType.TABLE_FOOTNOTE) {
        paraContent[BlockType.TABLE_FOOTNOTE].push(mergeParaWithText(block));
      }
    }
  }

  if (!paraContent) return null;

  const paraBbox = paraBlock.bbox;
  if (paraBbox && pageSize) {
    const [pageWidth, pageHeight] = pageSize;
    if (pageWidth > 0 && pageHeight > 0) {
      const [x0, y0, x1, y1] = paraBbox;
      paraContent.bbox = [
        Math.floor(x0 * 1000 / pageWidth),
        Math.floor(y0 * 1000 / pageHeight),
        Math.floor(x1 * 1000 / pageWidth),
        Math.floor(y1 * 1000 / pageHeight),
      ];
    }
  }

  paraContent.page_idx = pageIdx;
  return paraContent;
}

/**
 * Convert processed pdf_info to markdown or content list.
 * @param {object[]} pdfInfoDict
 * @param {string} makeMode - MakeMode value
 * @param {string} [imgBuketPath='']
 * @returns {string|object[]|null}
 */
export function unionMake(pdfInfoDict, makeMode, imgBuketPath = '') {
  if (!pdfInfoDict || !pdfInfoDict.length) {
    if (makeMode === MakeMode.MM_MD || makeMode === MakeMode.NLP_MD) return '';
    if (makeMode === MakeMode.CONTENT_LIST) return [];
    return null;
  }

  const outputContent = [];

  for (const pageInfo of pdfInfoDict) {
    if (!pageInfo) continue;

    const parasOfLayout = pageInfo.para_blocks;
    const parasOfDiscarded = pageInfo.discarded_blocks;
    const pageIdx = pageInfo.page_idx;
    const pageSize = pageInfo.page_size;

    if (!parasOfLayout) continue;

    if (makeMode === MakeMode.MM_MD || makeMode === MakeMode.NLP_MD) {
      const pageMarkdown = makeBlocksToMarkdown(parasOfLayout, makeMode, imgBuketPath);
      outputContent.push(...pageMarkdown);

    } else if (makeMode === MakeMode.CONTENT_LIST) {
      const paraBlocks = [...(parasOfLayout || []), ...(parasOfDiscarded || [])];
      if (!paraBlocks.length) continue;

      for (const paraBlock of paraBlocks) {
        const paraContent = makeBlocksToContentList(paraBlock, imgBuketPath, pageIdx, pageSize);
        if (paraContent) outputContent.push(paraContent);
      }
    }
  }

  if (makeMode === MakeMode.MM_MD || makeMode === MakeMode.NLP_MD) {
    return outputContent.join('\n\n');
  } else if (makeMode === MakeMode.CONTENT_LIST) {
    return outputContent;
  }

  console.warn(`[unionMake] Unsupported make mode: ${makeMode}`);
  return null;
}
