/**
 * ModelProcessor: resolves model URLs from embedded model map.
 * Models are served as static assets and cached in IndexedDB by OrtInferSession.create().
 */

import { getLogger } from '../utils/logger.js';

export { ModelType } from '../utils/typings.js';

const logger = getLogger('ModelProcessor');

// Models are served locally from public/models/ (Vite static assets).

/** @type {Record<string, {url: string, sha256: string|null}>} */
export const DEFAULT_MODEL_MAP = Object.freeze({
  pp_doclayout_plus_l: {
    url: '/models/layout/PP-DocLayout_plus-L/pp_doclayout_plus_l.onnx',
    sha256: '3e0a48f1eead902e83e04695430597e92207ef50e19b06bdf65f46096ba6bbd3',
  },
  pp_doclayoutv2: {
    url: '/models/layout/PP-DocLayoutV2/pp_doclayoutv2.onnx',
    sha256: '9fedca3a2ebfdce73fc36f7842a4cabe0a4fe8c0ee33a446ca358ed500907b29',
  },
  pp_doclayoutv3: {
    url: '/models/layout/PP-DocLayoutV3/pp_doclayoutv3.onnx',
    sha256: 'b9a2759e51ee2cc9d98f10cea21caf5862043b882b5f57c683eaf6fa247196a3',
  },
  pp_doclayout_l: {
    url: '/models/layout/PP-DocLayout-L/pp_doclayout_l.onnx',
    sha256: '116d4a65052187be1ed408d6286fc5a5a07de361a1c85969d633d7ca56a73c05',
  },
  pp_doclayout_m: {
    url: '/models/layout/PP-DocLayout-M/pp_doclayout_m.onnx',
    sha256: '2e5997712f69e2db59e78fc837e0e3ee9e71cba4d41fa57125e438950f37196d',
  },
  pp_doclayout_s: {
    url: '/models/layout/PP-DocLayout-S/pp_doclayout_s.onnx',
    sha256: '0ae97252feb0d64ee2c70ee0449ec9de4b08140056f32ce3c725c16ca50142e4',
  },
  doclayout_docstructbench: {
    url: '/models/layout/doclayout/doclayout_yolo_docstructbench_imgsz1024.onnx',
    sha256: '3b452baef10ecabd615491bc82cc4d49475fbc2cd7a8e535044f2c6bb28fb9fe',
  },
  rt_detr_l_wired_table_cell_det: {
    url: '/models/table/RT-DETR-L_wired_table_cell_det/rt_detr_l_wired_table_cell_det.onnx',
    sha256: 'd0996593ce241ecc4ea08811a858a2ac1a7e438e3260f98562010fd8efc6951e',
  },
  rt_detr_l_wireless_table_cell_det: {
    url: '/models/table/RT-DETR-L_wireless_table_cell_det/rt_detr_l_wireless_table_cell_det.onnx',
    sha256: '3085db96c666ac5dfb9ae52b119ac4fa739f4a320c71c51fda28bd7fd700807e',
  },
});

export class ModelProcessor {
  /**
   * Return the canonical model URL for a ModelType value.
   * @param {string|import('../utils/typings.js').ModelType} modelType
   * @returns {string} Remote ONNX model URL
   */
  static getModelUrl(modelType) {
    const key = typeof modelType === 'object' ? Object.values(modelType).at(-1) : String(modelType);
    const info = DEFAULT_MODEL_MAP[key];
    if (!info) {
      throw new Error(`Unknown model type: "${key}". Available: ${Object.keys(DEFAULT_MODEL_MAP).join(', ')}`);
    }
    logger.info(`Resolved model URL for "${key}": ${info.url}`);
    return info.url;
  }

  /**
   * Return the SHA-256 checksum for a model type.
   * @param {string|import('../utils/typings.js').ModelType} modelType
   * @returns {string}
   */
  static getModelSha256(modelType) {
    const key = typeof modelType === 'object' ? Object.values(modelType).at(-1) : String(modelType);
    return DEFAULT_MODEL_MAP[key]?.sha256 ?? '';
  }

  /**
   * Return both {url, sha256} for a model type.
   * @param {string|import('../utils/typings.js').ModelType} modelType
   * @returns {{url: string, sha256: string}}
   */
  static getModelInfo(modelType) {
    const key = typeof modelType === 'object' ? Object.values(modelType).at(-1) : String(modelType);
    const info = DEFAULT_MODEL_MAP[key];
    if (!info) throw new Error(`Unknown model type: "${key}"`);
    return { ...info };
  }
}
