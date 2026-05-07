/**
 * PORTING NOTE: typings.py → typings.js
 *
 * WORKAROUND: Python uses dataclasses and Enum for typed config objects
 * REASON: No runtime type enforcement in JS; Enum → Object.freeze
 * SOLUTION: JSDoc @typedef for type documentation; plain classes for config
 *           objects; Object.freeze for enums. Threshold maps and shape mode
 *           maps preserved as plain JS objects.
 *
 * AFFECTED METHODS: All @dataclass → plain JS class; all Enum → Object.freeze
 */

// ─── Threshold maps (unchanged from Python, used by model handlers) ──────────

export const PP_DOCLAYOUT_PLUS_L_Threshold = Object.freeze({
  0: 0.3,  // paragraph_title
  1: 0.5,  // image
  2: 0.4,  // text
  3: 0.5,  // number
  4: 0.5,  // abstract
  5: 0.5,  // content
  6: 0.5,  // figure_table_chart_title
  7: 0.3,  // formula
  8: 0.5,  // table
  9: 0.5,  // reference
  10: 0.5, // doc_title
  11: 0.5, // footnote
  12: 0.5, // header
  13: 0.5, // algorithm
  14: 0.5, // footer
  15: 0.5, // seal
  16: 0.5, // chart
  17: 0.5, // formula_number
  18: 0.5, // aside_text
  19: 0.5, // reference_content
});

export const PP_DOCLAYOUT_L_Threshold = Object.freeze({
  0: 0.3,  // paragraph_title
  1: 0.5,  // image
  2: 0.4,  // text
  3: 0.5,  // number
  4: 0.5,  // abstract
  5: 0.5,  // content
  6: 0.5,  // figure_title
  7: 0.3,  // formula
  8: 0.5,  // table
  9: 0.5,  // table_title
  10: 0.5, // reference
  11: 0.5, // doc_title
  12: 0.5, // footnote
  13: 0.5, // header
  14: 0.5, // algorithm
  15: 0.5, // footer
  16: 0.2, // seal
  17: 0.5, // header_image
  18: 0.5, // footer_image
  19: 0.5, // aside_text
  20: 0.5, // formula_number
  21: 0.5, // abstract
  22: 0.5, // content
});

export const PP_DOCLAYOUT_SHAPE_MODE = Object.freeze({
  0: 'union',  // paragraph_title
  1: 'large',  // image
  2: 'union',  // text
  3: 'union',  // number
  4: 'union',  // abstract
  5: 'union',  // content
  6: 'union',  // figure_title
  7: 'union',  // formula
  8: 'large',  // table
  9: 'union',  // table_title
  10: 'union', // reference
  11: 'union', // doc_title
  12: 'union', // footnote
  13: 'union', // header
  14: 'union', // algorithm
  15: 'union', // footer
  16: 'union', // seal
  17: 'large', // chart
  18: 'union', // formula_number
  19: 'union', // aside_text
  19: 'union', // reference_content
});

// ─── Enums ────────────────────────────────────────────────────────────────────

/**
 * @readonly
 * @enum {string}
 */
export const ModelType = Object.freeze({
  PP_DOCLAYOUT_PLUS_L: 'pp_doclayout_plus_l',
  PP_DOCLAYOUTV2: 'pp_doclayoutv2',
  PP_DOCLAYOUTV3: 'pp_doclayoutv3',
  PP_DOCLAYOUT_L: 'pp_doclayout_l',
  PP_DOCLAYOUT_M: 'pp_doclayout_m',
  PP_DOCLAYOUT_S: 'pp_doclayout_s',
  DOCLAYOUT_DOCSTRUCTBENCH: 'doclayout_docstructbench',
  RT_DETR_L_WIRED_TABLE_CELL_DET: 'rt_detr_l_wired_table_cell_det',
  RT_DETR_L_WIRELESS_TABLE_CELL_DET: 'rt_detr_l_wireless_table_cell_det',
});

/**
 * @readonly
 * @enum {string}
 */
export const EngineType = Object.freeze({
  ONNXRUNTIME: 'onnxruntime',
  OPENVINO: 'openvino', // [SKIP in browser - no OpenVINO support]
});

/**
 * @readonly
 * @enum {string}
 */
export const LayoutShapeMode = Object.freeze({
  RECT: 'rect',
  AUTO: 'auto',
});

// ─── Config dataclasses ───────────────────────────────────────────────────────

/**
 * @typedef {Object} RapidLayoutInputData
 * @property {string} [modelType]
 * @property {string} [engineType]
 * @property {string} [modelUrl]        - URL to the ONNX model (replaces model_dir_or_path)
 * @property {number} [confThresh]
 * @property {number} [batchNum]
 * @property {string[]} [markdownIgnoreLabels]
 * @property {string} [layoutShapeMode]
 * @property {Object} [engineCfg]
 */

export class RapidLayoutInput {
  /**
   * @param {RapidLayoutInputData} [data]
   */
  constructor(data = {}) {
    /** @type {string} */
    this.modelType = data.modelType ?? ModelType.PP_DOCLAYOUTV2;
    /** @type {string} */
    this.engineType = data.engineType ?? EngineType.ONNXRUNTIME;
    /** @type {string|null} */
    this.modelUrl = data.modelUrl ?? null;
    /** @type {number} */
    this.confThresh = data.confThresh ?? 0.5;
    /** @type {number} */
    this.batchNum = data.batchNum ?? 1;
    /** @type {string[]} */
    this.markdownIgnoreLabels = data.markdownIgnoreLabels ?? [
      'number', 'footnote', 'header', 'header_image',
      'footer', 'footer_image', 'aside_text',
    ];
    /** @type {string} */
    this.layoutShapeMode = data.layoutShapeMode ?? LayoutShapeMode.AUTO;
    /** @type {Object} */
    this.engineCfg = data.engineCfg ?? {};
  }
}

/**
 * @typedef {Object} LayoutDetBox
 * @property {number[]} bbox      - [x1, y1, x2, y2]
 * @property {string}   label
 * @property {number}   score
 * @property {string}   [shapeType]
 * @property {number[][]} [poly]
 */

/**
 * @typedef {Object} RapidLayoutOutputData
 * @property {LayoutDetBox[]}  boxes
 * @property {string[]}        [class_names]
 * @property {number[]}        [scores]
 * @property {number[][]|null} [polygon_points]
 * @property {number[]|null}   [orders]
 * @property {cv.Mat}          [img]
 * @property {number}          [elapse]
 * @property {Object}          [elapsedTime]
 */

export class RapidLayoutOutput {
  /**
   * @param {RapidLayoutOutputData} data
   */
  constructor(data) {
    /** @type {cv.Mat|null} */
    this.img            = data.img            ?? null;
    /** @type {number[][]} */
    this.boxes          = data.boxes          ?? [];
    /** @type {string[]} */
    this.class_names    = data.class_names    ?? [];
    /** @type {number[]} */
    this.scores         = data.scores         ?? [];
    /** @type {number[][]|null} */
    this.polygon_points = data.polygon_points ?? null;
    /** @type {number[]|null} */
    this.orders         = data.orders         ?? null;
    /** @type {number} */
    this.elapse         = data.elapse         ?? 0;
    /** @type {Object} */
    this.elapsedTime    = data.elapsedTime    ?? {};
  }
}