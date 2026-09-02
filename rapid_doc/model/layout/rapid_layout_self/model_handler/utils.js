/**
 * ModelProcessor: resolves model URLs from embedded model map.
 * Models are served as static assets and cached in IndexedDB by OrtInferSession.create().
 */

import { getLogger } from '../utils/logger.js';

export { ModelType } from '../utils/typings.js';

const logger = getLogger('ModelProcessor');

// Models are served locally from public/models/ (Vite static assets).
// SHA-256 values updated to match locally-patched ONNX files
// (patch_ppdoclayout.py post-processes layout models; hashes reflect patched versions).
// Models not present locally (PP-DocLayout-L/M/S, doclayout_docstructbench, RT-DETR)
// retain their upstream hashes — validate against actual files when deployed.

/** @type {Record<string, {url: string, sha256: string|null}>} */
export const DEFAULT_MODEL_MAP = Object.freeze({
  pp_doclayout_plus_l: {
    url: '/models/layout/PP-DocLayout_plus-L/pp_doclayout_plus_l.onnx',
    // SHA-256 of locally-patched file in public/models/
    sha256: '79583a4b865279d50dd20f6b74436927e91ef6c63dea2f09a8cdb714a7fd09b5',
  },
  pp_doclayoutv2: {
    url: '/models/layout/PP-DocLayoutV2/pp_doclayoutv2.onnx',
    // SHA-256 of locally-patched file in public/models/
    sha256: '6f4cd6e99c9384751923adb02565b5541f19fa8b5a4b4fdc1e24c7c30883d1a0',
  },
  pp_doclayoutv3: {
    url: '/models/layout/PP-DocLayoutV3/pp_doclayoutv3.onnx',
    // SHA-256 of locally-patched file in public/models/
    sha256: '0f5997e6bef6eaaa8b3f2b487106877d55a0b9b218b353895bb3a2df0c6d9393',
  },
  pp_doclayout_l: {
    url: '/models/layout/PP-DocLayout-L/pp_doclayout_l.onnx',
    // TODO: file not present locally — fill in sha256 when model is available
    sha256: null,
  },
  pp_doclayout_m: {
    url: '/models/layout/PP-DocLayout-M/pp_doclayout_m.onnx',
    // TODO: file not present locally — fill in sha256 when model is available
    sha256: null,
  },
  pp_doclayout_s: {
    url: '/models/layout/PP-DocLayout-S/pp_doclayout_s.onnx',
    // TODO: file not present locally — fill in sha256 when model is available
    sha256: null,
  },
  doclayout_docstructbench: {
    url: '/models/layout/doclayout/doclayout_yolo_docstructbench_imgsz1024.onnx',
    // TODO: file not present locally — fill in sha256 when model is available
    sha256: null,
  },
  rt_detr_l_wired_table_cell_det: {
    url: '/models/table/RT-DETR-L_wired_table_cell_det/rt_detr_l_wired_table_cell_det.onnx',
    // TODO: file not present locally — fill in sha256 when model is available
    sha256: null,
  },
  rt_detr_l_wireless_table_cell_det: {
    url: '/models/table/RT-DETR-L_wireless_table_cell_det/rt_detr_l_wireless_table_cell_det.onnx',
    // TODO: file not present locally — fill in sha256 when model is available
    sha256: null,
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
