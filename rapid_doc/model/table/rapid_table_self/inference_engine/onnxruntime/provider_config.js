// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: ProviderConfig — same as formula version (browser EP detection)

import { configureOrtWasmRuntime } from '../../../../../utils/ort_runtime.js';

export class ProviderConfig {
  static async getAvailableProviders(extraOpts = {}) {
    // Table models historically forced WASM ("ORT backend not found" warning).
    // The user's execution-provider selection was therefore ignored. Honor it
    // now: when the engine config asks for WebGPU (and the browser has it),
    // try WebGPU first — ORT silently falls back to WASM if the model graph
    // contains unsupported ops, so this is safe.
    const useWebGpu = extraOpts?.use_webgpu === true
      && typeof navigator !== 'undefined'
      && Boolean(navigator.gpu);
    if (useWebGpu) return ['webgpu', 'wasm'];
    return ['wasm'];
  }

  static async buildSessionOptions(extraOpts = {}) {
    const providers = await ProviderConfig.getAvailableProviders(extraOpts);
    const useWebGpu = providers.includes('webgpu');
    configureOrtWasmRuntime({ numThreads: 4, useWebGpu });
    return { executionProviders: providers, logSeverityLevel: 4, graphOptimizationLevel: 'all', ...extraOpts };
  }
}

export default ProviderConfig;
