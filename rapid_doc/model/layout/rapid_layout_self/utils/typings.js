/**
 * Model type enumerations and the RapidLayoutInput configuration class.
 */

// ─── ModelType ────────────────────────────────────────────────────────────────

/** Supported layout model variants. */
export const ModelType = Object.freeze({
  PP_DOCLAYOUT_PLUS_L:                  'pp_doclayout_plus_l',
  PP_DOCLAYOUTV2:                       'pp_doclayoutv2',
  PP_DOCLAYOUTV3:                       'pp_doclayoutv3',
  PP_DOCLAYOUT_L:                       'pp_doclayout_l',
  PP_DOCLAYOUT_M:                       'pp_doclayout_m',
  PP_DOCLAYOUT_S:                       'pp_doclayout_s',
  DOCLAYOUT_DOCSTRUCTBENCH:             'doclayout_docstructbench',
  RT_DETR_L_WIRED_TABLE_CELL_DET:       'rt_detr_l_wired_table_cell_det',
  RT_DETR_L_WIRELESS_TABLE_CELL_DET:    'rt_detr_l_wireless_table_cell_det',
});

// ─── EngineType ───────────────────────────────────────────────────────────────

/**
 * Supported inference engine types.
 */
export const EngineType = Object.freeze({
  ONNXRUNTIME: 'onnxruntime',
  OPENVINO:    'openvino',
});

// ─── RapidLayoutInput ─────────────────────────────────────────────────────────

/**
 * Configuration for the RapidLayout model.
 */
export class RapidLayoutInput {
  /**
   * @param {Partial<RapidLayoutInput>} [opts]
   */
  constructor({
    model_type        = ModelType.PP_DOCLAYOUTV2,
    modelType         = null, // Support camelCase fallback
    model_dir_or_path = null,
    engine_type       = EngineType.ONNXRUNTIME,
    engine_cfg        = {},
    conf_thresh       = null,
    iou_thresh        = 0.5,
    layout_shape_mode = 'auto',
  } = {}) {
    this.model_type        = modelType || model_type;
    this.model_dir_or_path = model_dir_or_path;
    this.engine_type       = engine_type;
    this.engine_cfg        = engine_cfg;
    this.conf_thresh       = conf_thresh;
    this.iou_thresh        = iou_thresh;
    this.layout_shape_mode = layout_shape_mode;
  }
}

// ─── Per-model confidence thresholds ─────────────────────────────────────────

export const PP_DOCLAYOUT_PLUS_L_Threshold = Object.freeze({
  0: 0.3,  1: 0.5,  2: 0.4,  3: 0.5,  4: 0.5,  5: 0.5,  6: 0.5,  7: 0.3,
  8: 0.5,  9: 0.5,  10: 0.5, 11: 0.5, 12: 0.5, 13: 0.5, 14: 0.5, 15: 0.45,
  16: 0.5, 17: 0.5, 18: 0.5, 19: 0.5,
});

export const PP_DOCLAYOUTV2_Threshold = Object.freeze({
  0: 0.5, 1: 0.5, 2: 0.5, 3: 0.5, 4: 0.5, 5: 0.4, 6: 0.4, 7: 0.5,
  8: 0.5, 9: 0.5, 10: 0.5, 11: 0.5, 12: 0.5, 13: 0.5, 14: 0.5, 15: 0.4,
  16: 0.5, 17: 0.4, 18: 0.5, 19: 0.5, 20: 0.45, 21: 0.5, 22: 0.4, 23: 0.4, 24: 0.5,
});

export const PP_DOCLAYOUT_L_Threshold = Object.freeze({
  0: 0.3, 1: 0.5, 2: 0.4, 3: 0.5, 4: 0.5, 5: 0.5, 6: 0.5, 7: 0.3,
  8: 0.5, 9: 0.5, 10: 0.5, 11: 0.5, 12: 0.5, 13: 0.5, 14: 0.5, 15: 0.5,
  16: 0.45, 17: 0.5, 18: 0.5, 19: 0.5, 20: 0.5, 21: 0.5, 22: 0.5,
});

// ─── Per-model bbox merge modes ──────────────────────────────────────────────

export const PP_DOCLAYOUT_PLUS_L_layout_merge_bboxes_mode = Object.freeze({
  0:  'large', // paragraph_title
  1:  'large', // image
  2:  'union', // text
  3:  'union', // number
  4:  'union', // abstract
  5:  'union', // content
  6:  'union', // figure_table_chart_title
  7:  'large', // formula
  8:  'union', // table
  9:  'union', // reference
  10: 'union', // doc_title
  11: 'union', // footnote
  12: 'union', // header
  13: 'union', // algorithm
  14: 'union', // footer
  15: 'union', // seal
  16: 'large', // chart
  17: 'union', // formula_number
  18: 'union', // aside_text
  19: 'union', // reference_content
});

export const PP_DOCLAYOUTV2_layout_merge_bboxes_mode = Object.freeze({
  0:  'union', // abstract
  1:  'union', // algorithm
  2:  'union', // aside_text
  3:  'large', // chart
  4:  'union', // content
  5:  'large', // display_formula
  6:  'large', // doc_title
  7:  'union', // figure_title
  8:  'union', // footer
  9:  'union', // footer
  10: 'union', // footnote
  11: 'union', // formula_number
  12: 'union', // header
  13: 'union', // header
  14: 'union', // image
  15: 'large', // inline_formula
  16: 'union', // number
  17: 'large', // paragraph_title
  18: 'union', // reference
  19: 'union', // reference_content
  20: 'union', // seal
  21: 'union', // table
  22: 'union', // text
  23: 'union', // text
  24: 'union', // vision_footnote
});

// Re-export output type used by model_handler/doc_layout/main.js
export { RapidLayoutOutput } from '../../../../utils/typings.js';
