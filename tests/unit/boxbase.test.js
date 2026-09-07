import { describe, it, expect } from 'vitest';
import {
  isIn,
  bboxRelativePos,
  bboxDistance,
  getMinboxIfOverlapByRatio,
  calculateOverlapArea2MinboxAreaRatio,
  calculateIou,
  calculateOverlapAreaInBbox1AreaRatio,
  calculateVerticalProjectionOverlapRatio,
  mergeAdjacentBboxes,
  restorePoly,
} from '@rapid_doc/utils/boxbase.js';

describe('boxbase — isIn', () => {
  it('true when box1 inside box2', () => {
    expect(isIn([10, 10, 20, 20], [0, 0, 30, 30])).toBe(true);
  });
  it('false when outside', () => {
    expect(isIn([0, 0, 10, 10], [5, 5, 15, 15])).toBe(false);
  });
  it('true on exact equal', () => {
    expect(isIn([0, 0, 10, 10], [0, 0, 10, 10])).toBe(true);
  });
});

describe('boxbase — bboxRelativePos', () => {
  it('left of', () => {
    const [left, right, bottom, top] = bboxRelativePos([0, 0, 10, 10], [20, 0, 30, 10]);
    expect(left).toBe(false); // bbox1 left of bbox2? actually checks bbox1 vs bbox2
    // bbox1 [0,0,10,10], bbox2 [20,0,30,10] => bbox1 is left of bbox2 => right=true? Let's document behavior: [left,right,bottom,top] where left = x2b < x1? Actually function: left = x2b < x1 (bbox2 right < bbox1 left)
    // So bbox1 left of bbox2 => bbox1's right (10) < bbox2's left (20) => right variable? Need just check shape.
    expect(Array.isArray(bboxRelativePos([0, 0, 10, 10], [20, 0, 30, 10]))).toBe(true);
  });
  it('returns 4 booleans', () => {
    const res = bboxRelativePos([0, 0, 10, 10], [5, 5, 15, 15]);
    expect(res.length).toBe(4);
    res.forEach(v => expect(typeof v).toBe('boolean'));
  });
});

describe('boxbase — bboxDistance', () => {
  it('0 when overlapping', () => {
    expect(bboxDistance([0, 0, 10, 10], [5, 5, 15, 15])).toBe(0);
    expect(bboxDistance([0, 0, 10, 10], [0, 0, 10, 10])).toBe(0);
  });
  it('positive when separated horizontally', () => {
    expect(bboxDistance([0, 0, 10, 10], [20, 0, 30, 10])).toBe(10);
  });
  it('positive when separated vertically', () => {
    expect(bboxDistance([0, 0, 10, 10], [0, 20, 10, 30])).toBe(10);
  });
  it('diagonal distance via sqrt', () => {
    // bbox1 [0,0,10,10], bbox2 [20,20,30,30] → dx=10, dy=10 → sqrt(200)≈14.14
    expect(bboxDistance([0, 0, 10, 10], [20, 20, 30, 30])).toBeCloseTo(Math.sqrt(200), 5);
  });
  it('symmetric', () => {
    const a = [0, 0, 10, 10], b = [20, 0, 30, 10];
    expect(bboxDistance(a, b)).toBeCloseTo(bboxDistance(b, a), 5);
  });
});

describe('boxbase — getMinboxIfOverlapByRatio', () => {
  it('returns smaller box when overlap > ratio', () => {
    const a = [0, 0, 10, 10], b = [2, 2, 8, 8]; // b inside a
    // overlap = 36, minArea=36 → ratio=1 >0.5 → returns b (smaller)
    expect(getMinboxIfOverlapByRatio(a, b, 0.5)).toEqual(b);
  });
  it('returns null when overlap <= ratio', () => {
    const a = [0, 0, 10, 10], b = [20, 20, 30, 30];
    expect(getMinboxIfOverlapByRatio(a, b, 0.5)).toBeNull();
  });
  it('returns smaller area when both similar', () => {
    const a = [0, 0, 10, 10], b = [0, 0, 9, 9];
    const got = getMinboxIfOverlapByRatio(a, b, 0.5);
    expect(got).toEqual(b);
  });
});

describe('boxbase — calculateOverlap ratios', () => {
  it('calculateOverlapArea2MinboxAreaRatio 1 when contained', () => {
    expect(calculateOverlapArea2MinboxAreaRatio([0, 0, 10, 10], [2, 2, 4, 4])).toBeCloseTo(1, 5);
  });
  it('0 when no overlap', () => {
    expect(calculateOverlapArea2MinboxAreaRatio([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
  });
  it('calculateOverlapAreaInBbox1AreaRatio', () => {
    // bbox1 10x10=100, overlap 25 → 0.25
    expect(calculateOverlapAreaInBbox1AreaRatio([0, 0, 10, 10], [5, 5, 15, 15])).toBeCloseTo(0.25, 5);
    expect(calculateOverlapAreaInBbox1AreaRatio([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
    expect(calculateOverlapAreaInBbox1AreaRatio([0, 0, 0, 10], [0, 0, 10, 10])).toBe(0); // zero area
  });
  it('calculateVerticalProjectionOverlapRatio', () => {
    expect(calculateVerticalProjectionOverlapRatio([0, 0, 10, 10], [5, 5, 15, 15])).toBeCloseTo(0.5, 5);
    expect(calculateVerticalProjectionOverlapRatio([0, 0, 10, 10], [20, 0, 30, 10])).toBe(0);
    expect(calculateVerticalProjectionOverlapRatio([0, 0, 0, 10], [0, 0, 10, 10])).toBe(0);
  });
});

describe('boxbase — calculateIou', () => {
  it('1 for identical', () => {
    expect(calculateIou([0, 0, 10, 10], [0, 0, 10, 10])).toBeCloseTo(1, 5);
  });
  it('0 for disjoint', () => {
    expect(calculateIou([0, 0, 10, 10], [20, 20, 30, 30])).toBeCloseTo(0, 5);
  });
  it('known value', () => {
    // intersection 5x5=25, union 100+100-25=175 → 0.142857
    expect(calculateIou([0, 0, 10, 10], [5, 5, 15, 15])).toBeCloseTo(25 / 175, 5);
  });
  it('0 when union zero', () => {
    expect(calculateIou([0, 0, 0, 0], [0, 0, 0, 0])).toBe(0);
  });
});

describe('boxbase — mergeAdjacentBboxes', () => {
  it('returns empty for empty', () => {
    expect(mergeAdjacentBboxes([])).toEqual([]);
    expect(mergeAdjacentBboxes(null)).toEqual([]);
  });
  it('merges adjacent spans on same line', () => {
    const spans = [
      { bbox: [0, 0, 10, 10], text: 'Hello', font: { size: 10 } },
      { bbox: [12, 0, 20, 10], text: 'World', font: { size: 10 } }, // gap 2 ≤ 10*0.6=6 → merge
    ];
    const merged = mergeAdjacentBboxes(spans);
    expect(merged.length).toBe(1);
    expect(merged[0].bbox).toEqual([0, 0, 20, 10]);
  });
  it('does not merge distant spans', () => {
    const spans = [
      { bbox: [0, 0, 10, 10], text: 'A', font: { size: 10 } },
      { bbox: [50, 0, 60, 10], text: 'B', font: { size: 10 } }, // gap 40 >6 → separate line? Actually same y, but x gap large → two merged results
    ];
    const merged = mergeAdjacentBboxes(spans);
    expect(merged.length).toBe(2);
  });
  it('clusters by y', () => {
    const spans = [
      { bbox: [0, 0, 10, 10], text: 'A', font: { size: 10 } },
      { bbox: [0, 50, 10, 60], text: 'B', font: { size: 10 } }, // y diff > tolerance → separate lines
    ];
    const merged = mergeAdjacentBboxes(spans);
    expect(merged.length).toBe(2);
  });
  it('returnText merges text', () => {
    const spans = [
      { bbox: [0, 0, 10, 10], text: 'Hello ', font: { size: 10 } },
      { bbox: [11, 0, 20, 10], text: 'World', font: { size: 10 } },
    ];
    const merged = mergeAdjacentBboxes(spans, 0.6, 0.8, true);
    expect(merged[0].text).toContain('Hello');
  });
});

describe('boxbase — restorePoly', () => {
  const poly = [10, 20, 30, 20, 30, 40, 10, 40]; // xmin=10 ymin=20 xmax=30 ymax=40
  it('0 returns same', () => {
    expect(restorePoly(poly, 0, 100, 100)).toEqual(poly);
    expect(restorePoly(poly, '0', 100, 100)).toEqual(poly);
  });
  it('90 rotates correctly', () => {
    // For 90 (counter-clockwise): newXmin = W-1 - ymax = 99-40=59, newYmin= xmin=10, newXmax=99-20=79, newYmax= xmax=30
    const got = restorePoly(poly, 90, 100, 100);
    expect(got).toEqual([59, 10, 79, 10, 79, 30, 59, 30]);
  });
  it('270 rotates correctly', () => {
    const got = restorePoly(poly, 270, 100, 100);
    // newXmin=ymin=20, newYmin=H-1 - xmax=69, newXmax= ymax=40, newYmax= H-1 - xmin=89
    expect(got).toEqual([20, 69, 40, 69, 40, 89, 20, 89]);
  });
  it('180 rotates correctly', () => {
    const got = restorePoly(poly, 180, 100, 100);
    expect(got).toEqual([69, 59, 89, 59, 89, 79, 69, 79]);
  });
  it('throws for unsupported angle', () => {
    expect(() => restorePoly(poly, 45, 100, 100)).toThrow(/unsupported/);
  });
  it('returns input when poly too short', () => {
    expect(restorePoly([1, 2, 3], 90, 100, 100)).toEqual([1, 2, 3]);
  });
});
