// Copyright (c) RapidAI. All rights reserved.
/**
 * PORTING NOTE: pipeline_magic_model.py → pipeline_magic_model.js
 *
 * WORKAROUND: Python class with private name-mangled methods (__fix_axis, etc.)
 * SOLUTION: JS private fields & methods using # prefix or closure pattern.
 * All logic ported 1-to-1 using JS object manipulation.
 *
 * AFFECTED METHODS: All — ported directly, no async required (pure data transform)
 */

import {
  bboxRelativePos, calculateIou, bboxDistance, getMinboxIfOverlapByRatio,
} from "../../utils/boxbase.js";
import { CategoryId, ContentType } from "../../utils/enum_class.js";
import {
  tieUpCategoryByDistanceV3, reductOverlap,
} from "../../utils/magic_model_utils.js";

/**
 * Page model info processor.
 * PORTING NOTE: MagicModel(page_model_info, scale) constructor
 */
export class MagicModel {
  static LOW_CONFIDENCE_THRESHOLD = 0.05;
  static HIGH_IOU_THRESHOLD = 0.9;

  /**
   * @param {object} pageModelInfo - Raw model output with layout_dets
   * @param {number} scale - Page image scale factor
   */
  constructor(pageModelInfo, scale) {
    this._pageModelInfo = pageModelInfo;
    this._scale = scale;

    this._fixAxis();
    this._fixByRemoveLowConfidence();
    this._fixByRemoveHighIouAndLowConfidence();
    this._fixFootnote();
    this._fixByRemoveOverlapImageTableBody();
  }

  // ---------------------------------------------------------------------------
  // Private preprocessing
  // ---------------------------------------------------------------------------

  _fixAxis() {
    const needRemoveList = [];
    const layoutDets = this._pageModelInfo.layout_dets;
    const scale = this._scale;

    for (const layoutDet of layoutDets) {
      const [x0, y0, , , x1, y1] = layoutDet.poly;
      const bbox = [
        Math.round(x0 / scale * 100) / 100,
        Math.round(y0 / scale * 100) / 100,
        Math.round(x1 / scale * 100) / 100,
        Math.round(y1 / scale * 100) / 100,
      ];
      layoutDet.bbox = bbox;

      const polygonPoints = layoutDet.polygon_points;
      if (polygonPoints && polygonPoints.length >= 3) {
        layoutDet.polygon_points = polygonPoints.map(([x, y]) => [
          Math.round(x / scale * 100) / 100,
          Math.round(y / scale * 100) / 100,
        ]);
      }

      if (bbox[2] - bbox[0] <= 0 || bbox[3] - bbox[1] <= 0) {
        needRemoveList.push(layoutDet);
      }
    }

    for (const item of needRemoveList) {
      const idx = layoutDets.indexOf(item);
      if (idx !== -1) layoutDets.splice(idx, 1);
    }
  }

  _fixByRemoveLowConfidence() {
    const layoutDets = this._pageModelInfo.layout_dets;
    const toRemove = layoutDets.filter(d => d.score <= MagicModel.LOW_CONFIDENCE_THRESHOLD);
    for (const item of toRemove) {
      const idx = layoutDets.indexOf(item);
      if (idx !== -1) layoutDets.splice(idx, 1);
    }
  }

  _fixByRemoveHighIouAndLowConfidence() {
    const needRemoveList = [];
    const relevantCategories = new Set([
      CategoryId.Title, CategoryId.Text, CategoryId.ImageBody,
      CategoryId.ImageCaption, CategoryId.TableBody, CategoryId.TableCaption,
      CategoryId.TableFootnote, CategoryId.InterlineEquation_Layout,
      CategoryId.InterlineEquationNumber_Layout,
    ]);

    const layoutDets = this._pageModelInfo.layout_dets.filter(
      x => relevantCategories.has(x.category_id)
    );

    for (let i = 0; i < layoutDets.length; i++) {
      for (let j = i + 1; j < layoutDets.length; j++) {
        const det1 = layoutDets[i];
        const det2 = layoutDets[j];
        if (calculateIou(det1.bbox, det2.bbox) > MagicModel.HIGH_IOU_THRESHOLD) {
          const detToRemove = det1.score < det2.score ? det1 : det2;
          if (!needRemoveList.includes(detToRemove)) {
            needRemoveList.push(detToRemove);
          }
        }
      }
    }

    const allDets = this._pageModelInfo.layout_dets;
    for (const item of needRemoveList) {
      const idx = allDets.indexOf(item);
      if (idx !== -1) allDets.splice(idx, 1);
    }
  }

  _fixFootnote() {
    const objs = this._pageModelInfo.layout_dets;
    const footnotes = objs.filter(o => o.category_id === CategoryId.TableFootnote);
    const figures = objs.filter(o => o.category_id === CategoryId.ImageBody);
    const tables = objs.filter(o => o.category_id === CategoryId.TableBody);

    if (!footnotes.length || !figures.length) return;

    const disFigureFootnote = {};
    const disTableFootnote = {};

    for (let i = 0; i < footnotes.length; i++) {
      const footnote = footnotes[i];

      for (const figure of figures) {
        const posFlagCount = bboxRelativePos(footnote.bbox, figure.bbox).filter(Boolean).length;
        if (posFlagCount > 1) continue;
        const d = this._bboxDistance(figure.bbox, footnote.bbox);
        disFigureFootnote[i] = Math.min(d, disFigureFootnote[i] ?? Infinity);
      }

      for (const table of tables) {
        const posFlagCount = bboxRelativePos(footnote.bbox, table.bbox).filter(Boolean).length;
        if (posFlagCount > 1) continue;
        const d = this._bboxDistance(table.bbox, footnote.bbox);
        disTableFootnote[i] = Math.min(d, disTableFootnote[i] ?? Infinity);
      }
    }

    for (let i = 0; i < footnotes.length; i++) {
      if (i in disFigureFootnote) {
        if ((disTableFootnote[i] ?? Infinity) > disFigureFootnote[i]) {
          footnotes[i].category_id = CategoryId.ImageFootnote;
        }
      }
    }
  }

  _fixByRemoveOverlapImageTableBody() {
    const needRemoveList = [];
    const layoutDets = this._pageModelInfo.layout_dets;
    const imageBlocks = layoutDets.filter(x => x.category_id === CategoryId.ImageBody);
    const tableBlocks = layoutDets.filter(x => x.category_id === CategoryId.TableBody);

    const processOverlappingBlocks = (blocks) => {
      for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
          const b1 = blocks[i];
          const b2 = blocks[j];
          const overlapBox = getMinboxIfOverlapByRatio(b1.bbox, b2.bbox, 0.8);
          if (overlapBox !== null) {
            const area1 = (b1.bbox[2] - b1.bbox[0]) * (b1.bbox[3] - b1.bbox[1]);
            const area2 = (b2.bbox[2] - b2.bbox[0]) * (b2.bbox[3] - b2.bbox[1]);
            const [smallBlock, largeBlock] = area1 <= area2 ? [b1, b2] : [b2, b1];

            if (!needRemoveList.includes(smallBlock)) {
              const [x1, y1, x2, y2] = largeBlock.bbox;
              const [sx1, sy1, sx2, sy2] = smallBlock.bbox;
              largeBlock.bbox = [
                Math.min(x1, sx1), Math.min(y1, sy1),
                Math.max(x2, sx2), Math.max(y2, sy2),
              ];
              needRemoveList.push(smallBlock);
            }
          }
        }
      }
    };

    processOverlappingBlocks(imageBlocks);
    processOverlappingBlocks(tableBlocks);

    for (const item of needRemoveList) {
      const idx = layoutDets.indexOf(item);
      if (idx !== -1) layoutDets.splice(idx, 1);
    }
  }

  _bboxDistance(bbox1, bbox2) {
    const [left, right, bottom, top] = bboxRelativePos(bbox1, bbox2);
    const flags = [left, right, bottom, top];
    const count = flags.filter(Boolean).length;
    if (count > 1) return Infinity;

    let l1, l2;
    if (left || right) {
      l1 = bbox1[3] - bbox1[1];
      l2 = bbox2[3] - bbox2[1];
    } else {
      l1 = bbox1[2] - bbox1[0];
      l2 = bbox2[2] - bbox2[0];
    }
    if (l2 > l1 && (l2 - l1) / l1 > 0.3) return Infinity;
    return bboxDistance(bbox1, bbox2);
  }

  _tieUpCategoryByDistanceV3(subjectCategoryId, objectCategoryId) {
    const getSubjects = () => reductOverlap(
      this._pageModelInfo.layout_dets
        .filter(x => x.category_id === subjectCategoryId)
        .map(x => ({
          bbox: x.bbox,
          score: x.score,
          original_label: x.original_label,
          original_order: x.original_order,
          polygon_points: x.polygon_points,
        }))
    );
    const getObjects = () => reductOverlap(
      this._pageModelInfo.layout_dets
        .filter(x => x.category_id === objectCategoryId)
        .map(x => ({
          bbox: x.bbox,
          score: x.score,
          original_label: x.original_label,
          original_order: x.original_order,
          polygon_points: x.polygon_points,
        }))
    );
    return tieUpCategoryByDistanceV3(getSubjects, getObjects);
  }

  // ---------------------------------------------------------------------------
  // Public getters
  // ---------------------------------------------------------------------------

  /**
   * @returns {object[]}
   */
  getImgs() {
    const withCaptions = this._tieUpCategoryByDistanceV3(CategoryId.ImageBody, CategoryId.ImageCaption);
    const withFootnotes = this._tieUpCategoryByDistanceV3(CategoryId.ImageBody, CategoryId.ImageFootnote);

    return withCaptions.map(v => {
      const d = withFootnotes.find(x => x.sub_idx === v.sub_idx);
      return {
        image_body: v.sub_bbox,
        image_caption_list: v.obj_bboxes,
        image_footnote_list: d ? d.obj_bboxes : [],
      };
    });
  }

  /**
   * @returns {object[]}
   */
  getTables() {
    const withCaptions = this._tieUpCategoryByDistanceV3(CategoryId.TableBody, CategoryId.TableCaption);
    const withFootnotes = this._tieUpCategoryByDistanceV3(CategoryId.TableBody, CategoryId.TableFootnote);

    return withCaptions.map(v => {
      const d = withFootnotes.find(x => x.sub_idx === v.sub_idx);
      return {
        table_body: v.sub_bbox,
        table_caption_list: v.obj_bboxes,
        table_footnote_list: d ? d.obj_bboxes : [],
      };
    });
  }

  /**
   * @returns {[object[], object[], object[]]} [inlineEquations, interlineEquations, interlineEquationBlocks]
   */
  getEquations() {
    const inlineEquations = this._getBlocksByType(CategoryId.InlineEquation, ['latex']);
    const interlineEquations = this._getBlocksByType(CategoryId.InterlineEquation_YOLO, ['latex']);
    const interlineEquationBlocks = this._getBlocksByType(CategoryId.InterlineEquation_Layout);
    return [inlineEquations, interlineEquations, interlineEquationBlocks];
  }

  /** @returns {object[]} */
  getDiscarded() {
    return this._getBlocksByType(CategoryId.Abandon);
  }

  /** @returns {object[]} */
  getTextBlocks() {
    return this._getBlocksByType(CategoryId.Text);
  }

  /** @returns {object[]} */
  getTitleBlocks() {
    return this._getBlocksByType(CategoryId.Title);
  }

  /**
   * Get all spans (image, table, formula, checkbox, OCR text).
   * @returns {object[]}
   */
  getAllSpans() {
    const allSpans = [];
    const allowCategoryIds = new Set([
      CategoryId.ImageBody,
      CategoryId.TableBody,
      CategoryId.InlineEquation,
      CategoryId.InterlineEquation_YOLO,
      CategoryId.OcrText,
      CategoryId.CheckBox,
    ]);

    for (const layoutDet of this._pageModelInfo.layout_dets) {
      const categoryId = layoutDet.category_id;
      if (!allowCategoryIds.has(categoryId)) continue;

      // Skip VL OCR results (handled separately)
      if (layoutDet.vl_ocr) continue;

      const span = {
        bbox: layoutDet.bbox,
        score: layoutDet.score,
        original_label: layoutDet.original_label ?? null,
        original_order: layoutDet.original_order ?? null,
        polygon_points: layoutDet.polygon_points ?? null,
      };

      if (categoryId === CategoryId.ImageBody) {
        span.type = ContentType.IMAGE;
      } else if (categoryId === CategoryId.TableBody) {
        const latex = layoutDet.latex;
        const html = layoutDet.html || layoutDet.table_res?.html;
        if (latex) {
          span.latex = latex;
        } else if (html) {
          span.html = html;
          if (layoutDet.latex_boxes) span.latex_boxes = layoutDet.latex_boxes;
          else if (layoutDet.img_boxes || layoutDet.table_res?.img_boxes) {
            span.img_boxes = layoutDet.img_boxes || layoutDet.table_res?.img_boxes;
          }
        }
        span.type = ContentType.TABLE;
      } else if (categoryId === CategoryId.InlineEquation) {
        span.content = layoutDet.latex || layoutDet.formula_res?.latex || '';
        span.type = ContentType.INLINE_EQUATION;
      } else if (
        categoryId === CategoryId.InterlineEquation_Layout ||
        categoryId === CategoryId.InterlineEquation_YOLO
      ) {
        span.content = layoutDet.latex || layoutDet.formula_res?.latex || '';
        span.type = ContentType.INTERLINE_EQUATION;
      } else if (categoryId === CategoryId.CheckBox) {
        span.content = layoutDet.checkbox || '';
        span.type = ContentType.CHECKBOX;
      } else if (categoryId === CategoryId.OcrText) {
        span.content = layoutDet.text;
        span.type = ContentType.TEXT;
      }

      allSpans.push(span);
    }

    return MagicModel._removeDuplicateSpans(allSpans);
  }

  /**
   * Get VL OCR spans.
   * @returns {object[]}
   */
  getVlOcrSpans() {
    const vlOcrSpans = [];
    for (const layoutDet of this._pageModelInfo.layout_dets) {
      if (!layoutDet.vl_ocr) continue;
      const text = layoutDet.text || '';
      if (!text) continue;

      vlOcrSpans.push({
        bbox: layoutDet.bbox,
        score: layoutDet.score ?? 0.95,
        content: text,
        type: ContentType.TEXT,
        vl_ocr: true,
        original_label: layoutDet.original_label ?? null,
        original_order: layoutDet.original_order ?? null,
        polygon_points: layoutDet.polygon_points ?? null,
      });
    }
    return vlOcrSpans;
  }

  /**
   * @param {number} categoryType
   * @param {string[]} [extraCols=[]]
   * @returns {object[]}
   */
  _getBlocksByType(categoryType, extraCols = []) {
    const blocks = [];
    for (const item of (this._pageModelInfo.layout_dets || [])) {
      if (item.category_id === categoryType) {
        const block = {
          bbox: item.bbox,
          original_label: item.original_label ?? null,
          original_order: item.original_order ?? null,
          polygon_points: item.polygon_points ?? null,
          score: item.score,
        };
        for (const col of extraCols) {
          block[col] = item[col] ?? null;
        }
        blocks.push(block);
      }
    }
    return blocks;
  }

  /**
   * @param {object[]} spans
   * @returns {object[]}
   */
  static _removeDuplicateSpans(spans) {
    const seen = [];
    const unique = [];
    for (const span of spans) {
      const key = JSON.stringify(span);
      if (!seen.includes(key)) {
        seen.push(key);
        unique.push(span);
      }
    }
    return unique;
  }
}
