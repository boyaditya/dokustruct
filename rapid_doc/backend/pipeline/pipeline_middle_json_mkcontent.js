// Copyright (c) RapidAI. All rights reserved.
// PORTING NOTE: pipeline_middle_json_mkcontent.py → pipeline_middle_json_mkcontent.js
// No async required — pure text / data transformation.

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
  display: { left: '$$', right: '$$' },
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
 * PORTING NOTE: __is_hyphen_at_line_end(line)
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
  let titleLevel = block.level ?? 1;
  if (titleLevel > 4) titleLevel = 4;
  else if (titleLevel < 1) titleLevel = 0;
  return titleLevel;
}

// ---------------------------------------------------------------------------
// merge_para_with_text
// ---------------------------------------------------------------------------

/**
 * Merge a paragraph block into a markdown text string.
 * PORTING NOTE: merge_para_with_text(para_block) → mergeParaWithText(paraBlock)
 * @param {object} paraBlock
 * @returns {string}
 */
export function mergeParaWithText(paraBlock) {
  let blockText = '';
  for (const line of (paraBlock.lines || [])) {
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
  const lines = paraBlock.lines || [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (i >= 1 && line[ListLineTag.IS_LIST_START_LINE]) {
      paraText += '  \n';
    }

    const spans = line.spans || [];
    
    // Check if line has formulas - if so, skip text spans that duplicate formula content
    const formulaSpans = spans.filter(s => s.type === ContentType.INLINE_EQUATION);
    const hasFormulas = formulaSpans.length > 0;
    
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

// ---------------------------------------------------------------------------
// make_blocks_to_markdown
// ---------------------------------------------------------------------------

/**
 * Convert layout paragraph blocks to markdown strings.
 * PORTING NOTE: make_blocks_to_markdown(paras_of_layout, mode, img_buket_path) 1-to-1
 * @param {object[]} parasOfLayout
 * @param {string} mode - MakeMode value
 * @param {string} [imgBuketPath='']
 * @returns {string[]}
 */
export function makeBlocksToMarkdown(parasOfLayout, mode, imgBuketPath = '') {
  const pageMarkdown = [];

  for (const paraBlock of parasOfLayout) {
    let paraText = '';
    const paraType = paraBlock.type;

    if ([BlockType.TEXT, BlockType.LIST, BlockType.INDEX].includes(paraType)) {
      paraText = mergeParaWithText(paraBlock);

    } else if (paraType === BlockType.TITLE) {
      const titleLevel = getTitleLevel(paraBlock);
      paraText = `${'#'.repeat(titleLevel)} ${mergeParaWithText(paraBlock)}`;
      paraText = paraText.replace(/-\n/g, '').replace(/\n/g, ' ');

    } else if (paraType === BlockType.INTERLINE_EQUATION) {
      if (!paraBlock.lines?.length || !paraBlock.lines[0].spans?.length) continue;
      const span0 = paraBlock.lines[0].spans[0];
      if (span0.content) {
        paraText = mergeParaWithText(paraBlock);
      } else {
        paraText += `![](${ imgBuketPath}/${span0.image_path || ''})`;
      }

    } else if (paraType === BlockType.IMAGE) {
      if (mode === MakeMode.NLP_MD) continue;
      if (mode === MakeMode.MM_MD) {
        const hasFootnote = (paraBlock.blocks || []).some(b => b.type === BlockType.IMAGE_FOOTNOTE);
        if (hasFootnote) {
          for (const block of (paraBlock.blocks || [])) {
            if (block.type === BlockType.IMAGE_CAPTION) paraText += mergeParaWithText(block) + '  \n';
          }
          for (const block of (paraBlock.blocks || [])) {
            if (block.type === BlockType.IMAGE_BODY) {
              for (const line of (block.lines || [])) {
                for (const span of (line.spans || [])) {
                  if (span.type === ContentType.IMAGE && span.image_path) {
                    paraText += `![](${imgBuketPath}/${span.image_path})`;
                  }
                }
              }
            }
          }
          for (const block of (paraBlock.blocks || [])) {
            if (block.type === BlockType.IMAGE_FOOTNOTE) paraText += '  \n' + mergeParaWithText(block);
          }
        } else {
          for (const block of (paraBlock.blocks || [])) {
            if (block.type === BlockType.IMAGE_BODY) {
              for (const line of (block.lines || [])) {
                for (const span of (line.spans || [])) {
                  if (span.type === ContentType.IMAGE && span.image_path) {
                    paraText += `![](${imgBuketPath}/${span.image_path})`;
                  }
                }
              }
            }
          }
          for (const block of (paraBlock.blocks || [])) {
            if (block.type === BlockType.IMAGE_CAPTION) paraText += '  \n' + mergeParaWithText(block);
          }
        }
      }

    } else if (paraType === BlockType.TABLE) {
      if (mode === MakeMode.NLP_MD) continue;
      if (mode === MakeMode.MM_MD) {
        for (const block of (paraBlock.blocks || [])) {
          if (block.type === BlockType.TABLE_CAPTION) paraText += mergeParaWithText(block) + '  \n';
        }
        for (const block of (paraBlock.blocks || [])) {
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
        for (const block of (paraBlock.blocks || [])) {
          if (block.type === BlockType.TABLE_FOOTNOTE) paraText += '\n' + mergeParaWithText(block) + '  ';
        }
      }
    }

    if (paraText.trim() === '') continue;
    pageMarkdown.push(paraText.trim());
  }

  return pageMarkdown;
}

// ---------------------------------------------------------------------------
// make_blocks_to_content_list
// ---------------------------------------------------------------------------

/**
 * Convert a paragraph block to a content-list item.
 * PORTING NOTE: make_blocks_to_content_list(para_block, img_buket_path, page_idx, page_size)
 * @param {object} paraBlock
 * @param {string} imgBuketPath
 * @param {number} pageIdx
 * @param {number[]} pageSize
 * @returns {object|null}
 */
export function makeBlocksToContentList(paraBlock, imgBuketPath, pageIdx, pageSize) {
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
    if (!paraBlock.lines?.length || !paraBlock.lines[0].spans?.length) return null;
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

  const [pageWidth, pageHeight] = pageSize;
  const paraBbox = paraBlock.bbox;
  if (paraBbox) {
    const [x0, y0, x1, y1] = paraBbox;
    paraContent.bbox = [
      Math.floor(x0 * 1000 / pageWidth),
      Math.floor(y0 * 1000 / pageHeight),
      Math.floor(x1 * 1000 / pageWidth),
      Math.floor(y1 * 1000 / pageHeight),
    ];
  }

  paraContent.page_idx = pageIdx;
  return paraContent;
}

// ---------------------------------------------------------------------------
// union_make
// ---------------------------------------------------------------------------

/**
 * Convert processed pdf_info to markdown or content list.
 * PORTING NOTE: union_make(pdf_info_dict, make_mode, img_buket_path) → unionMake(...)
 * @param {object[]} pdfInfoDict
 * @param {string} makeMode - MakeMode value
 * @param {string} [imgBuketPath='']
 * @returns {string|object[]|null}
 */
export function unionMake(pdfInfoDict, makeMode, imgBuketPath = '') {
  const outputContent = [];

  for (const pageInfo of pdfInfoDict) {
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
  } else {
    console.error(`[unionMake] Unsupported make mode: ${makeMode}`);
    return null;
  }
}
