import { describe, it, expect, vi } from 'vitest';
import { yieldToBrowser, formatPipelineError, BrowserPerformanceProfile, detectProfile } from '@rapid_doc/utils/browser_utils.js';

describe('yieldToBrowser', () => {
  it('returns a promise that resolves', async () => {
    const result = await yieldToBrowser();
    expect(result).toBeUndefined();
  });

  it('uses setTimeout with 0ms delay', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const spy = vi.fn((cb, ms) => originalSetTimeout(cb, ms));
    globalThis.setTimeout = spy;

    await yieldToBrowser();

    expect(spy).toHaveBeenCalledWith(expect.any(Function), 0);
    globalThis.setTimeout = originalSetTimeout;
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

describe('BrowserPerformanceProfile', () => {
  it('has three tiers: MOBILE, DESKTOP, HIGH_END', () => {
    expect(BrowserPerformanceProfile).toHaveProperty('MOBILE');
    expect(BrowserPerformanceProfile).toHaveProperty('DESKTOP');
    expect(BrowserPerformanceProfile).toHaveProperty('HIGH_END');
  });

  it('each tier has all required fields', () => {
    for (const tier of Object.values(BrowserPerformanceProfile)) {
      expect(tier).toHaveProperty('MAX_CONCURRENT_BATCHES');
      expect(tier).toHaveProperty('REC_BATCH_NUM');
      expect(tier).toHaveProperty('DPI_DOWNSCALE_THRESHOLD');
      expect(tier).toHaveProperty('PDF_PAGES_BATCH');
    }
  });

  it('tier values are ordered MOBILE < DESKTOP < HIGH_END', () => {
    const { MOBILE, DESKTOP, HIGH_END } = BrowserPerformanceProfile;
    expect(MOBILE.MAX_CONCURRENT_BATCHES).toBeLessThan(DESKTOP.MAX_CONCURRENT_BATCHES);
    expect(DESKTOP.MAX_CONCURRENT_BATCHES).toBeLessThan(HIGH_END.MAX_CONCURRENT_BATCHES);
    expect(MOBILE.DPI_DOWNSCALE_THRESHOLD).toBeLessThan(DESKTOP.DPI_DOWNSCALE_THRESHOLD);
    expect(DESKTOP.DPI_DOWNSCALE_THRESHOLD).toBeLessThan(HIGH_END.DPI_DOWNSCALE_THRESHOLD);
    expect(MOBILE.PDF_PAGES_BATCH).toBeLessThan(DESKTOP.PDF_PAGES_BATCH);
    expect(DESKTOP.PDF_PAGES_BATCH).toBeLessThan(HIGH_END.PDF_PAGES_BATCH);
  });

  it('is frozen (immutable)', () => {
    expect(Object.isFrozen(BrowserPerformanceProfile)).toBe(true);
    expect(Object.isFrozen(BrowserPerformanceProfile.DESKTOP)).toBe(true);
  });
});

describe('detectProfile', () => {
  it('returns DESKTOP when navigator is undefined (Node/SSR env)', () => {
    // In the vitest Node environment, navigator is undefined.
    expect(detectProfile()).toBe(BrowserPerformanceProfile.DESKTOP);
  });

  it('returns MOBILE when navigator.deviceMemory <= 4', () => {
    vi.stubGlobal('navigator', { deviceMemory: 4 });
    try {
      expect(detectProfile()).toBe(BrowserPerformanceProfile.MOBILE);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns MOBILE for very low memory (1 GB)', () => {
    vi.stubGlobal('navigator', { deviceMemory: 1 });
    try {
      expect(detectProfile()).toBe(BrowserPerformanceProfile.MOBILE);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns HIGH_END when navigator.deviceMemory >= 16', () => {
    vi.stubGlobal('navigator', { deviceMemory: 16 });
    try {
      expect(detectProfile()).toBe(BrowserPerformanceProfile.HIGH_END);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns HIGH_END for 32 GB memory', () => {
    vi.stubGlobal('navigator', { deviceMemory: 32 });
    try {
      expect(detectProfile()).toBe(BrowserPerformanceProfile.HIGH_END);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns DESKTOP for mid-range memory (8 GB)', () => {
    vi.stubGlobal('navigator', { deviceMemory: 8 });
    try {
      expect(detectProfile()).toBe(BrowserPerformanceProfile.DESKTOP);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns DESKTOP when navigator exists but deviceMemory is absent', () => {
    vi.stubGlobal('navigator', {}); // no deviceMemory API
    try {
      expect(detectProfile()).toBe(BrowserPerformanceProfile.DESKTOP);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
