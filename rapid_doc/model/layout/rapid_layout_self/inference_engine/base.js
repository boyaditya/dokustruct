/**
 * PORTING NOTE: inference_engine/base.py → base.js
 *
 * WORKAROUND: Python uses ABC (abstract base class) with static class-level
 *             OmegaConf.load(engine_cfg.yaml) executed at import time.
 * REASON:
 *   1. JavaScript has no abstract class enforcement — we simulate with runtime
 *      throws in method bodies.
 *   2. fetch() is async — cannot be called at module scope synchronously.
 * SOLUTION:
 *   - engine_cfg is embedded as a plain JS constant (mirrors the YAML content)
 *     so no I/O is needed at import time.  An `async loadEngineCfg(url)` helper
 *     is also exported to allow overriding the config from a remote YAML at
 *     runtime (used by OrtInferSession.create()).
 *   - `_verify_model(modelPath)` filesystem check → replaced by a URL
 *     well-formedness check (fetch will surface errors naturally).
 *   - OpenVINO engine type is kept in getEngine() but throws an
 *     "unsupported in browser" error.
 *   - `import_package` (importlib) → dynamic `import()`.
 *
 * AFFECTED METHODS:
 *   InferSession.__init__        → constructor() [no-op; use static create()]
 *   InferSession.__call__        → async run(inputContent, scaleFactor)
 *   InferSession._verify_model   → static _verifyModel(modelUrl) [URL check]
 *   InferSession.update_params   → static updateParams(cfg, params)
 *   InferSession.get_character_list → getCharacterList(key)
 *   InferSession.have_key        → haveKey(key)
 *   get_engine()                 → getEngine(engineType)
 */

import { getLogger } from '../../../../utils/logger.js';
import { EngineType } from '../../../../utils/typings.js';

const logger = getLogger('inference_engine.base');

// ─── Embedded engine_cfg (mirrors engine_cfg.yaml) ───────────────────────────
//
// Embedded here so the module loads synchronously with no I/O.
// OrtInferSession.create() may override this with a fetched version.

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
 * Fetch and parse engine_cfg.yaml from a URL, returning a plain JS object.
 * Falls back to DEFAULT_ENGINE_CFG on any error.
 *
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

// ─── InferSession abstract base class ────────────────────────────────────────

export class InferSession {
  /**
   * Subclasses must NOT call model loading logic here.
   * Use a `static async create(cfg)` factory pattern instead.
   */
  constructor() {
    // Engine config — populated by subclass create() after loading
    this.engineCfg = null;
  }

  // ── Abstract method stubs (throw if not overridden) ────────────────────────

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

  // ── Input / output name helpers (overridden by OrtInferSession) ────────────

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
   * Validate a model URL (replaces Python filesystem _verify_model).
   * Throws if the URL is null / empty / not a string.
   * Actual reachability is verified naturally when the buffer is fetched.
   *
   * @param {string|null} modelUrl
   */
  static _verifyModel(modelUrl) {
    if (!modelUrl || typeof modelUrl !== 'string' || modelUrl.trim() === '') {
      throw new Error('modelUrl is null, empty or not a string.');
    }
  }

  /**
   * Merge override params into a config object (replaces OmegaConf.update).
   * Deep-merges `params` into a shallow copy of `cfg`.
   *
   * @param {Object} cfg    - Base config (plain JS object)
   * @param {Object} params - Override params
   * @returns {Object}
   */
  static updateParams(cfg, params) {
    if (!params || Object.keys(params).length === 0) return cfg;

    const result = { ...cfg };
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v) &&
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
 * Mirrors Python: get_engine(engine_type)
 *
 * Browser note: only ONNXRUNTIME is supported.
 * OpenVINO is explicitly refused with a clear error message.
 *
 * @param {string} engineType - One of EngineType.*
 * @returns {Promise<typeof InferSession>}  The constructor (not an instance)
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
