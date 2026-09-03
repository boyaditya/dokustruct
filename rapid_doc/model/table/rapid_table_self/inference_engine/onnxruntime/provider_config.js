// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: ProviderConfig — same as formula version (browser EP detection)

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
    // Table is always WASM - don't reconfigure global ORT runtime here.
    // The global configureOrtRuntime (called once per pipeline) already
    // handles wasmPaths/numThreads. Re-configuring with useWebGpu:false
    // would clobber the shared WebGPU device for layout/ocr when table
    // is toggled, causing "WebGPU device lost" or provider mismatch.
    return { executionProviders: providers, logSeverityLevel: 4, graphOptimizationLevel: 'all', ...extraOpts };
  }
}

export default ProviderConfig;
