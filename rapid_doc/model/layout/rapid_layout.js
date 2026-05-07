/**
 * PORTING NOTE: rapid_doc/model/layout/rapid_layout.py → rapid_layout.js
 *
 * RapidLayoutModel: high-level adapter that sits above RapidLayout.
 *   - Receives a layout_config plain object (equivalent to Python dict).
 *   - Resolves CategoryId mappings per model type.
 *   - Applies DPI-based image downscaling before inference.
 *   - Converts RapidLayoutOutput objects to the final layout_res dict format.
 *   - Checks for inline formulas (formula box is mostly contained inside a text box).
 *
 * CHANGE: __init__  → static async create(layoutConfig) factory.
 *         model = RapidLayout(cfg=cfg) → session created with await RapidLayout.create().
 *
 * CHANGE: cv2.resize → cv.resize (OpenCV.js). Images are cv.Mat in JS.
 *
 * CHANGE: No CLI / __main__ block.
 *
 * CHANGE: get_device() / CUDA / NPU engine_cfg selection:
 *   CUDA and NPU device paths are replaced by WebGPU availability (handled
 *   transparently by ProviderConfig). Engine cfg overrides are not needed.
 *
 * INPUT:  layoutConfig — plain JS object (mirrors Python dict layout_config).
 * OUTPUT: getClsDicts() → three JS Map<string, number> objects.
 *         batchPredict() → Array<Array<{category_id, bbox, poly, score, ...}>>
 */

/* global cv */

import { RapidLayout } from './rapid_layout_self/main.js';
import { RapidLayoutInput, ModelType } from './rapid_layout_self/utils/typings.js';
import { CategoryId } from '../../utils/enum_class.js';

// ─── Inline helpers ───────────────────────────────────────────────────────────

/**
 * Calculate IoU ratio for two [x1,y1,x2,y2] boxes.
 * Mirrors: calculate_iou from rapid_doc/utils/boxbase.py
 *
 * @param {[number,number,number,number]} box1
 * @param {[number,number,number,number]} box2
 * @returns {number}
 */
function calculateIou(box1, box2) {
  const xLeft   = Math.max(box1[0], box2[0]);
  const yTop    = Math.max(box1[1], box2[1]);
  const xRight  = Math.min(box1[2], box2[2]);
  const yBottom = Math.min(box1[3], box2[3]);

  if (xRight < xLeft || yBottom < yTop) return 0;

  const intersect = (xRight - xLeft) * (yBottom - yTop);
  const area1 = (box1[2] - box1[0]) * (box1[3] - box1[1]);
  const area2 = (box2[2] - box2[0]) * (box2[3] - box2[1]);
  const union = area1 + area2 - intersect;
  return union <= 0 ? 0 : intersect / union;
}

function isContained(box1, box2, thresh = 0.9) {
  return calculateIou(box1, box2) >= thresh;
}

// ─── get_cls_dicts ────────────────────────────────────────────────────────────

/**
 * Build three label→CategoryId maps for the active markdown_ignore_labels list.
 * Mirrors: get_cls_dicts(markdown_ignore_labels)
 *
 * @param {string[]} markdownIgnoreLabels
 * @returns {{ ppDocLayoutCls: Object, ppDocLayoutPlusCls: Object, ppDocLayoutV2Cls: Object }}
 */
export function getClsDicts(markdownIgnoreLabels = []) {
  const ignore = new Set(markdownIgnoreLabels);
  const _resolve = (map) =>
    Object.fromEntries(
      Object.entries(map).map(([k, v]) => [k, ignore.has(k) ? CategoryId.Abandon : v]),
    );

  // PP-DocLayout-L/M/S — 23 classes
  const ppDocLayoutCls = _resolve({
    paragraph_title:   CategoryId.Title,
    image:             CategoryId.ImageBody,
    text:              CategoryId.Text,
    number:            CategoryId.Text,
    abstract:          CategoryId.Text,
    content:           CategoryId.Text,
    figure_title:      CategoryId.Text,
    formula:           CategoryId.InterlineEquation_YOLO,
    table:             CategoryId.TableBody,
    table_title:       CategoryId.TableCaption,
    reference:         CategoryId.Text,
    doc_title:         CategoryId.Title,
    footnote:          CategoryId.Text,
    header:            CategoryId.Text,
    algorithm:         CategoryId.Text,
    footer:            CategoryId.Text,
    seal:              CategoryId.ImageBody,
    chart_title:       CategoryId.ImageCaption,
    chart:             CategoryId.ImageBody,
    formula_number:    CategoryId.InterlineEquationNumber_Layout,
    header_image:      CategoryId.ImageBody,
    footer_image:      CategoryId.ImageBody,
    aside_text:        CategoryId.Text,
  });

  // PP-DocLayout_plus-L — 20 classes
  const ppDocLayoutPlusCls = _resolve({
    paragraph_title:           CategoryId.Title,
    image:                     CategoryId.ImageBody,
    text:                      CategoryId.Text,
    number:                    CategoryId.Text,
    abstract:                  CategoryId.Text,
    content:                   CategoryId.Text,
    figure_table_chart_title:  CategoryId.Text,
    formula:                   CategoryId.InterlineEquation_YOLO,
    table:                     CategoryId.TableBody,
    reference:                 CategoryId.Text,
    doc_title:                 CategoryId.Title,
    footnote:                  CategoryId.Text,
    header:                    CategoryId.Text,
    algorithm:                 CategoryId.Text,
    footer:                    CategoryId.Text,
    seal:                      CategoryId.ImageBody,
    chart:                     CategoryId.ImageBody,
    formula_number:            CategoryId.InterlineEquationNumber_Layout,
    aside_text:                CategoryId.Text,
    reference_content:         CategoryId.Text,
  });

  // PP-DocLayoutV2/V3 — 25 classes
  const ppDocLayoutV2Cls = _resolve({
    abstract:           CategoryId.Text,
    algorithm:          CategoryId.Text,
    aside_text:         CategoryId.Text,
    chart:              CategoryId.ImageBody,
    content:            CategoryId.Text,
    display_formula:    CategoryId.InterlineEquation_YOLO,
    doc_title:          CategoryId.Title,
    figure_title:       CategoryId.Text,
    footer:             CategoryId.Text,
    footer_image:       CategoryId.ImageBody,
    footnote:           CategoryId.Text,
    formula_number:     CategoryId.InterlineEquationNumber_Layout,
    header:             CategoryId.Text,
    header_image:       CategoryId.ImageBody,
    image:              CategoryId.ImageBody,
    inline_formula:     CategoryId.InlineEquation,
    number:             CategoryId.Text,
    paragraph_title:    CategoryId.Title,
    reference:          CategoryId.Text,
    reference_content:  CategoryId.Text,
    seal:               CategoryId.ImageBody,
    table:              CategoryId.TableBody,
    text:               CategoryId.Text,
    vertical_text:      CategoryId.Text,
    vision_footnote:    CategoryId.Text,
  });

  return { ppDocLayoutCls, ppDocLayoutPlusCls, ppDocLayoutV2Cls };
}

// ─── RapidLayoutModel ─────────────────────────────────────────────────────────

export class RapidLayoutModel {
  /** @private */
  constructor() {
    /** @type {RapidLayout} */
    this.model = null;
    this.modelType = null;
    this.markdownIgnoreLabels = [];
    this.ppDocLayoutClsDict     = null;
    this.ppDocLayoutPlusClsDict = null;
    this.ppDocLayoutV2ClsDict   = null;
    this.doclayoutYoloList = [
      'title', 'plain text', 'abandon', 'figure', 'figure_caption',
      'table', 'table_caption', 'table_footnote', 'isolate_formula',
      'formula_caption', '10', '11', '12', 'inline_formula',
      'isolated_formula', 'ocr_text',
    ];
  }

  /**
   * Async factory — mirrors __init__(layout_config=None)
   *
   * @param {Object|null} [layoutConfig]
   * @returns {Promise<RapidLayoutModel>}
   */
  static async create(layoutConfig = null) {
    const instance = new RapidLayoutModel();

    const cfg = new RapidLayoutInput({ model_type: ModelType.PP_DOCLAYOUTV2 });

    // CHANGE: CUDA/NPU → TargetDevice selection no longer needed.
    // WebGPU is auto-selected by ProviderConfig when available.

    if (layoutConfig !== null) {
      if (layoutConfig.model_type)        cfg.model_type     = layoutConfig.model_type;
      if (layoutConfig.layout_shape_mode) cfg.layout_shape_mode = layoutConfig.layout_shape_mode;

      // Auto-lower conf_thresh for certain models when not explicitly set
      if (!layoutConfig.conf_thresh) {
        if (cfg.model_type === ModelType.PP_DOCLAYOUT_S ||
            cfg.model_type === ModelType.DOCLAYOUT_DOCSTRUCTBENCH) {
          cfg.conf_thresh = 0.2;
        }
      }

      // Apply remaining layout_config keys
      for (const [key, value] of Object.entries(layoutConfig)) {
        // Map snake_case keys to camelCase equivalents in cfg
        const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        if (camel in cfg)      cfg[camel]  = value;
        if (key  in cfg)       cfg[key]    = value;
      }
    }

    layoutConfig = layoutConfig ?? {};

    instance.markdownIgnoreLabels = layoutConfig.markdown_ignore_labels ?? [
      'number', 'footnote', 'header', 'header_image',
      'footer', 'footer_image', 'aside_text',
    ];

    const { ppDocLayoutCls, ppDocLayoutPlusCls, ppDocLayoutV2Cls } =
      getClsDicts(instance.markdownIgnoreLabels);
    instance.ppDocLayoutClsDict     = ppDocLayoutCls;
    instance.ppDocLayoutPlusClsDict = ppDocLayoutPlusCls;
    instance.ppDocLayoutV2ClsDict   = ppDocLayoutV2Cls;

    instance.modelType = cfg.modelType ?? cfg.model_type ?? ModelType.PP_DOCLAYOUTV2;

    instance.model     = await RapidLayout.create(cfg);
    return instance;
  }

  // ── predict ────────────────────────────────────────────────────────────────

  /**
   * Run layout detection on a single image.
   * @param {cv.Mat} image
   * @returns {Promise<Array<Object>>}
   */
  async predict(image) {
    const results = await this.batchPredict([image], 1);
    return results[0];
  }

  // ── batchPredict ───────────────────────────────────────────────────────────

  /**
   * Run layout detection on a batch of images.
   * Mirrors: batch_predict(images, batch_size, dpi=200)
   *
   * @param {cv.Mat[]} images
   * @param {number}   batchSize
   * @param {number}   [dpi=200]
   * @returns {Promise<Array<Array<Object>>>}
   */
  async batchPredict(images, batchSize, dpi = 200) {
    // ── DPI-based downscaling (matches Python logic) ─────────────────────────
    const processedImages = [];
    const scales = [];

    for (const img of images) {
      const h = img.rows;
      const w = img.cols;

      if (Math.max(h, w) > 2200) {
        const scale = 144 / dpi;
        const resized = new cv.Mat();
        cv.resize(
          img, resized,
          new cv.Size(Math.round(w * scale), Math.round(h * scale)),
          0, 0, cv.INTER_AREA,
        );
        processedImages.push(resized);
        scales.push(scale);
      } else {
        processedImages.push(img);
        scales.push(1.0);
      }
    }

    // ── Inference ─────────────────────────────────────────────────────────────
    const allResults = await this.model.call(processedImages, batchSize);

    // ── Format outputs ────────────────────────────────────────────────────────
    const imagesLayoutRes = [];

    for (let imgIdx = 0; imgIdx < allResults.length; imgIdx++) {
      const results = allResults[imgIdx];
      const scale = scales[imgIdx];
      const restoreScale = 1.0 / scale;

      // Clean up scaled Mat if we created one
      if (scale !== 1.0) processedImages[imgIdx].delete();

      const { boxes, scores, class_names: classNames } = results;
      const orders         = results.orders         ?? Array(boxes.length).fill(-1);
      const polygonPointses = results.polygon_points ?? Array(boxes.length).fill(null);

      // ── Build temp_results ───────────────────────────────────────────────
      const tempResults = [];
      for (let k = 0; k < boxes.length; k++) {
        const xyxy = boxes[k];
        const cla  = classNames[k];
        const conf = scores[k];
        const order = orders[k];
        const polygonPoints = polygonPointses[k] ?? null;

        const [xmin, ymin, xmax, ymax] = xyxy.map(p => Math.round(p * 100) / 100);

        let categoryId;
        if (this.modelType === ModelType.PP_DOCLAYOUT_PLUS_L) {
          categoryId = this.ppDocLayoutPlusClsDict[cla] ?? CategoryId.Abandon;
        } else if ([ModelType.PP_DOCLAYOUTV2, ModelType.PP_DOCLAYOUTV3].includes(this.modelType)) {
          categoryId = this.ppDocLayoutV2ClsDict[cla] ?? CategoryId.Abandon;
        } else if (this.modelType === ModelType.DOCLAYOUT_DOCSTRUCTBENCH) {
          categoryId = cla === 'isolate_formula'
            ? 14
            : (this.doclayoutYoloList.indexOf(cla) ?? CategoryId.Abandon);
        } else {
          categoryId = this.ppDocLayoutClsDict[cla] ?? CategoryId.Abandon;
        }

        tempResults.push({
          category_id:    categoryId,
          original_label: cla,
          original_order: order,
          bbox:           [xmin, ymin, xmax, ymax],
          polygon_points: polygonPoints,
          score:          Math.round(parseFloat(conf) * 1000) / 1000,
        });
      }

      // ── Inline formula check (skip for V2/V3 — they have inline_formula class) ──
      const withInlineCheck =
        [ModelType.PP_DOCLAYOUTV2, ModelType.PP_DOCLAYOUTV3].includes(this.modelType)
          ? tempResults
          : this.checkInlineFormula(tempResults);

      // ── Restore scale + build final layout_res ───────────────────────────
      const layoutRes = [];
      for (const item of withInlineCheck) {
        let [x1, y1, x2, y2] = item.bbox;
        x1 *= restoreScale;
        y1 *= restoreScale;
        x2 *= restoreScale;
        y2 *= restoreScale;

        let polyPoints = item.polygon_points;
        if (polyPoints !== null && polyPoints !== undefined) {
          polyPoints = polyPoints.map(([px, py]) => [
            px * restoreScale,
            py * restoreScale,
          ]);
        }

        layoutRes.push({
          category_id:    item.category_id,
          original_label: item.original_label,
          original_order: item.original_order,
          poly:   [x1, y1, x2, y1, x2, y2, x1, y2],
          polygon_points: polyPoints,
          score:  item.score,
        });
      }

      imagesLayoutRes.push(layoutRes);
    }

    return imagesLayoutRes;
  }

  // ── checkInlineFormula ────────────────────────────────────────────────────

  /**
   * Detect inline formulas — a formula box that is mostly contained
   * within a text box is reclassified as InlineEquation.
   * Mirrors: check_inline_formula(temp_results)
   *
   * @param {Object[]} tempResults
   * @returns {Object[]}
   */
  checkInlineFormula(tempResults) {
    for (const item of tempResults) {
      if (item.category_id === CategoryId.InterlineEquation_YOLO) {
        for (const other of tempResults) {
          if (other.category_id === CategoryId.Text) {
            if (isContained(item.bbox, other.bbox)) {
              item.category_id = CategoryId.InlineEquation;
              break;
            }
          }
        }
      }
    }
    return tempResults;
  }
}
