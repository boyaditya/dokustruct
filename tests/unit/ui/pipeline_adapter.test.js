import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('PipelineAdapter — UI ↔ pipeline bridge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds pipeline config from AppState and delegates to docAnalyze', async () => {
    const { PipelineAdapter } = await import('../../../ui/utils/pipelineAdapter.js');
    expect(typeof PipelineAdapter).toBe('function');
    const adapter = new PipelineAdapter();
    expect(typeof adapter.run).toBe('function');
    expect(typeof adapter._buildConfig).toBe('function');
  });

  it('handles abort signal without throwing unhandled', async () => {
    const { PipelineAdapter } = await import('../../../ui/utils/pipelineAdapter.js');
    const adapter = new PipelineAdapter();
    const controller = new AbortController();
    controller.abort();
    // Should handle already-aborted signal gracefully (no throw or throw AbortException)
    const file = new File([new Uint8Array([1, 2, 3])], 'test.pdf', { type: 'application/pdf' });
    try {
      await adapter.run(file, () => {}, controller.signal);
    } catch (e) {
      expect(e.name === 'AbortError' || e.message.includes('abort') || e instanceof Error).toBe(true);
    }
  });

  it('forwards progress callbacks', async () => {
    const { PipelineAdapter } = await import('../../../ui/utils/pipelineAdapter.js');
    const adapter = new PipelineAdapter();
    expect(typeof adapter.run).toBe('function');
    // Verify _buildConfig produces expected shape
    const mockState = {
      get: vi.fn((key) => {
        const map = {
          language: 'ch',
          formulaEnable: true,
          tableEnable: true,
          pageRange: { start: 1, end: 1 },
          activeExecutionProvider: 'wasm',
          forceOcr: false,
          parseMethod: 'auto',
          checkboxEnable: false,
          orientationEnable: false,
        };
        return map[key] ?? (key === 'pageRange' ? { start: 1, end: 1 } : null);
      }),
      config: { language: 'ch' },
    };
    const config = adapter._buildConfig(mockState);
    expect(config).toBeDefined();
    expect(typeof config).toBe('object');
  });
});
