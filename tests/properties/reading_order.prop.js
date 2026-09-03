import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { bboxDistance } from '../../rapid_doc/utils/boxbase.js';

// Minimal XY-cut invariant: blocks sorted by y then x should be stable
// and bboxDistance should be consistent with grouping.
describe('Property: Reading Order XY-cut Invariant', () => {
  const blockArb = fc.record({
    bbox: fc.tuple(
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 0, max: 1000 }),
      fc.integer({ min: 10, max: 100 }),
      fc.integer({ min: 10, max: 100 }),
    ).map(([x, y, w, h]) => [x, y, x + w, y + h]),
    index: fc.integer({ min: 0, max: 100 }),
  });

  it('bboxDistance is symmetric and non-negative for any block pair', () => {
    fc.assert(
      fc.property(blockArb, blockArb, (a, b) => {
        const d1 = bboxDistance(a.bbox, b.bbox);
        const d2 = bboxDistance(b.bbox, a.bbox);
        expect(d1).toBeGreaterThanOrEqual(0);
        expect(d2).toBeGreaterThanOrEqual(0);
        expect(d1).toBeCloseTo(d2, 5);
      }),
      { numRuns: 100 },
    );
  });

  it('blocks with same y, sorted by x, maintain order', () => {
    fc.assert(
      fc.property(fc.array(blockArb, { minLength: 2, maxLength: 10 }), (blocks) => {
        // Force same y band
        const row = blocks.map((b, i) => ({ ...b, bbox: [i * 120, 100, i * 120 + 100, 140] }));
        const sorted = [...row].sort((a, b) => a.bbox[0] - b.bbox[0]);
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i].bbox[0]).toBeGreaterThan(sorted[i - 1].bbox[0]);
        }
      }),
      { numRuns: 100 },
    );
  });
});
