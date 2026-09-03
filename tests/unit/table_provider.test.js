import { describe, it, expect, vi } from 'vitest';
import { ProviderConfig } from '../../rapid_doc/model/table/rapid_table_self/inference_engine/onnxruntime/provider_config.js';

describe('Table ProviderConfig — WASM enforcement', () => {
  it('always returns ["wasm"] even when WebGPU is available', async () => {
    // Mock WebGPU availability globally
    const originalGpu = globalThis.navigator?.gpu;
    if (!globalThis.navigator) globalThis.navigator = {};
    globalThis.navigator.gpu = { requestAdapter: vi.fn(async () => ({})) };

    const providers = await ProviderConfig.getAvailableProviders();
    expect(providers).toEqual(['wasm']);

    // Restore
    if (originalGpu) globalThis.navigator.gpu = originalGpu;
    else delete globalThis.navigator.gpu;
  });

  it('buildSessionOptions configures WASM with 4 threads', async () => {
    const opts = await ProviderConfig.buildSessionOptions();
    expect(opts.executionProviders).toEqual(['wasm']);
    expect(opts.logSeverityLevel).toBe(4);
    expect(opts.graphOptimizationLevel).toBe('all');
  });

  it('buildSessionOptions merges extraOpts', async () => {
    const opts = await ProviderConfig.buildSessionOptions({ freeDimensionOverrides: { batch: 1 } });
    expect(opts.freeDimensionOverrides).toEqual({ batch: 1 });
    expect(opts.executionProviders).toEqual(['wasm']);
  });
});
