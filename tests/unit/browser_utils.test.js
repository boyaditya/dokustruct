import { describe, it, expect, vi } from 'vitest';
import { yieldToBrowser, formatPipelineError } from '@rapid_doc/utils/browser_utils.js';

describe('yieldToBrowser', () => {
  it('returns a promise that resolves', async () => {
    const result = await yieldToBrowser();
    expect(result).toBeUndefined();
  });

  it('yields asynchronously (does not resolve synchronously)', async () => {
    let resolved = false;
    const p = yieldToBrowser().then(() => { resolved = true; });
    // Must not have resolved within the same synchronous tick.
    expect(resolved).toBe(false);
    await p;
    expect(resolved).toBe(true);
  });

  it('prefers MessageChannel over setTimeout when available (avoids background-tab throttling)', async () => {
    if (typeof MessageChannel !== 'function') {
      // Environment without MessageChannel: falls back to setTimeout.
      const originalSetTimeout = globalThis.setTimeout;
      const spy = vi.fn((cb, ms) => originalSetTimeout(cb, ms));
      globalThis.setTimeout = spy;
      await yieldToBrowser();
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 0);
      globalThis.setTimeout = originalSetTimeout;
      return;
    }
    // MessageChannel present: setTimeout must NOT be used for yielding.
    const originalSetTimeout = globalThis.setTimeout;
    const spy = vi.fn((cb, ms) => originalSetTimeout(cb, ms));
    globalThis.setTimeout = spy;
    await yieldToBrowser();
    expect(spy).not.toHaveBeenCalled();
    globalThis.setTimeout = originalSetTimeout;
  });

  it('resolves multiple concurrent yields (FIFO drain)', async () => {
    const order = [];
    await Promise.all([
      yieldToBrowser().then(() => order.push(1)),
      yieldToBrowser().then(() => order.push(2)),
      yieldToBrowser().then(() => order.push(3)),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('formatPipelineError', () => {
  it('formats a full error with all fields', () => {
    const result = formatPipelineError({
      stage: 'layout',
      module: 'BatchAnalyze',
      message: 'Model inference failed',
      pageIndex: 3,
      recoverable: true,
    });
    expect(result).toBe('[BatchAnalyze] layout: Model inference failed (page 3) [recoverable]');
  });

  it('formats a non-recoverable error', () => {
    const result = formatPipelineError({
      stage: 'ocr',
      module: 'OcrProcessor',
      message: 'Session destroyed',
      pageIndex: 0,
      recoverable: false,
    });
    expect(result).toBe('[OcrProcessor] ocr: Session destroyed (page 0) [non-recoverable]');
  });

  it('omits page index when not provided', () => {
    const result = formatPipelineError({
      stage: 'formula',
      module: 'FormulaModel',
      message: 'Load failed',
      recoverable: true,
    });
    expect(result).toBe('[FormulaModel] formula: Load failed [recoverable]');
  });

  it('handles undefined module gracefully', () => {
    const result = formatPipelineError({
      stage: 'table',
      module: undefined,
      message: 'Timeout',
      recoverable: false,
    });
    expect(result).toBe('[Unknown] table: Timeout [non-recoverable]');
  });

  it('handles null pageIndex (omits it)', () => {
    const result = formatPipelineError({
      stage: 'postprocess',
      module: 'Pipeline',
      message: 'Merge error',
      pageIndex: null,
      recoverable: true,
    });
    expect(result).toBe('[Pipeline] postprocess: Merge error [recoverable]');
  });

  it('handles pageIndex of 0 (includes it)', () => {
    const result = formatPipelineError({
      stage: 'layout',
      module: 'Detector',
      message: 'Low confidence',
      pageIndex: 0,
      recoverable: true,
    });
    expect(result).toBe('[Detector] layout: Low confidence (page 0) [recoverable]');
  });

  it('handles empty message', () => {
    const result = formatPipelineError({
      stage: 'ocr',
      module: 'OcrModel',
      message: '',
      recoverable: false,
    });
    expect(result).toBe('[OcrModel] ocr: [non-recoverable]');
  });

  it('handles missing stage', () => {
    const result = formatPipelineError({
      stage: '',
      module: 'Pipeline',
      message: 'Unknown error',
      recoverable: true,
    });
    expect(result).toBe('[Pipeline] Unknown error [recoverable]');
  });
});
