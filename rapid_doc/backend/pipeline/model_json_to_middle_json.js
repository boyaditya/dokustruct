// Copyright (c) RapidAI. All rights reserved.

import { AtomModelSingleton } from "./model_init.js";
import { AtomicModel } from "./model_list.js";
import { paraSplit } from "./para_split.js";
import { MagicModel } from "./pipeline_magic_model.js";
import { crossPageTableMerge } from "../utils/utils.js";
import { getDevice, getFormulaEnable } from "../../utils/config_reader.js";
import { ContentType } from "../../utils/enum_class.js";
import { AbortException } from "../../utils/exceptions.js";
import { prepareBlockBboxes, processGroups } from "../../utils/block_pre_proc.js";
import { sortBlocksByBbox, configureReadingOrder } from "../../utils/block_sort.js";
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
import { cleanMemory, toMatBgr } from "../../utils/model_utils.js";
import { deleteMat } from "../../utils/resource_utils.js";
import { formatPipelineError } from "../../utils/browser_utils.js";
import { __version__ } from "../../version.js";
import { getLayoutParsingRes } from "../../model/reading_order/layout_parsing/xycut_plus_v3.js";
import { xycutPlusSort } from "../../model/reading_order/xycut_plus.js";
import { blocktype_to_sort_label } from "../../model/reading_order/layout_parsing/setting.js";

// Configure reading order providers for block_sort utility
configureReadingOrder({ getLayoutParsingRes, xycutPlusSort, blocktype_to_sort_label });

// ---------------------------------------------------------------------------
// pageModelInfoToPageInfo
// ---------------------------------------------------------------------------

/**
 * Convert raw per-page model output to a page_info dict.
 * @param {object} pageModelInfo
 * @param {object} imageDict - { scale, img_pil }
 * @param {object} pageDict
 * @param {object} imageWriter
 * @param {number} pageIndex
 * @param {object} [opts]
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
  if (!pageModelInfo || !imageDict) return null;

  const scale = imageDict.scale;
  const pagePilImg = imageDict.img_pil;
  const pageImgMd5 = bytesMd5(pagePilImg);
  const [pageW, pageH] = (pageDict?.size || [0, 0]).map(Number);

  const magicModel = new MagicModel(pageModelInfo, scale);

  const extractOriginalImage = image_config?.extract_original_image ?? false;
  const extractOriginalImageIouThresh = image_config?.extract_original_image_iou_thresh ?? 0.9;

  await saveTableFillImage(
    pageModelInfo.layout_dets,
    pageDict?.table_fill_image_list || [],
    pageImgMd5, pageIndex, imageWriter
  );

  const discardedBlocks = magicModel.getDiscarded();
  const textBlocks = magicModel.getTextBlocks();
  const titleBlocks = magicModel.getTitleBlocks();
  const [, interlineEquations, interlineEquationBlocks] = magicModel.getEquations();

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

  if (maybeTextImageBlocks?.length) {
    imgBodyBlocks.push(...maybeTextImageBlocks);
  }

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

  const eqBlocksParam = interlineEqBlocksForBbox.length > 0 ? interlineEqBlocksForBbox : interlineEquations;
  const [allBboxes, allDiscardedBlocks, footnoteBlocks] = prepareBlockBboxes(
    imgBodyBlocks, imgCaptionBlocks, imgFootnoteBlocks,
    tableBodyBlocks, tableCaptionBlocks, tableFootnoteBlocks,
    discardedBlocks, textBlocks, titleBlocks,
    eqBlocksParam, pageW, pageH
  );

  spans = removeOutsideSpans(spans, allBboxes, allDiscardedBlocks);
  [spans] = removeOverlapsLowConfidenceSpans(spans);
  [spans] = removeOverlapsMinSpans(spans);

  if (use_vl_ocr) {
    spans = processVlOcrSpans(spans, vlOcrSpans);
  } else if (!ocr_enable) {
    spans = await txtSpansExtract(pageDict, spans, pagePilImg, scale, allBboxes, allDiscardedBlocks);
  }

  const [discardedBlockWithSpans, spansAfterDiscard] = fillSpansInBlocks(allDiscardedBlocks, spans, 0.4);
  const fixDiscardedBlocks = fixDiscardedBlock(discardedBlockWithSpans);
  spans = spansAfterDiscard;

  if (allBboxes.length === 0 && fixDiscardedBlocks.length === 0) return null;

  const { mat: pageMat, owned: matOwned } = toMatBgr(pagePilImg);

  try {
    for (const span of spans) {
      if ([ContentType.IMAGE, ContentType.TABLE, ContentType.INTERLINE_EQUATION].includes(span.type)) {
        await cutImageAndTable(
          span, pageDict?.ori_image_list || [],
          extractOriginalImage, extractOriginalImageIouThresh,
          pageMat, pageImgMd5, pageIndex, imageWriter, scale
        );
      }
    }
  } finally {
    if (matOwned) pageMat.delete();
  }

  const [blockWithSpans] = fillSpansInBlocks(allBboxes, spans, 0.5);
  const fixBlocks = fixBlockSpans(blockWithSpans);

  const sortedBlocks = await sortBlocksByBbox(fixBlocks, pageW, pageH, footnoteBlocks, pagePilImg);

  return makePageInfoDict(sortedBlocks, pageIndex, pageW, pageH, fixDiscardedBlocks);
}

// ---------------------------------------------------------------------------
// processVlOcrSpans
// ---------------------------------------------------------------------------

function processVlOcrSpans(spans, vlOcrSpans) {
  for (const vlSpan of vlOcrSpans) {
    vlSpan.score = vlSpan.score ?? 0.95;
    vlSpan.type = ContentType.TEXT;
    spans.push(vlSpan);
  }
  return spans;
}

// ---------------------------------------------------------------------------
// resultToMiddleJson
// ---------------------------------------------------------------------------

/**
 * Convert all model outputs to an intermediate JSON.
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
    batch_idx = 0,
    pdf_pages_batch = 0,
    /** Skip paraSplit + crossPageTableMerge — used by windowed pipeline
     *  which defers these cross-page operations until all windows complete. */
    skipGlobalPost = false,
    /** Skip only crossPageTableMerge. paraSplit runs per-window
     *  so unionMake can produce streaming markdown immediately. */
    skipCrossPageMerge = false,
  } = {}
) {
  if (!modelList || !modelList.length) {
    return { pdf_info: [], _backend: "pipeline", _version_name: __version__ };
  }

  const middleJson = {
    pdf_info: [],
    _backend: "pipeline",
    _version_name: __version__,
  };

  formula_enabled = getFormulaEnable(formula_enabled);

  const atomModelManager = AtomModelSingleton.getInstance();
  const ocrModel = await atomModelManager.getAtomModel(AtomicModel.OCR, {
    det_db_box_thresh: 0.3,
    lang,
    ocr_config,
  });
  const useVlOcr = typeof ocrModel.batchPredict === "function" &&
                   !("ocr" in ocrModel);

  for (let pageIndex = 0; pageIndex < modelList.length; pageIndex++) {
    const pageModelInfo = modelList[pageIndex];
    const pageDict = pageDictList?.[pageIndex];
    const imageDict = imagesList?.[pageIndex];
    const pageId = pageIndex + (batch_idx * pdf_pages_batch);

    try {
      let pageInfo = await pageModelInfoToPageInfo(
        pageModelInfo, imageDict, pageDict, imageWriter, pageId,
        { ocr_enable, formula_enabled, image_config, use_vl_ocr: useVlOcr }
      );

      if (pageInfo == null) {
        const [pageW, pageH] = (pageDict?.size || [0, 0]).map(Number);
        pageInfo = makePageInfoDict([], pageId, pageW, pageH, []);
      }

      middleJson.pdf_info.push(pageInfo);
    } catch (err) {
      if (err instanceof AbortException) throw err;
      console.warn(formatPipelineError({
        stage: 'middleJson',
        module: 'resultToMiddleJson',
        message: err.message,
        pageIndex: pageId,
        recoverable: true,
      }));
      const [pageW, pageH] = (pageDict?.size || [0, 0]).map(Number);
      middleJson.pdf_info.push(makePageInfoDict([], pageId, pageW, pageH, []));
    }
  }

  if (!useVlOcr) {
    await postProcessOcr(middleJson, lang, ocr_config);
  }

  // paraSplit must always run per-window — it arranges blocks within pages
  // so unionMake produces readable markdown immediately for streaming UX.
  paraSplit(middleJson.pdf_info);

  if (!skipGlobalPost && !skipCrossPageMerge) {
    crossPageTableMerge(middleJson.pdf_info);
  }

  if (modelList.length >= 10) {
    // Awaited so transient WebGPU work has chance to flush before the next
    // batch in a multi-batch run begins. Use { releaseGpu: false } to keep
    // warm sessions alive — full reset is engineReset()'s job.
    await cleanMemory(getDevice(), { releaseGpu: false });
  }

  return middleJson;
}

// ---------------------------------------------------------------------------
// postProcessOcr
// ---------------------------------------------------------------------------

async function postProcessOcr(middleJson, lang, ocrConfig) {
  if (!middleJson?.pdf_info?.length) return;

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

  let ocrResList = [];
  try {
    [ocrResList] = await ocrModel.ocr(imgCropList, { det: false });
  } finally {
    for (const img of imgCropList) deleteMat(img);
  }

  if (ocrResList.length !== needOcrList.length) {
    throw new Error(
      `ocrResList: ${ocrResList.length}, needOcrList: ${needOcrList.length}`
    );
  }

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
// makePageInfoDict
// ---------------------------------------------------------------------------

/**
 * Construct a page_info dict.
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
