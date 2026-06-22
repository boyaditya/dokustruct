// Copyright (c) RapidAI. All rights reserved.

import {
  bboxRelativePos, calculateIou, bboxDistance, getMinboxIfOverlapByRatio,
} from "../../utils/boxbase.js";
import { CategoryId, ContentType } from "../../utils/enum_class.js";
import {
  tieUpCategoryByDistanceV3, reductOverlap,
} from "../../utils/magic_model_utils.js";

const LOW_CONFIDENCE_THRESHOLD = 0.05;
const HIGH_IOU_THRESHOLD = 0.9;
const OVERLAP_RATIO_THRESHOLD = 0.8;
const DISTANCE_DIVERGENCE_FACTOR = 0.3;

const RELEVANT_CATEGORIES = new Set([
  CategoryId.Title, CategoryId.Text, CategoryId.ImageBody,
  CategoryId.ImageCaption, CategoryId.TableBody, CategoryId.TableCaption,
  CategoryId.TableFootnote, CategoryId.InterlineEquation_Layout,
  CategoryId.InterlineEquationNumber_Layout,
]);

const SPAN_CATEGORY_IDS = new Set([
  CategoryId.ImageBody,
  CategoryId.TableBody,
  CategoryId.InlineEquation,
  CategoryId.InterlineEquation_YOLO,
  CategoryId.OcrText,
  CategoryId.CheckBox,
]);

/**
 * Page model info processor — groups layout detections into semantic blocks
 * (images, tables, equations, text) with caption/footnote association.
 */
export class MagicModel {
  static LOW_CONFIDENCE_THRESHOLD = LOW_CONFIDENCE_THRESHOLD;
  static HIGH_IOU_THRESHOLD = HIGH_IOU_THRESHOLD;

  /**
   * @param {object} pageModelInfo - Raw model output with layout_dets
   * @param {number} scale - Page image scale factor
   */
  constructor(pageModelInfo, scale) {
    if (!pageModelInfo || !Array.isArray(pageModelInfo.layout_dets)) {
      this._pageModelInfo = { layout_dets: [] };
      this._scale = scale || 1;
      return;
    }

    this._pageModelInfo = pageModelInfo;
    this._scale = scale || 1;

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
    const layoutDets = this._pageModelInfo.layout_dets;
    const scale = this._scale;
    const needRemoveIndices = [];

    for (let i = 0; i < layoutDets.length; i++) {
      const layoutDet = layoutDets[i];
      if (!layoutDet.poly || layoutDet.poly.length < 6) {
        needRemoveIndices.push(i);
        continue;
      }

      const [x0, y0, , , x1, y1] = layoutDet.poly;
      const bbox = [
        Math.floor(x0 / scale * 100) / 100,
        Math.floor(y0 / scale * 100) / 100,
        Math.floor(x1 / scale * 100) / 100,
        Math.floor(y1 / scale * 100) / 100,
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
        needRemoveIndices.push(i);
      }
    }

    for (let i = needRemoveIndices.length - 1; i >= 0; i--) {
      layoutDets.splice(needRemoveIndices[i], 1);
    }
  }

  _fixByRemoveLowConfidence() {
    const layoutDets = this._pageModelInfo.layout_dets;
    for (let i = layoutDets.length - 1; i >= 0; i--) {
      if ((layoutDets[i].score ?? 0) <= LOW_CONFIDENCE_THRESHOLD) {
        layoutDets.splice(i, 1);
      }
    }
  }

  _fixByRemoveHighIouAndLowConfidence() {
    const layoutDets = this._pageModelInfo.layout_dets;
    const relevantDets = layoutDets.filter(x => RELEVANT_CATEGORIES.has(x.category_id));
    const needRemoveSet = new Set();

    for (let i = 0; i < relevantDets.length; i++) {
      for (let j = i + 1; j < relevantDets.length; j++) {
        const det1 = relevantDets[i];
        const det2 = relevantDets[j];
        if (!det1.bbox || !det2.bbox) continue;
        if (calculateIou(det1.bbox, det2.bbox) > HIGH_IOU_THRESHOLD) {
          const detToRemove = (det1.score ?? 0) < (det2.score ?? 0) ? det1 : det2;
          needRemoveSet.add(detToRemove);
        }
      }
    }

    for (let i = layoutDets.length - 1; i >= 0; i--) {
      if (needRemoveSet.has(layoutDets[i])) {
        layoutDets.splice(i, 1);
      }
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
      if (!footnote.bbox) continue;

      for (const figure of figures) {
        if (!figure.bbox) continue;
        const posFlagCount = bboxRelativePos(footnote.bbox, figure.bbox).filter(Boolean).length;
        if (posFlagCount > 1) continue;
        const d = this._computeDistance(figure.bbox, footnote.bbox);
        disFigureFootnote[i] = Math.min(d, disFigureFootnote[i] ?? Infinity);
      }

      for (const table of tables) {
        if (!table.bbox) continue;
        const posFlagCount = bboxRelativePos(footnote.bbox, table.bbox).filter(Boolean).length;
        if (posFlagCount > 1) continue;
        const d = this._computeDistance(table.bbox, footnote.bbox);
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
    const layoutDets = this._pageModelInfo.layout_dets;
    const imageBlocks = layoutDets.filter(x => x.category_id === CategoryId.ImageBody);
    const tableBlocks = layoutDets.filter(x => x.category_id === CategoryId.TableBody);
    const needRemoveSet = new Set();

    const mergeOverlappingBlocks = (blocks) => {
      for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
          const b1 = blocks[i];
          const b2 = blocks[j];
          if (!b1.bbox || !b2.bbox) continue;
          const overlapBox = getMinboxIfOverlapByRatio(b1.bbox, b2.bbox, OVERLAP_RATIO_THRESHOLD);
          if (overlapBox === null) continue;

          const area1 = (b1.bbox[2] - b1.bbox[0]) * (b1.bbox[3] - b1.bbox[1]);
          const area2 = (b2.bbox[2] - b2.bbox[0]) * (b2.bbox[3] - b2.bbox[1]);
          const [smallBlock, largeBlock] = area1 <= area2 ? [b1, b2] : [b2, b1];

          if (!needRemoveSet.has(smallBlock)) {
            const [x1, y1, x2, y2] = largeBlock.bbox;
            const [sx1, sy1, sx2, sy2] = smallBlock.bbox;
            largeBlock.bbox = [
              Math.min(x1, sx1), Math.min(y1, sy1),
              Math.max(x2, sx2), Math.max(y2, sy2),
            ];
            needRemoveSet.add(smallBlock);
          }
        }
      }
    };

    mergeOverlappingBlocks(imageBlocks);
    mergeOverlappingBlocks(tableBlocks);

    for (let i = layoutDets.length - 1; i >= 0; i--) {
      if (needRemoveSet.has(layoutDets[i])) {
        layoutDets.splice(i, 1);
      }
    }
  }

  /**
   * Compute distance between two bboxes with size-divergence check.
   * Returns Infinity if bboxes are in multiple relative positions or
   * the second bbox is significantly larger than the first.
   */
  _computeDistance(bbox1, bbox2) {
    if (!bbox1 || !bbox2) return Infinity;

    const [left, right, bottom, top] = bboxRelativePos(bbox1, bbox2);
    const count = [left, right, bottom, top].filter(Boolean).length;
    if (count > 1) return Infinity;

    let l1, l2;
    if (left || right) {
      l1 = bbox1[3] - bbox1[1];
      l2 = bbox2[3] - bbox2[1];
    } else {
      l1 = bbox1[2] - bbox1[0];
      l2 = bbox2[2] - bbox2[0];
    }

    if (l1 <= 0) return Infinity;
    if (l2 > l1 && (l2 - l1) / l1 > DISTANCE_DIVERGENCE_FACTOR) return Infinity;
    return bboxDistance(bbox1, bbox2);
  }

  _tieUpCategoryByDistanceV3(subjectCategoryId, objectCategoryId) {
    const getSubjects = () => reductOverlap(
      this._pageModelInfo.layout_dets
        .filter(x => x.category_id === subjectCategoryId)
        .map(x => ({
          bbox: x.bbox,
          score: x.score,
          original_label: x.original_label ?? null,
          original_order: x.original_order ?? null,
          polygon_points: x.polygon_points ?? null,
        }))
    );
    const getObjects = () => reductOverlap(
      this._pageModelInfo.layout_dets
        .filter(x => x.category_id === objectCategoryId)
        .map(x => ({
          bbox: x.bbox,
          score: x.score,
          original_label: x.original_label ?? null,
          original_order: x.original_order ?? null,
          polygon_points: x.polygon_points ?? null,
        }))
    );
    return tieUpCategoryByDistanceV3(getSubjects, getObjects);
  }

  // ---------------------------------------------------------------------------
  // Public getters
  // ---------------------------------------------------------------------------

  /** @returns {object[]} */
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

  /** @returns {object[]} */
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

    for (const layoutDet of this._pageModelInfo.layout_dets) {
      if (!SPAN_CATEGORY_IDS.has(layoutDet.category_id)) continue;
      if (layoutDet.vl_ocr) continue;

      const span = this._buildSpan(layoutDet);
      if (span) allSpans.push(span);
    }

    return removeDuplicateSpans(allSpans);
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Build a span object from a layout detection entry.
   * @param {object} layoutDet
   * @returns {object|null}
   */
  _buildSpan(layoutDet) {
    const categoryId = layoutDet.category_id;
    const span = {
      bbox: layoutDet.bbox,
      score: layoutDet.score,
      original_label: layoutDet.original_label ?? null,
      original_order: layoutDet.original_order ?? null,
      polygon_points: layoutDet.polygon_points ?? null,
    };

    if (categoryId === CategoryId.ImageBody) {
      span.type = ContentType.IMAGE;
      if (layoutDet.original_label === 'seal') {
        span.content = layoutDet.text ?? null;
      }
    } else if (categoryId === CategoryId.TableBody) {
      this._populateTableSpan(span, layoutDet);
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
      span.content = layoutDet.text ?? '';
      span.type = ContentType.TEXT;
    }

    return span;
  }

  /**
   * Populate table-specific fields on a span.
   */
  _populateTableSpan(span, layoutDet) {
    const latex = layoutDet.latex;
    const html = layoutDet.html || layoutDet.table_res?.html;

    if (latex) {
      span.latex = latex;
    } else if (html) {
      span.html = html;
      if (layoutDet.latex_boxes) {
        span.latex_boxes = layoutDet.latex_boxes;
      } else if (layoutDet.img_boxes || layoutDet.table_res?.img_boxes) {
        span.img_boxes = layoutDet.img_boxes || layoutDet.table_res?.img_boxes;
      }
    }
    span.type = ContentType.TABLE;
  }

  /**
   * @param {number} categoryType
   * @param {string[]} [extraCols=[]]
   * @returns {object[]}
   */
  _getBlocksByType(categoryType, extraCols = []) {
    const blocks = [];
    for (const item of this._pageModelInfo.layout_dets) {
      if (item.category_id !== categoryType) continue;
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
    return blocks;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Remove duplicate spans by JSON key comparison.
 * @param {object[]} spans
 * @returns {object[]}
 */
function removeDuplicateSpans(spans) {
  if (!spans || !spans.length) return [];
  const seen = new Set();
  const unique = [];
  for (const span of spans) {
    const key = JSON.stringify(span);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(span);
    }
  }
  return unique;
}
