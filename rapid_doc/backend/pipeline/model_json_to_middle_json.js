// Copyright (c) RapidAI. All rights reserved.
/**
 * PORTING NOTE: model_json_to_middle_json.py → model_json_to_middle_json.js
 *
 * WORKAROUND: tqdm progress loops → plain async for-of
 * REASON: No tqdm in browser
 * SOLUTION: async iteration with console.info progress logging
 *
 * AFFECTED METHODS: result_to_middle_json, page_model_info_to_page_info,
 *                   _post_process_ocr, make_page_info_dict
 */

import { AtomModelSingleton } from "./model_init.js";
import { AtomicModel } from "./model_list.js";
import { paraSplit } from "./para_split.js";
import { MagicModel } from "./pipeline_magic_model.js";
import { crossPageTableMerge } from "../utils.js";
import { getFormulaEnable } from "../../utils/config_reader.js";
import { ContentType } from "../../utils/enum_class.js";
import { prepareBlockBboxes, processGroups } from "../../utils/block_pre_proc.js";
import { sortBlocksByBbox } from "../../utils/block_sort.js";
import { cutImageAndTable } from "../../utils/cut_image.js";
import { bytesMd5 } from "../../utils/hash_utils.js";
import {
  removeOutsideSpans, removeOverlapsLowConfidenceSpans, removeOverlapsMinSpans,
  txtSpansExtract,
} from "../../utils/span_pre_proc.js";
import {
  fillSpansInBlocks, fixDiscardedBlock, fixBlockSpans,
} from "../../utils/span_block_fix.js";
import { saveTableFillImage } from "../../utils/pdf_image_tools.js";
import { OcrConfidence } from "../../utils/ocr_utils.js";
import { toMatBgr } from "../../utils/model_utils.js";
import { __version__ } from "../../version.js";

// ---------------------------------------------------------------------------
// Helpers for formula-text boundary deduplication
// ---------------------------------------------------------------------------

/** Extract first visible (non-command) character from LaTeX formula content. */
function _getFirstVisibleChar(latex) {
  if (!latex) return null;
  // Strip LaTeX commands, braces, sub/superscript markers, whitespace
  const cleaned = latex.replace(/\\[a-zA-Z]+/g, '').replace(/[{}_^$\s]/g, '');
  return cleaned.length > 0 ? cleaned[0] : null;
}

/** Extract last visible (non-command) character from LaTeX formula content. */
function _getLastVisibleChar(latex) {
  if (!latex) return null;
  const cleaned = latex.replace(/\\[a-zA-Z]+/g, '').replace(/[{}_^$\s]/g, '');
  return cleaned.length > 0 ? cleaned[cleaned.length - 1] : null;
}

// ---------------------------------------------------------------------------
// page_model_info_to_page_info
// ---------------------------------------------------------------------------

/**
 * Convert raw per-page model output to a page_info dict.
 * PORTING NOTE: page_model_info_to_page_info(...) → async pageModelInfoToPageInfo(...)
 *
 * @param {object} pageModelInfo
 * @param {object} imageDict - { scale, img_pil }
 * @param {object} pageDict
 * @param {object} imageWriter
 * @param {number} pageIndex
 * @param {object} [opts]
 * @param {boolean} [opts.ocr_enable=false]
 * @param {boolean} [opts.formula_enabled=true]
 * @param {object|null} [opts.image_config]
 * @param {boolean} [opts.use_vl_ocr=false]
 * @returns {Promise<object|null>}
 */
export async function pageModelInfoToPageInfo(
  pageModelInfo,
  imageDict,
  pageDict,
  imageWriter,
  pageIndex,
  {
    ocr_enable = false,
    formula_enabled = true,
    image_config = null,
    use_vl_ocr = false,
  } = {}
) {
  const scale = imageDict.scale;
  const pagePilImg = imageDict.img_pil;
  const pageImgMd5 = bytesMd5(pagePilImg);
  const [pageW, pageH] = (pageDict.size || [0, 0]).map(Number);

  const magicModel = new MagicModel(pageModelInfo, scale);

  const extractOriginalImage = image_config?.extract_original_image ?? false;
  const extractOriginalImageIouThresh = image_config?.extract_original_image_iou_thresh ?? 0.9;

  // Save table fill images
  saveTableFillImage(
    pageModelInfo.layout_dets,
    pageDict.table_fill_image_list || [],
    pageImgMd5, pageIndex, imageWriter
  );

  // Collect block groups
  const discardedBlocks = magicModel.getDiscarded();
  const textBlocks = magicModel.getTextBlocks();
  const titleBlocks = magicModel.getTitleBlocks();
  const [inlineEquations, interlineEquations, interlineEquationBlocks] = magicModel.getEquations();

  const imgGroups = magicModel.getImgs();
  const tableGroups = magicModel.getTables();

  const [imgBodyBlocks, imgCaptionBlocks, imgFootnoteBlocks, maybeTextImageBlocks] = processGroups(
    imgGroups, 'image_body', 'image_caption_list', 'image_footnote_list'
  );
  const [tableBodyBlocks, tableCaptionBlocks, tableFootnoteBlocks] = processGroups(
    tableGroups, 'table_body', 'table_caption_list', 'table_footnote_list'
  );

  let spans = magicModel.getAllSpans();
  const vlOcrSpans = use_vl_ocr ? magicModel.getVlOcrSpans() : [];

  // Maybe text image blocks → image body
  if (maybeTextImageBlocks?.length) {
    imgBodyBlocks.push(...maybeTextImageBlocks);
  }

  // Interline equations
  let interlineEqBlocksForBbox = formula_enabled ? [] : interlineEquationBlocks;
  if (interlineEqBlocksForBbox.length > 0) {
    for (const block of interlineEqBlocksForBbox) {
      spans.push({
        type: ContentType.INTERLINE_EQUATION,
        score: block.score,
        bbox: block.bbox,
        content: '',
      });
    }
  }

  // Prepare bboxes
  const eqBlocksParam = interlineEqBlocksForBbox.length > 0 ? interlineEqBlocksForBbox : interlineEquations;
  const [allBboxes, allDiscardedBlocks, footnoteBlocks] = prepareBlockBboxes(
    imgBodyBlocks, imgCaptionBlocks, imgFootnoteBlocks,
    tableBodyBlocks, tableCaptionBlocks, tableFootnoteBlocks,
    discardedBlocks, textBlocks, titleBlocks,
    eqBlocksParam, pageW, pageH
  );

  // Filter spans
  spans = removeOutsideSpans(spans, allBboxes, allDiscardedBlocks);
  [spans] = removeOverlapsLowConfidenceSpans(spans);
  // Python parity: remove_overlaps_min_spans is disabled in pipeline

  // Deduplicate OcrText spans that overlap with inline formula spans.
  // updateDetBoxes should split OCR text lines around formula bboxes,
  // but boundary characters can still leak through due to bbox imprecision.
  // This post-hoc step trims leaked chars by comparing with formula content.
  // For PDFs: clear text content so txtSpansExtract refills from PDF text layer.
  {
    const formulaSpans = spans.filter(s => s.type === ContentType.INLINE_EQUATION);
    if (formulaSpans.length > 0) {
      const textSpans = spans.filter(s => s.type === ContentType.TEXT && s.content);
      const spansToRemove = [];
      const spansToAdd = [];

      for (const textSpan of textSpans) {
        const [tx0, ty0, tx1, ty1] = textSpan.bbox;
        const textHeight = ty1 - ty0;
        const textWidth = tx1 - tx0;

        // Find formulas on the same line
        const sameLineFormulas = formulaSpans.filter(f => {
          const [, fy0, , fy1] = f.bbox;
          const verticalOverlap = Math.min(ty1, fy1) - Math.max(ty0, fy0);
          return verticalOverlap > textHeight * 0.5;
        });
        if (sameLineFormulas.length === 0) continue;

        if (!ocr_enable && pageDict.blocks) {
          // PDF mode: clear content, txtSpansExtract will refill from PDF text
          delete textSpan.content;
        } else if (textSpan.content) {
          // Image mode: split text content around formula regions
          // Sort formulas left-to-right by x0
          const sorted = [...sameLineFormulas].sort((a, b) => a.bbox[0] - b.bbox[0]);

          // Check if text span is a full-line span covering formulas
          const anyFormulaInside = sorted.some(f => f.bbox[0] >= tx0 - 2 && f.bbox[2] <= tx1 + 2);
          if (!anyFormulaInside) continue;

          // Build gap regions with references to adjacent formulas
          const gapInfos = [];
          let cursor = tx0;
          for (let fi = 0; fi < sorted.length; fi++) {
            const [fx0, , fx1] = sorted[fi].bbox;
            if (fx0 > cursor + 1) {
              gapInfos.push({
                gx0: cursor, gx1: fx0,
                leftFormula: fi > 0 ? sorted[fi - 1] : null,
                rightFormula: sorted[fi],
              });
            }
            cursor = Math.max(cursor, fx1);
          }
          if (cursor < tx1 - 1) {
            gapInfos.push({
              gx0: cursor, gx1: tx1,
              leftFormula: sorted[sorted.length - 1],
              rightFormula: null,
            });
          }

          // Estimate character positions from bbox proportions.
          const content = textSpan.content;
          const charWidth = textWidth > 0 ? content.length / textWidth : 0;

          const subSpans = [];
          for (const gap of gapInfos) {
            if (gap.gx1 - gap.gx0 < 10) continue;
            const startChar = Math.floor((gap.gx0 - tx0) * charWidth);
            const endChar = Math.ceil((gap.gx1 - tx0) * charWidth);
            let sub = content.slice(
              Math.max(0, startChar),
              Math.min(content.length, endChar)
            ).trim();
            if (!sub) continue;

            // Trim boundary chars that leaked from adjacent formulas.
            // Compare text boundary with formula's first/last visible char.
            if (gap.rightFormula?.content) {
              const fc = _getFirstVisibleChar(gap.rightFormula.content);
              if (fc && sub.endsWith(fc)) {
                const prefix = sub.slice(0, -fc.length);
                if (!prefix || prefix.endsWith(' ')) sub = prefix.trimEnd();
              }
            }
            if (gap.leftFormula?.content) {
              const lc = _getLastVisibleChar(gap.leftFormula.content);
              if (lc && sub.startsWith(lc)) {
                const suffix = sub.slice(lc.length);
                if (!suffix || suffix.startsWith(' ')) sub = suffix.trimStart();
              }
            }
            if (!sub) continue;

            subSpans.push({
              bbox: [gap.gx0, ty0, gap.gx1, ty1],
              score: textSpan.score,
              original_label: textSpan.original_label,
              original_order: textSpan.original_order,
              polygon_points: textSpan.polygon_points,
              content: sub,
              type: ContentType.TEXT,
            });
          }

          if (subSpans.length > 0) {
            spansToRemove.push(textSpan);
            spansToAdd.push(...subSpans);
          }
        }
      }

      // Apply removals and additions
      if (spansToRemove.length > 0 || spansToAdd.length > 0) {
        spans = spans.filter(s => !spansToRemove.includes(s));
        spans.push(...spansToAdd);
      }
    }
  }

  // Assign spans by mode
  if (use_vl_ocr) {
    spans = processVlOcrSpans(spans, vlOcrSpans, allBboxes, allDiscardedBlocks);
  } else if (!ocr_enable) {
    const textSpansBefore = spans.filter(s => s.type === ContentType.TEXT);
    const textSpansWithContent = textSpansBefore.filter(s => s.content);
    const textSpansWithoutContent = textSpansBefore.filter(s => !s.content);
    console.log(`[BEFORE txtSpansExtract] ocr_enable=${ocr_enable}, use_vl_ocr=${use_vl_ocr}, TEXT spans: ${textSpansBefore.length} (${textSpansWithContent.length} with content, ${textSpansWithoutContent.length} without)`);
    
    spans = await txtSpansExtract(pageDict, spans, pagePilImg, scale, allBboxes, allDiscardedBlocks);
    
    const textSpansAfter = spans.filter(s => s.type === ContentType.TEXT);
    const textSpansWithContentAfter = textSpansAfter.filter(s => s.content);
    console.log(`[AFTER txtSpansExtract] TEXT spans: ${textSpansAfter.length} (${textSpansWithContentAfter.length} with content)`);
  } else {
    console.log(`[SKIPPING txtSpansExtract] ocr_enable=${ocr_enable}, use_vl_ocr=${use_vl_ocr}`);
  }

  // Discarded blocks
  const [discardedBlockWithSpans, spansAfterDiscard] = fillSpansInBlocks(allDiscardedBlocks, spans, 0.4);
  const fixDiscardedBlocks = fixDiscardedBlock(discardedBlockWithSpans);
  spans = spansAfterDiscard;

  if (allBboxes.length === 0 && fixDiscardedBlocks.length === 0) return null;

  // Normalise page image to BGR cv.Mat for cutImageAndTable
  const { mat: pageMat, owned: matOwned } = toMatBgr(pagePilImg);

  try {
    // Cut images / tables / interline equations
    for (const span of spans) {
      if ([ContentType.IMAGE, ContentType.TABLE, ContentType.INTERLINE_EQUATION].includes(span.type)) {
        await cutImageAndTable(
          span, pageDict.ori_image_list || [],
          extractOriginalImage, extractOriginalImageIouThresh,
          pageMat, pageImgMd5, pageIndex, imageWriter, scale
        );
      }
    }
  } finally {
    if (matOwned) pageMat.delete();
  }

  // Fill spans into blocks
  const [blockWithSpans, remainingSpans] = fillSpansInBlocks(allBboxes, spans, 0.5);
  console.info(`[pageModelInfoToPageInfo] fillSpansInBlocks: ${blockWithSpans.length} blocks, ${blockWithSpans.filter(b => b.type === 'text' && b.spans.length === 0).length} empty text blocks`);
  const fixBlocks = fixBlockSpans(blockWithSpans);

  const sortedBlocks = await sortBlocksByBbox(fixBlocks, pageW, pageH, footnoteBlocks, pagePilImg);

  return makePageInfoDict(sortedBlocks, pageIndex, pageW, pageH, fixDiscardedBlocks);
}

// ---------------------------------------------------------------------------
// _process_vl_ocr_spans
// ---------------------------------------------------------------------------

function processVlOcrSpans(spans, vlOcrSpans, allBboxes, allDiscardedBlocks) {
  for (const vlSpan of vlOcrSpans) {
    vlSpan.score = vlSpan.score ?? 0.95;
    vlSpan.type = ContentType.TEXT;
    spans.push(vlSpan);
  }
  return spans;
}

// ---------------------------------------------------------------------------
// result_to_middle_json
// ---------------------------------------------------------------------------

/**
 * Convert all model outputs to an intermediate JSON.
 * PORTING NOTE: result_to_middle_json(...) → async resultToMiddleJson(...)
 *
 * @param {object[]} modelList
 * @param {object[]} imagesList
 * @param {object[]} pageDictList
 * @param {object} imageWriter
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function resultToMiddleJson(
  modelList,
  imagesList,
  pageDictList,
  imageWriter,
  {
    lang = null,
    ocr_enable = false,
    formula_enabled = true,
    ocr_config = null,
    image_config = null,
  } = {}
) {
  const middleJson = {
    pdf_info: [],
    _backend: "pipeline",
    _version_name: __version__,
  };

  formula_enabled = getFormulaEnable(formula_enabled);

  // Determine VL OCR mode
  const atomModelManager = AtomModelSingleton.getInstance();
  const ocrModel = await atomModelManager.getAtomModel(AtomicModel.OCR, {
    det_db_box_thresh: 0.3,
    lang,
    ocr_config,
  });
  const useVlOcr = typeof ocrModel.batchPredict === "function" &&
                   !("ocr" in ocrModel);  // CustomBaseModel heuristic

  for (let pageIndex = 0; pageIndex < modelList.length; pageIndex++) {
    if (pageIndex % 10 === 0) {
      console.info(`[resultToMiddleJson] Processing page ${pageIndex + 1}/${modelList.length}…`);
    }

    const pageModelInfo = modelList[pageIndex];
    const pageDict = pageDictList[pageIndex];
    const imageDict = imagesList[pageIndex];

    let pageInfo = await pageModelInfoToPageInfo(
      pageModelInfo, imageDict, pageDict, imageWriter, pageIndex,
      { ocr_enable, formula_enabled, image_config, use_vl_ocr: useVlOcr }
    );

    if (pageInfo === null) {
      const [pageW, pageH] = (pageDict.size || [0, 0]).map(Number);
      pageInfo = makePageInfoDict([], pageIndex, pageW, pageH, []);
    }

    middleJson.pdf_info.push(pageInfo);
  }

  // Post-process OCR (non-VL mode)
  if (!useVlOcr) {
    console.info('[resultToMiddleJson] Running postProcessOcr...');
    await postProcessOcr(middleJson, lang, ocr_config);
  }

  // Paragraph split
  console.info('[resultToMiddleJson] Running paraSplit...');
  paraSplit(middleJson.pdf_info);

  // Cross-page table merge
  console.info('[resultToMiddleJson] Running crossPageTableMerge...');
  crossPageTableMerge(middleJson.pdf_info);

  console.info('[resultToMiddleJson] Done.');
  return middleJson;
}

// ---------------------------------------------------------------------------
// _post_process_ocr
// ---------------------------------------------------------------------------

async function postProcessOcr(middleJson, lang, ocrConfig) {
  const needOcrList = [];
  const imgCropList = [];

  const textBlockList = [];
  for (const pageInfo of middleJson.pdf_info) {
    for (const block of (pageInfo.preproc_blocks || [])) {
      if (['table', 'image'].includes(block.type)) {
        for (const subBlock of (block.blocks || [])) {
          if (['image_caption', 'image_footnote', 'table_caption', 'table_footnote'].includes(subBlock.type)) {
            textBlockList.push(subBlock);
          }
        }
      } else if (['text', 'title'].includes(block.type)) {
        textBlockList.push(block);
      }
    }
    for (const block of (pageInfo.discarded_blocks || [])) {
      textBlockList.push(block);
    }
  }

  for (const block of textBlockList) {
    for (const line of (block.lines || [])) {
      for (const span of (line.spans || [])) {
        if (span.np_img != null) {
          needOcrList.push(span);
          imgCropList.push(span.np_img);
          delete span.np_img;
        }
      }
    }
  }

  if (!imgCropList.length) return;

  const atomModelManager = AtomModelSingleton.getInstance();
  const ocrModel = await atomModelManager.getAtomModel(AtomicModel.OCR, {
    det_db_box_thresh: 0.3,
    lang,
    ocr_config: ocrConfig,
  });

  const [ocrResList] = await ocrModel.ocr(imgCropList, { det: false });

  for (let i = 0; i < needOcrList.length; i++) {
    const span = needOcrList[i];
    const [ocrText, ocrScore] = ocrResList[i] || ['', 0];
    if (ocrScore > OcrConfidence.min_confidence) {
      span.content = ocrText;
      span.score = parseFloat(ocrScore.toFixed(3));
    } else {
      span.content = '';
      span.score = 0.0;
    }
  }
}

// ---------------------------------------------------------------------------
// make_page_info_dict
// ---------------------------------------------------------------------------

/**
 * Construct a page_info dict.
 * PORTING NOTE: make_page_info_dict(blocks, page_id, page_w, page_h, discarded_blocks)
 * @param {object[]} blocks
 * @param {number} pageId
 * @param {number} pageW
 * @param {number} pageH
 * @param {object[]} discardedBlocks
 * @returns {object}
 */
export function makePageInfoDict(blocks, pageId, pageW, pageH, discardedBlocks) {
  return {
    preproc_blocks: blocks,
    page_idx: pageId,
    page_size: [pageW, pageH],
    discarded_blocks: discardedBlocks,
  };
}
