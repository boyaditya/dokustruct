/* global cv */

import { RapidLayout } from './rapid_layout_self/main.js';
import { RapidLayoutInput, ModelType } from './rapid_layout_self/utils/typings.js';
import { CategoryId } from '../../utils/enum_class.js';
import { deleteMat } from '../../utils/resource_utils.js';
import { formatPipelineError, detectProfile } from '../../utils/browser_utils.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const INLINE_FORMULA_IOU_THRESH = 0.9;
// FIX P10: DPI_DOWNSCALE_THRESHOLD scales with detected device tier.
// Higher-end devices can handle larger images before downscaling kicks in.
const DPI_DOWNSCALE_THRESHOLD = detectProfile().DPI_DOWNSCALE_THRESHOLD;
const DPI_SCALE_FACTOR = 144;

// ─── Inline helpers ───────────────────────────────────────────────────────────

/**
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

function isContained(box1, box2) {
  return calculateIou(box1, box2) >= INLINE_FORMULA_IOU_THRESH;
}

// ─── get_cls_dicts ────────────────────────────────────────────────────────────

/**
 * Build three label→CategoryId maps for the active markdown_ignore_labels list.
 * @param {string[]} markdownIgnoreLabels
 * @returns {{ ppDocLayoutCls: Object, ppDocLayoutPlusCls: Object, ppDocLayoutV2Cls: Object }}
 */
export function getClsDicts(markdownIgnoreLabels = []) {
  const ignore = new Set(markdownIgnoreLabels);
  const _resolve = (map) =>
    Object.fromEntries(
      Object.entries(map).map(([k, v]) => [k, ignore.has(k) ? CategoryId.Abandon : v]),
    );

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
   * Async factory.
   * @param {Object|null} [layoutConfig]
   * @returns {Promise<RapidLayoutModel>}
   */
  static async create(layoutConfig = null) {
    const instance = new RapidLayoutModel();

    const cfg = new RapidLayoutInput({ model_type: ModelType.PP_DOCLAYOUTV2 });

    if (layoutConfig !== null) {
      if (layoutConfig.model_type)        cfg.model_type     = layoutConfig.model_type;
      if (layoutConfig.layout_shape_mode) cfg.layout_shape_mode = layoutConfig.layout_shape_mode;

      if (!layoutConfig.conf_thresh) {
        if (cfg.model_type === ModelType.PP_DOCLAYOUT_S ||
            cfg.model_type === ModelType.DOCLAYOUT_DOCSTRUCTBENCH) {
          cfg.conf_thresh = 0.2;
        }
      }

      for (const [key, value] of Object.entries(layoutConfig)) {
        const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        if (camel in cfg) cfg[camel] = value;
        if (key  in cfg)  cfg[key]   = value;
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

    instance.model = await RapidLayout.create(cfg);
    return instance;
  }

  /**
   * Run layout detection on a single image.
   * @param {cv.Mat} image
   * @returns {Promise<Array<Object>>}
   */
  async predict(image) {
    const results = await this.batchPredict([image], 1);
    return results[0];
  }

  /**
   * Run layout detection on a batch of images.
   * @param {cv.Mat[]} images
   * @param {number}   batchSize
   * @param {number}   [dpi=200]
   * @returns {Promise<Array<Array<Object>>>}
   */
  async batchPredict(images, batchSize, dpi = 200) {
    if (!this.model) {
      throw new Error('[RapidLayoutModel] model is null — was dispose() called before batchPredict()?');
    }

    const processedImages = [];
    const scales = [];

    for (const img of images) {
      const h = img.rows;
      const w = img.cols;

      if (Math.max(h, w) > DPI_DOWNSCALE_THRESHOLD) {
        const scale = DPI_SCALE_FACTOR / dpi;
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

    let allResults;
    try {
      allResults = await this.model.call(processedImages, batchSize);
    } finally {
      for (let i = 0; i < processedImages.length; i++) {
        if (scales[i] !== 1.0) deleteMat(processedImages[i]);
      }
    }

    const imagesLayoutRes = [];

    for (let imgIdx = 0; imgIdx < allResults.length; imgIdx++) {
      const results = allResults[imgIdx];
      const scale = scales[imgIdx];
      const restoreScale = 1.0 / scale;

      const { boxes, scores, class_names: classNames } = results;
      const orders          = results.orders          ?? Array(boxes.length).fill(-1);
      const polygonPointses = results.polygon_points  ?? Array(boxes.length).fill(null);

      const tempResults = [];
      for (let k = 0; k < boxes.length; k++) {
        const xyxy = boxes[k];
        const cla  = classNames[k];
        const conf = scores[k];
        const order = orders[k];
        const polygonPoints = polygonPointses[k] ?? null;

        const [xmin, ymin, xmax, ymax] = xyxy.map(p => Math.round(p * 100) / 100);

        const categoryId = this._resolveCategoryId(cla);

        tempResults.push({
          category_id:    categoryId,
          original_label: cla,
          original_order: order,
          bbox:           [xmin, ymin, xmax, ymax],
          polygon_points: polygonPoints,
          score:          Math.round(parseFloat(conf) * 1000) / 1000,
        });
      }

      // V2/V3 already have inline_formula class — skip inline check
      const withInlineCheck =
        [ModelType.PP_DOCLAYOUTV2, ModelType.PP_DOCLAYOUTV3].includes(this.modelType)
          ? tempResults
          : this.checkInlineFormula(tempResults);

      const layoutRes = [];
      for (const item of withInlineCheck) {
        let [x1, y1, x2, y2] = item.bbox;
        x1 *= restoreScale;
        y1 *= restoreScale;
        x2 *= restoreScale;
        y2 *= restoreScale;

        let polyPoints = item.polygon_points;
        if (polyPoints != null) {
          polyPoints = polyPoints.map(([px, py]) => [
            px * restoreScale,
            py * restoreScale,
          ]);
        }

        layoutRes.push({
          category_id:    item.category_id,
          original_label: item.original_label,
          original_order: item.original_order,
          poly:           [x1, y1, x2, y1, x2, y2, x1, y2],
          polygon_points: polyPoints,
          score:          item.score,
        });
      }

      imagesLayoutRes.push(layoutRes);
    }

    return imagesLayoutRes;
  }

  /**
   * Detect inline formulas — a formula box mostly contained within a text box
   * is reclassified as InlineEquation.
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

  /**
   * Dispose the underlying ONNX session and release resources.
   */
  async dispose() {
    if (this.model?.session) {
      try {
        if (typeof this.model.session.release === 'function') {
          await this.model.session.release();
        }
      } catch (err) {
        console.warn(formatPipelineError({
          stage: 'dispose',
          module: 'RapidLayoutModel',
          message: `Failed to release layout session: ${err?.message ?? err}`,
          recoverable: true,
        }));
      }
      this.model.session = null;
    }
    this.model = null;
  }

  /**
   * Resolve a class name to a CategoryId based on the active model type.
   * @param {string} cla
   * @returns {number}
   * @private
   */
  _resolveCategoryId(cla) {
    if (this.modelType === ModelType.PP_DOCLAYOUT_PLUS_L) {
      return this.ppDocLayoutPlusClsDict[cla] ?? CategoryId.Abandon;
    }
    if ([ModelType.PP_DOCLAYOUTV2, ModelType.PP_DOCLAYOUTV3].includes(this.modelType)) {
      return this.ppDocLayoutV2ClsDict[cla] ?? CategoryId.Abandon;
    }
    if (this.modelType === ModelType.DOCLAYOUT_DOCSTRUCTBENCH) {
      if (cla === 'isolate_formula') return 14;
      const idx = this.doclayoutYoloList.indexOf(cla);
      return idx >= 0 ? idx : CategoryId.Abandon;
    }
    return this.ppDocLayoutClsDict[cla] ?? CategoryId.Abandon;
  }
}
