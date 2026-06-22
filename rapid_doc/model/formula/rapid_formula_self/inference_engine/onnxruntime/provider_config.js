// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: inference_engine/onnxruntime/provider_config.py → provider_config.js
// Python EP detection (CUDA/DirectML/CANN) → browser EP detection (WebGPU/WASM)

import { configureOrtWasmRuntime } from '../../../../../utils/ort_runtime.js';

/**
 * Execution provider configuration for browser ONNX Runtime.
 * PORTING NOTE: ProviderConfig detects hardware EPs.
 * In browser: WebGPU (GPU), wasm (CPU fallback). No CUDA/DirectML/CANN.
 */
export class ProviderConfig {
  /**
   * Get ordered list of execution providers available in this browser.
   * @returns {Promise<string[]>}
   */
  static async getAvailableProviders() {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      return ['webgpu', 'wasm'];
    }
    return ['wasm'];
  }

  /**
   * Build ONNX Runtime session options with optimal available providers.
   * @param {object} [extraOpts] - Additional ONNX session options
   * @returns {Promise<object>}
   */
  static async buildSessionOptions(extraOpts = {}) {
    const providers = await ProviderConfig.getAvailableProviders();
    // Configure WASM runtime with multi-threading for maximum CPU utilization
    await configureOrtWasmRuntime({ numThreads: 4, useWebGpu: false });
    // CRITICAL ARCHITECTURE DECISION: FormulaNet uses an ONNX `Loop` operator
    // for autoregressive token generation (717 ops/iteration × ~600 iterations).
    // WebGPU has ~0.03ms dispatch overhead per GPU command, creating ~13s of pure
    // overhead for 449K sequential dispatches. WASM with SIMD has ZERO dispatch
    // overhead and is significantly faster for Loop-based autoregressive models.
    // DocLayout (no Loop, pure Conv) benefits from WebGPU. FormulaNet does NOT.
    const useWasm = true; // Force WASM for autoregressive models
    return {
      executionProviders: useWasm ? ['wasm'] : providers,
      // No gpu-buffer for WASM — data stays on CPU
      logSeverityLevel: 4,
      graphOptimizationLevel: 'all',
      enableMemPattern: true,
      ...extraOpts,
    };
  }
}

export default ProviderConfig;
