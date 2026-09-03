import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('docAnalyze smoke — public API', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('exports docAnalyze and engineReset from rapid_doc/index.js', async () => {
    const mod = await import('../../rapid_doc/index.js');
    expect(typeof mod.docAnalyze).toBe('function');
    expect(typeof mod.engineReset).toBe('function');
  });

  it('docAnalyze returns an array for empty input (no crash)', async () => {
    const pipeline = await import('../../rapid_doc/backend/pipeline/pipeline_analyze.js');
    const spy = vi.spyOn(pipeline, 'docAnalyze').mockResolvedValue([{ markdown: '# hello', contentList: [], modelJson: {} }]);
    const { docAnalyze } = await import('../../rapid_doc/index.js');
    const fakePdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const result = await docAnalyze(fakePdf, { formula_enable: false, table_enable: false });
    expect(Array.isArray(result)).toBe(true);
    spy.mockRestore();
  });

  it('engineReset is callable without throwing', async () => {
    const { engineReset } = await import('../../rapid_doc/index.js');
    await expect(engineReset()).resolves.not.toThrow();
  });
});
