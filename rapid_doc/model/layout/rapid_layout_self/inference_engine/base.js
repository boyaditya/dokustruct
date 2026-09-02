/**
 * InferSession abstract base class and engine factory.
 *
 * BROWSER WORKAROUND: engine_cfg is embedded as a plain JS constant (no I/O at import).
 * Only ONNXRUNTIME is supported in the browser; OpenVINO throws a clear error.
 */

import { getLogger } from '../../../../utils/logger.js';
import { EngineType } from '../../../../utils/typings.js';

const logger = getLogger('inference_engine.base');

// ─── Embedded engine_cfg (mirrors engine_cfg.yaml) ───────────────────────────

export const DEFAULT_ENGINE_CFG = Object.freeze({
  onnxruntime: {
    intra_op_num_threads: -1,
    inter_op_num_threads: -1,
    enable_cpu_mem_arena: false,

    cpu_ep_cfg: {
      arena_extend_strategy: 'kSameAsRequested',
    },

    use_cuda: false,
    cuda_ep_cfg: {
      device_id: 0,
      arena_extend_strategy: 'kNextPowerOfTwo',
      gpu_mem_limit: 21474836480,
      cudnn_conv_algo_search: 'EXHAUSTIVE',
      do_copy_in_default_stream: true,
    },

    use_dml: false,
    dm_ep_cfg: null,

    use_cann: false,
    cann_ep_cfg: {
      device_id: 0,
      arena_extend_strategy: 'kNextPowerOfTwo',
      npu_mem_limit: 21474836480,
      op_select_impl_mode: 'high_performance',
      optypelist_for_implmode: 'Gelu',
      enable_cann_graph: true,
    },
  },

  // openvino block kept for completeness; not used in browser
  openvino: {
    inference_num_threads: -1,
    performance_hint: null,
    performance_num_requests: -1,
    enable_cpu_pinning: null,
    num_streams: -1,
    enable_hyper_threading: null,
    scheduling_core_type: null,
  },
});

// ─── Optional async loader (override from URL) ────────────────────────────────

/**
 * Fetch and parse engine_cfg.yaml from a URL.
 * Falls back to DEFAULT_ENGINE_CFG on any error.
 * @param {string} url
 * @returns {Promise<Object>}
 */
export async function loadEngineCfg(url) {
  try {
    const { default: jsyaml } = await import('js-yaml');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    return jsyaml.load(text);
  } catch (err) {
    logger.warning(`loadEngineCfg failed (${err.message}), using embedded defaults`);
    return structuredClone
      ? structuredClone(DEFAULT_ENGINE_CFG)
      : JSON.parse(JSON.stringify(DEFAULT_ENGINE_CFG));
  }
}

// ─── setNestedKey helper ──────────────────────────────────────────────────────

/**
 * Set a value at a dotted-key path inside an object, creating intermediate
 * objects as needed. Matches OmegaConf Python semantics for flat overrides
 * such as `cuda_ep_cfg.device_id`.
 *
 * @param {Object} obj - Target object (mutated in-place)
 * @param {string} dotPath - Dot-separated key path, e.g. "cuda_ep_cfg.device_id"
 * @param {*} value - Value to set at the leaf
 */
export function setNestedKey(obj, dotPath, value) {
  const parts = dotPath.split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cursor[part] === null || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

// ─── InferSession abstract base class ────────────────────────────────────────

export class InferSession {
  /** Subclasses must use a `static async create(cfg)` factory pattern. */
  constructor() {
    this.engineCfg = null;
  }

  /**
   * Run inference.
   * @param {Float32Array} inputContent - NCHW tensor
   * @param {Float32Array|null} [scaleFactor]
   * @returns {Promise<any[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async run(inputContent, scaleFactor = null) {
    throw new Error(`${this.constructor.name}.run() is not implemented`);
  }

  /**
   * @param {string} [key='character']
   * @returns {boolean}
   */
  // eslint-disable-next-line no-unused-vars
  haveKey(key = 'character') {
    throw new Error(`${this.constructor.name}.haveKey() is not implemented`);
  }

  /**
   * @param {string} [key='character']
   * @returns {string[]}
   */
  // eslint-disable-next-line no-unused-vars
  getCharacterList(key = 'character') {
    throw new Error(`${this.constructor.name}.getCharacterList() is not implemented`);
  }

  /** @returns {string[]} */
  get characters() {
    return this.getCharacterList();
  }

  // ── Input / output name helpers ─────────────────────────────────────────────

  /** @returns {string[]} */
  getInputNames() {
    throw new Error(`${this.constructor.name}.getInputNames() is not implemented`);
  }

  /** @returns {string[]} */
  getOutputNames() {
    throw new Error(`${this.constructor.name}.getOutputNames() is not implemented`);
  }

  // ── Static utilities ───────────────────────────────────────────────────────

  /**
   * Validate a model URL.
   * Throws if the URL is null / empty / not a string.
   * @param {string|null} modelUrl
   */
  static _verifyModel(modelUrl) {
    if (!modelUrl || typeof modelUrl !== 'string' || modelUrl.trim() === '') {
      throw new Error('modelUrl is null, empty or not a string.');
    }
  }

  /**
   * Merge override params into a config object (deep-merge).
   * Supports dotted-key paths (e.g. "cuda_ep_cfg.device_id") that expand to
   * nested object traversal, matching OmegaConf Python semantics.
   * @param {Object} cfg - Base config
   * @param {Object} params - Override params (may contain dotted-key keys)
   * @returns {Object}
   */
  static updateParams(cfg, params) {
    if (!params || Object.keys(params).length === 0) return cfg;

    const result = { ...cfg };
    for (const [k, v] of Object.entries(params)) {
      // Support dotted-key paths (matches OmegaConf Python semantics)
      if (k.includes('.')) {
        setNestedKey(result, k, v);
      } else if (v !== null && typeof v === 'object' && !Array.isArray(v) &&
          result[k] !== null && typeof result[k] === 'object') {
        result[k] = InferSession.updateParams(result[k], v);
      } else {
        result[k] = v;
      }
    }
    return result;
  }
}

// ─── getEngine factory ────────────────────────────────────────────────────────

/**
 * Return the concrete InferSession subclass for the requested engine type.
 * Only ONNXRUNTIME is supported in the browser.
 * @param {string} engineType - One of EngineType.*
 * @returns {Promise<typeof InferSession>}
 */
export async function getEngine(engineType) {
  logger.info(`Using engine_name: ${engineType}`);

  if (engineType === EngineType.ONNXRUNTIME) {
    const { OrtInferSession } = await import('./onnxruntime/main.js');
    return OrtInferSession;
  }

  if (engineType === EngineType.OPENVINO) {
    throw new Error(
      'OpenVINO execution provider is not supported in the browser. ' +
      'Use EngineType.ONNXRUNTIME with the WebGPU or WASM backend instead.',
    );
  }

  throw new Error(`Unsupported engine type: ${engineType}`);
}
