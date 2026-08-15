// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: ProviderConfig — same as formula version (browser EP detection)

import { configureOrtWasmRuntime } from '../../../../../utils/ort_runtime.js';

export class ProviderConfig {
  static async getAvailableProviders() {
    // Table models (UNET, SLANet-Plus, table classifiers) run measurably
    // slower on WebGPU than on multi-threaded WASM: their tensors are small
    // and WebGPU per-dispatch overhead never amortizes. Force WASM for the
    // entire table pipeline regardless of the global EP selection.
    return ["wasm"];
  }

  static async buildSessionOptions(extraOpts = {}) {
    const providers = await ProviderConfig.getAvailableProviders();
    configureOrtWasmRuntime({ numThreads: 4, useWebGpu: false });
    return { executionProviders: providers, logSeverityLevel: 4, graphOptimizationLevel: 'all', ...extraOpts };
  }
}

export default ProviderConfig;
