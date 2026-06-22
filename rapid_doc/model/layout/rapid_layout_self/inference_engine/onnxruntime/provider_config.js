/**
 * PORTING NOTE: inference_engine/onnxruntime/provider_config.py → provider_config.js
 *
 * WORKAROUND: Python checks CUDA / DirectML / CANN execution providers via
 *             onnxruntime.get_available_providers() and platform detection.
 * REASON: None of those native GPU backends exist in the browser. ort-web
 *         exposes exactly two execution providers: 'webgpu' and 'wasm'.
 * SOLUTION:
 *   - EP enum → Object.freeze() with browser EP names ('webgpu', 'wasm')
 *   - CUDA check → isWebGpuAvailable() via `navigator.gpu`
 *   - DirectML / CANN checks → always false in browser (logged as info)
 *   - get_ep_list() → returns ort-web-compatible executionProviders array
 *     in priority order: [webgpu (if available), wasm-cpu fallback]
 *   - ProviderConfig constructor stays synchronous (no async needed for
 *     browser EP detection)
 *   - verify_providers() logic retained — warns if expected EP wasn't chosen
 *
 * AFFECTED METHODS:
 *   EP (Enum)              → EP (Object.freeze)
 *   ProviderConfig.__init__ → constructor(engineCfg)         [sync]
 *   get_ep_list()           → getEpList()  [returns string[] for ort-web]
 *   is_cuda_available()     → isWebGpuAvailable()
 *   is_dml_available()      → always false
 *   is_cann_available()     → always false
 *   verify_providers()      → verifyProviders(sessionProviders)
 */

import { getLogger } from '../../../../../utils/logger.js';

const logger = getLogger('provider_config');

// ─── EP enum (browser ort-web execution provider names) ──────────────────────

/**
 * @readonly
 * @enum {string}
 */
export const EP = Object.freeze({
  /** WebAssembly CPU backend — always available */
  WASM_EP:   'wasm',
  /** WebGPU backend — available when navigator.gpu exists */
  WEBGPU_EP: 'webgpu',

  // Kept for API parity with Python enum (never selected in browser):
  CPU_EP:       'CPUExecutionProvider',    // Python: CPUExecutionProvider
  CUDA_EP:      'CUDAExecutionProvider',   // Python: CUDAExecutionProvider
  DIRECTML_EP:  'DmlExecutionProvider',    // Python: DmlExecutionProvider
  CANN_EP:      'CANNExecutionProvider',   // Python: CANNExecutionProvider
});

// ─── ProviderConfig ───────────────────────────────────────────────────────────

export class ProviderConfig {
  /**
   * @param {Object} engineCfg - Plain JS object (parsed from engine_cfg.yaml)
   */
  constructor(engineCfg) {
    this.logger = logger;

    // Browser ort-web always has wasm; webgpu depends on the device
    this.hadProviders = ['wasm'];
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      this.hadProviders.unshift('webgpu');
    }

    this.defaultProvider = this.hadProviders[0];

    // Read config flags (mapped from Python naming, all false in browser by default)
    this.cfgUseWebGpu = engineCfg?.use_webgpu ?? true;   // enable WebGPU when available
    // Python cuda/dml/cann → all treated as "native GPU" → mapped to WebGPU
    this.cfgUseCuda  = engineCfg?.use_cuda  ?? false;
    this.cfgUseDml   = engineCfg?.use_dml   ?? false;
    this.cfgUseCann  = engineCfg?.use_cann  ?? false;

    this.cfg = engineCfg ?? {};
  }

  // ── Provider availability checks ───────────────────────────────────────────

  /**
   * Mirrors is_cuda_available() — checks WebGPU availability in the browser.
   * If use_cuda (or use_webgpu) is false in config, always returns false.
   * @returns {boolean}
   */
  isWebGpuAvailable() {
    const gpuEnabled = this.cfgUseWebGpu || this.cfgUseCuda;
    if (!gpuEnabled) return false;

    if (typeof navigator !== 'undefined' && navigator.gpu !== undefined) {
      return true;
    }

    this.logger.warning(
      'WebGPU (navigator.gpu) is not available in this browser. ' +
      `Falling back to ${this.defaultProvider}.`,
    );
    return false;
  }

  /**
   * DirectML is not available in the browser.
   * @returns {false}
   */
  isDmlAvailable() {
    if (this.cfgUseDml) {
      this.logger.info(
        'DirectML (DmlExecutionProvider) is a Windows-native backend and is not ' +
        'available in the browser. Inference will use WebGPU or WASM instead.',
      );
    }
    return false;
  }

  /**
   * CANN (Huawei Ascend) is not available in the browser.
   * @returns {false}
   */
  isCannAvailable() {
    if (this.cfgUseCann) {
      this.logger.info(
        'CANNExecutionProvider is a Huawei Ascend backend and is not available ' +
        'in the browser. Inference will use WebGPU or WASM instead.',
      );
    }
    return false;
  }

  // ── getEpList ─────────────────────────────────────────────────────────────

  /**
   * Return the ordered list of ort-web execution providers.
   * Matches Python: get_ep_list() → List[Tuple[str, Dict]]
   *
   * In ort-web, executionProviders is a string[] or {name, ...options}[].
   * We return an array compatible with ort.InferenceSession.create()'s
   * `executionProviders` option.
   *
   * Priority (highest first):
   *   1. webgpu  — if navigator.gpu is present and config allows GPU
   *   2. wasm    — always last (CPU fallback)
   *
   * LAYOUT MODEL OPTIMIZATION:
   *   Layout models support batching [N, 3, H, W] where:
   *   - PP-DocLayout: 640×640 or 800×800 per image
   *   - DocLayout YOLO: 1024×1024 per image
   *   - Typical batch: 1-4 pages processed together
   *   
   *   WebGPU benefits:
   *   - Batched inference amortizes kernel launch overhead
   *   - Medium-sized images (640-1024) benefit from GPU parallelism
   *   - Similar to OCR pattern (batching multiple images)
   *
   * @returns {(string | { name: string, [key: string]: any })[]}
   */
  getEpList() {
    if (this.isWebGpuAvailable()) {
      return [EP.WEBGPU_EP, EP.WASM_EP];
    }
    return [EP.WASM_EP];
  }

  // ── verifyProviders ───────────────────────────────────────────────────────

  /**
   * Warn if the session did not select the highest-priority expected provider.
   * Matches Python: verify_providers(session_providers)
   *
   * @param {string[]} sessionProviders - Providers reported by the ort session
   */
  verifyProviders(sessionProviders) {
    if (!sessionProviders || sessionProviders.length === 0) {
      throw new Error('Session providers list is empty');
    }

    const firstProvider = sessionProviders[0];
    const expectedEpList = this.getEpList();
    const expectedFirst = expectedEpList[0];

    if (typeof expectedFirst === 'object') {
      if (firstProvider !== expectedFirst.name) {
        this.logger.warning(
          `Expected primary provider '${expectedFirst.name}' but session is using '${firstProvider}'. ` +
          `Available: ${JSON.stringify(sessionProviders)}`,
        );
      }
    } else if (firstProvider !== expectedFirst) {
      this.logger.warning(
        `Expected primary provider '${expectedFirst}' but session is using '${firstProvider}'. ` +
        `Available: ${JSON.stringify(sessionProviders)}`,
      );
    }
  }

  // ── Logging helper (matches Python print_log) ─────────────────────────────

  /**
   * @param {string[]} logList
   */
  printLog(logList) {
    for (const msg of logList) {
      this.logger.info(msg);
    }
  }
}
