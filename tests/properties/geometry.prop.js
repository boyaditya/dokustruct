/**
 * Property-based tests for geometry utilities.
 *
 * Feature: rapid-doc-js-refactor, Property 4: Bounding Box Normalization Precision
 * Feature: rapid-doc-js-refactor, Property 8: Geometry Function Type Correctness
 *
 * Validates: Requirements 7.3, 8.3
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { normalizeToIntBbox } from '../../rapid_doc/utils/bbox_utils.js';
import {
  calculateIou,
  calculateOverlapArea2MinboxAreaRatio,
  bboxDistance,
} from '../../rapid_doc/utils/boxbase.js';

// --- Arbitraries ---

/**
 * Generates a valid bounding box [x0, y0, x1, y1] where x0 < x1 and y0 < y1.
 * Uses floats in a reasonable coordinate range.
 */
const validFloatBbox = fc
  .tuple(
    fc.float({ min: 0, max: 4096, noNaN: true, noDefaultInfinity: true }),
    fc.float({ min: 0, max: 4096, noNaN: true, noDefaultInfinity: true }),
    fc.float({ min: 0, max: 4096, noNaN: true, noDefaultInfinity: true }),
    fc.float({ min: 0, max: 4096, noNaN: true, noDefaultInfinity: true }),
  )
  .map(([a, b, c, d]) => {
    // Ensure x0 < x1 and y0 < y1 with at least 1 unit gap
    const x0 = Math.min(a, c);
    const x1 = Math.max(a, c) + 1;
    const y0 = Math.min(b, d);
    const y1 = Math.max(b, d) + 1;
    return [x0, y0, x1, y1];
  });

/**
 * Generates a valid bounding box with integer coordinates.
 */
const validIntBbox = fc
  .tuple(
    fc.integer({ min: 0, max: 4096 }),
    fc.integer({ min: 0, max: 4096 }),
    fc.integer({ min: 0, max: 4096 }),
    fc.integer({ min: 0, max: 4096 }),
  )
  .map(([a, b, c, d]) => {
    const x0 = Math.min(a, c);
    const x1 = Math.max(a, c) + 2;
    const y0 = Math.min(b, d);
    const y1 = Math.max(b, d) + 2;
    return [x0, y0, x1, y1];
  });

/**
 * Generates a pair of valid bounding boxes for two-box operations.
 */
const validBboxPair = fc.tuple(validIntBbox, validIntBbox);

// --- Property 4: Bounding Box Normalization Precision ---

describe('Feature: rapid-doc-js-refactor, Property 4: Bounding Box Normalization Precision', () => {
  it('normalizeToIntBbox produces integer coordinates within 1 pixel of correct rounding', () => {
    fc.assert(
      fc.property(validFloatBbox, (bbox) => {
        const result = normalizeToIntBbox(bbox);

        // normalizeToIntBbox may return null for degenerate boxes after floor/ceil
        if (result === null) return true;

        const [x0, y0, x1, y1] = bbox;
        const [rx0, ry0, rx1, ry1] = result;

        // All output values must be integers
        expect(Number.isInteger(rx0)).toBe(true);
        expect(Number.isInteger(ry0)).toBe(true);
        expect(Number.isInteger(rx1)).toBe(true);
        expect(Number.isInteger(ry1)).toBe(true);

        // Each value should be within 1 pixel of the mathematically correct rounding
        // normalizeToIntBbox uses floor for min and ceil for max
        expect(Math.abs(rx0 - Math.floor(x0))).toBeLessThanOrEqual(1);
        expect(Math.abs(ry0 - Math.floor(y0))).toBeLessThanOrEqual(1);
        expect(Math.abs(rx1 - Math.ceil(x1))).toBeLessThanOrEqual(1);
        expect(Math.abs(ry1 - Math.ceil(y1))).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  it('normalizeToIntBbox preserves bbox ordering (x0 < x1, y0 < y1) when result is non-null', () => {
    fc.assert(
      fc.property(validFloatBbox, (bbox) => {
        const result = normalizeToIntBbox(bbox);
        if (result === null) return true;

        const [rx0, ry0, rx1, ry1] = result;
        expect(rx0).toBeLessThan(rx1);
        expect(ry0).toBeLessThan(ry1);
      }),
      { numRuns: 200 },
    );
  });
});

// --- Property 8: Geometry Function Type Correctness ---

describe('Feature: rapid-doc-js-refactor, Property 8: Geometry Function Type Correctness', () => {
  it('calculateIou always returns a finite number for valid bbox pairs', () => {
    fc.assert(
      fc.property(validBboxPair, ([bbox1, bbox2]) => {
        const result = calculateIou(bbox1, bbox2);
        expect(typeof result).toBe('number');
        expect(Number.isNaN(result)).toBe(false);
        expect(Number.isFinite(result)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('calculateOverlapArea2MinboxAreaRatio always returns a finite number for valid bbox pairs', () => {
    fc.assert(
      fc.property(validBboxPair, ([bbox1, bbox2]) => {
        const result = calculateOverlapArea2MinboxAreaRatio(bbox1, bbox2);
        expect(typeof result).toBe('number');
        expect(Number.isNaN(result)).toBe(false);
        expect(Number.isFinite(result)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('bboxDistance always returns a finite number for valid bbox pairs', () => {
    fc.assert(
      fc.property(validBboxPair, ([bbox1, bbox2]) => {
        const result = bboxDistance(bbox1, bbox2);
        expect(typeof result).toBe('number');
        expect(Number.isNaN(result)).toBe(false);
        expect(Number.isFinite(result)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('normalizeToIntBbox returns null or an array of finite numbers', () => {
    fc.assert(
      fc.property(validFloatBbox, (bbox) => {
        const result = normalizeToIntBbox(bbox);
        if (result === null) return true;

        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(4);
        for (const val of result) {
          expect(typeof val).toBe('number');
          expect(Number.isNaN(val)).toBe(false);
          expect(Number.isFinite(val)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('calculateIou returns a value in [0, 1] range', () => {
    fc.assert(
      fc.property(validBboxPair, ([bbox1, bbox2]) => {
        const result = calculateIou(bbox1, bbox2);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  it('calculateOverlapArea2MinboxAreaRatio returns a value in [0, 1] range', () => {
    fc.assert(
      fc.property(validBboxPair, ([bbox1, bbox2]) => {
        const result = calculateOverlapArea2MinboxAreaRatio(bbox1, bbox2);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  it('bboxDistance returns a non-negative value', () => {
    fc.assert(
      fc.property(validBboxPair, ([bbox1, bbox2]) => {
        const result = bboxDistance(bbox1, bbox2);
        expect(result).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });
});
