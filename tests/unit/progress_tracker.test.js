import { describe, it, expect, vi } from 'vitest';
import { ProgressTracker } from '@rapid_doc/backend/pipeline/progress_tracker.js';

describe('ProgressTracker', () => {
  it('initStage and getPercent 0 initially', () => {
    const tracker = new ProgressTracker(null);
    tracker.initStage('layout', 10);
    expect(tracker.getPercent()).toBeGreaterThanOrEqual(0);
    expect(tracker.getStageProgress('layout')).toMatchObject({ current: 0, total: 10 });
  });

  it('ignores total <=0', () => {
    const tracker = new ProgressTracker(null);
    tracker.initStage('layout', 0);
    expect(tracker.getStageProgress('layout')).toBeNull();
    expect(tracker.totalWorkUnits).toBe(0);
  });

  it('update progresses and fires callback with percent capped at 95', () => {
    const cb = vi.fn();
    const tracker = new ProgressTracker(cb);
    tracker.initStage('layout', 10);
    tracker.initStage('table', 10);
    tracker.update('layout', 5);
    expect(cb).toHaveBeenCalled();
    const last = cb.mock.calls.at(-1);
    expect(last[0]).toBe('layout');
    expect(last[1]).toBe(5);
    expect(last[3]).toBeGreaterThanOrEqual(0);
    expect(last[3]).toBeLessThanOrEqual(95);
  });

  it('auto-initializes stage on update if not exists', () => {
    const cb = vi.fn();
    const tracker = new ProgressTracker(cb);
    tracker.update('ocr_det', 3, 10);
    expect(tracker.getStageProgress('ocr_det')).not.toBeNull();
    expect(tracker.getStageProgress('ocr_det').current).toBe(3);
  });

  it('does nothing when update unknown stage without total', () => {
    const tracker = new ProgressTracker(null);
    tracker.update('unknown', 5);
    expect(tracker.getStageProgress('unknown')).toBeNull();
  });

  it('complete(stage) marks single stage complete', () => {
    const cb = vi.fn();
    const tracker = new ProgressTracker(cb);
    tracker.initStage('layout', 10);
    tracker.update('layout', 5);
    tracker.complete('layout');
    expect(tracker.getStageProgress('layout').current).toBe(10);
  });

  it('complete() fires 100% overall', () => {
    const cb = vi.fn();
    const tracker = new ProgressTracker(cb);
    tracker.initStage('layout', 10);
    tracker.complete();
    expect(cb).toHaveBeenCalledWith('complete', 1, 1, 100);
  });

  it('getPercent 0 when no stages', () => {
    const tracker = new ProgressTracker(null);
    expect(tracker.getPercent()).toBe(0);
  });

  it('reset clears state', () => {
    const tracker = new ProgressTracker(null);
    tracker.initStage('layout', 10);
    tracker.update('layout', 10);
    tracker.reset();
    expect(tracker.totalWorkUnits).toBe(0);
    expect(tracker.getPercent()).toBe(0);
    expect(tracker.getStageProgress('layout')).toBeNull();
  });

  it('getDebugInfo returns structure', () => {
    const tracker = new ProgressTracker(null);
    tracker.initStage('layout', 5);
    tracker.update('layout', 2);
    const info = tracker.getDebugInfo();
    expect(info.stages).toBeDefined();
    expect(typeof info.overallPercent).toBe('number');
    expect(info.totalWorkUnits).toBeGreaterThan(0);
  });

  it('stage weights respected (formula heavier than orientation)', () => {
    const t1 = new ProgressTracker(null);
    t1.initStage('orientation', 10);
    t1.initStage('formula', 10);
    // formula weight 0.18 vs orientation 0.02 → formula contributes 9× more
    expect(t1.stages['formula'].weightedTotal).toBeGreaterThan(t1.stages['orientation'].weightedTotal);
  });

  it('update with new total adjusts totalWorkUnits', () => {
    const tracker = new ProgressTracker(null);
    tracker.initStage('layout', 10);
    const before = tracker.totalWorkUnits;
    tracker.update('layout', 5, 20); // change total 10→20
    expect(tracker.totalWorkUnits).not.toBe(before);
    expect(tracker.getStageProgress('layout').total).toBe(20);
  });
});
