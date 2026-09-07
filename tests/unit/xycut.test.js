import { describe, it, expect } from 'vitest';
import {
  projectionByBboxes,
  splitProjectionProfile,
  sortByXycut,
  xycutPlusSort,
  getBboxDirection,
  calculateTextLineDirection,
  recursiveYxCut,
  recursiveXyCut,
} from '@rapid_doc/model/reading_order/xycut_plus.js';

describe('xycut — projectionByBboxes', () => {
  it('empty returns empty', () => {
    expect(projectionByBboxes([], 0).length).toBe(0);
    expect(projectionByBboxes(null, 1).length).toBe(0);
  });
  it('single box projects correctly on x and y', () => {
    const box = [10, 20, 30, 40];
    const projX = projectionByBboxes([box], 0);
    // x 10..30 should have count 1
    expect(projX[10]).toBe(1);
    expect(projX[29]).toBe(1);
    expect(projX[30] ?? 0).toBe(0);
    const projY = projectionByBboxes([box], 1);
    expect(projY[20]).toBe(1);
    expect(projY[39]).toBe(1);
  });
  it('two overlapping boxes accumulate', () => {
    const boxes = [[0, 0, 10, 10], [5, 0, 15, 10]];
    const proj = projectionByBboxes(boxes, 0);
    // 5..9 overlap → 2
    expect(proj[5]).toBe(2);
    expect(proj[0]).toBe(1);
  });
});

describe('xycut — splitProjectionProfile', () => {
  it('null when no significant indices', () => {
    expect(splitProjectionProfile(new Int32Array([0, 0, 0]), 0, 1)).toBeNull();
    expect(splitProjectionProfile(new Int32Array([]), 0, 1)).toBeNull();
  });
  it('splits contiguous segments', () => {
    // [1,1,0,1,1] with minValue 0, minGap 1 → two segments: 0-1 and 3-4
    // significant = [0,1,3,4]; gap 3-1=2 >1 → ends=[1,5]
    const arr = new Int32Array([1, 1, 0, 1, 1]);
    const [starts, ends] = splitProjectionProfile(arr, 0, 1);
    expect(starts).toEqual([0, 3]);
    expect(ends).toEqual([1, 5]);
  });
  it('single segment when no gap', () => {
    const arr = new Int32Array([1, 1, 1]);
    const [starts, ends] = splitProjectionProfile(arr, 0, 1);
    expect(starts).toEqual([0]);
    expect(ends).toEqual([3]);
  });
  it('respects minGap', () => {
    const arr = new Int32Array([1, 0, 1]);
    // gap =2 (indices 0 and 2, diff 2 > minGap 1 → split, but diff 2 >1 → two segments)
    const res = splitProjectionProfile(arr, 0, 1);
    expect(res[0].length).toBe(2);
    const res2 = splitProjectionProfile(arr, 0, 2);
    // gap 2 not >2 → single segment
    expect(res2[0].length).toBe(1);
  });
});

describe('xycut — getBboxDirection / calculateTextLineDirection', () => {
  it('getBboxDirection horizontal when w>=h', () => {
    expect(getBboxDirection(100, 50)).toBe('horizontal');
    expect(getBboxDirection(50, 50)).toBe('horizontal');
    expect(getBboxDirection(50, 100)).toBe('vertical');
  });
  it('respects directionRatio', () => {
    // w=60 h=100, ratio 1.0 → 60<100 vertical, ratio 2.0 → 120>=100 horizontal
    expect(getBboxDirection(60, 100, 1.0)).toBe('vertical');
    expect(getBboxDirection(60, 100, 2.0)).toBe('horizontal');
  });
  it('calculateTextLineDirection majority horizontal', () => {
    const boxes = [[0, 0, 100, 20], [0, 30, 100, 50], [0, 60, 20, 80]]; // two horizontal, one vertical-ish (20x20) actually horizontal too? Need vertical: 20x100
    const verticalBox = [0, 0, 20, 100];
    expect(calculateTextLineDirection([verticalBox, verticalBox, [0, 0, 100, 20]])).toBe('vertical');
    expect(calculateTextLineDirection([[0, 0, 100, 20], [0, 30, 100, 50]])).toBe('horizontal');
  });
  it('empty returns horizontal', () => {
    expect(calculateTextLineDirection([])).toBe('horizontal');
  });
});

describe('xycut — sortByXycut / xycutPlusSort', () => {
  it('empty returns empty', () => {
    expect(sortByXycut([], 'vertical')).toEqual([]);
    expect(xycutPlusSort(null)).toEqual([]);
    expect(xycutPlusSort([])).toEqual([]);
  });

  it('single box returns [0]', () => {
    expect(sortByXycut([[0, 0, 10, 10]], 'vertical')).toEqual([0]);
  });

  it('two boxes vertical order y then x (recursiveYxCut)', () => {
    // Boxes stacked vertically: top first, bottom second
    const boxes = [[0, 0, 10, 10], [0, 20, 10, 30]];
    const order = sortByXycut(boxes, 'vertical');
    expect(order).toEqual([0, 1]);
  });

  it('two boxes horizontal order via xycut (x then y)', () => {
    // Boxes side-by-side horizontally, same y
    const boxes = [[0, 0, 10, 10], [20, 0, 30, 10]];
    const order = sortByXycut(boxes, 'horizontal');
    // x-first: left then right regardless of slight y diff
    expect(order).toEqual([0, 1]);
  });

  it('four boxes grid vertical reading (top-left, top-right, bottom-left, bottom-right) → yx order', () => {
    const boxes = [
      [0, 0, 10, 10],   // 0 top-left
      [20, 0, 30, 10],  // 1 top-right
      [0, 20, 10, 30],  // 2 bottom-left
      [20, 20, 30, 30], // 3 bottom-right
    ];
    const order = sortByXycut(boxes, 'vertical');
    // YX: first y-interval 0-10 contains [0,1] sorted by x → 0,1 then y-interval 20-30 → 2,3
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('xycutPlusSort infers direction when null', () => {
    const horizBoxes = [[0, 0, 100, 20], [0, 30, 100, 50]];
    const order = xycutPlusSort(horizBoxes, null);
    expect(order.length).toBe(2);
    expect(order).toContain(0);
    expect(order).toContain(1);
  });

  it('intTrunc parity: float boxes work (truncated before projection)', () => {
    const boxes = [[0.9, 0.9, 10.9, 10.9], [0, 20, 10, 30]];
    expect(() => sortByXycut(boxes, 'vertical')).not.toThrow();
  });

  it('returns permutation of indices (no duplicates, covers all)', () => {
    const boxes = [
      [0, 0, 10, 10],
      [5, 5, 15, 15],
      [20, 0, 30, 10],
      [0, 20, 10, 30],
      [20, 20, 30, 30],
    ];
    const order = sortByXycut(boxes, 'vertical');
    expect(order.length).toBe(boxes.length);
    expect(new Set(order).size).toBe(boxes.length);
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
  });
});

describe('xycut — recursive cuts direct', () => {
  it('recursiveYxCut empty no throw', () => {
    const res = [];
    expect(() => recursiveYxCut([], [], res)).not.toThrow();
    expect(res).toEqual([]);
  });
  it('recursiveXyCut empty no throw', () => {
    const res = [];
    expect(() => recursiveXyCut([], [], res)).not.toThrow();
    expect(res).toEqual([]);
  });
});
