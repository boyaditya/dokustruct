// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: ProviderConfig — same as formula version (browser EP detection)

import { configureOrtWasmRuntime } from '../../../../../utils/ort_runtime.js';

export class ProviderConfig {
  static async getAvailableProviders() {
    // Wasm-only: WebGPU is disabled globally (ORT "backend not found" warning).
    return ["wasm"];
  }

  static async buildSessionOptions(extraOpts = {}) {
    const providers = await ProviderConfig.getAvailableProviders();
    configureOrtWasmRuntime({ numThreads: 4 });
    return { executionProviders: providers, logSeverityLevel: 4, graphOptimizationLevel: 'all', ...extraOpts };
  }
}

export default ProviderConfig;
