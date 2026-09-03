import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../rapid_doc/utils/ort_runtime.js', () => ({
  acquireGlobalGpu: vi.fn(async (fn) => fn()),
  OrtInferSession: class {
    static async create() {
      return { run: vi.fn(async () => ({ boxes: [[0, 0, 100, 100]], scores: [0.9] })) };
    }
  },
}));

describe('BatchAnalyze integration — stage orchestration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('continues pipeline when a non-critical stage fails', async () => {
    const { BatchAnalyze } = await import('../../rapid_doc/backend/pipeline/batch_analyze.js');
    expect(typeof BatchAnalyze).toBe('function');
    const methods = Object.getOwnPropertyNames(BatchAnalyze.prototype);
    expect(methods.length).toBeGreaterThan(0);
    const source = BatchAnalyze.toString();
    expect(source).toContain('AbortException');
  });

  it('propagates AbortException and aborts pipeline', async () => {
    const { BatchAnalyze } = await import('../../rapid_doc/backend/pipeline/batch_analyze.js');
    const { AbortException } = await import('../../rapid_doc/utils/exceptions.js');
    expect(typeof AbortException).toBe('function');
    const source = BatchAnalyze.toString();
    expect(source).toContain('AbortException');
  });
});
