/**
 * Property-based tests for overlap filtering.
 *
 * Feature: rapid-doc-js-refactor, Property 6: Overlap Filtering Correctness
 *
 * Validates: Requirements 7.7
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { filterOverlapBoxes } from '../../rapid_doc/backend/utils/utils.js';

// --- Constants ---

const MIN_BOX_SIZE = 6; // Boxes with width or height < 6px are removed
const OVERLAP_THRESHOLD = 0.7; // Non-inline boxes with > 70% overlap: keep larger
const INLINE_OVERLAP_THRESHOLD = 0.5; // Inline formula pairs with > 50% overlap

// --- Arbitraries ---

/**
 * Generates a valid detection box with poly (8-point polygon), category_id, score,
 * and original_label. Ensures width and height >= minSize.
 */
function detectionBox({ minSize = 10, maxCoord = 2000, label = undefined } = {}) {
  return fc
    .record({
      x0: fc.integer({ min: 0, max: maxCoord - minSize }),
      y0: fc.integer({ min: 0, max: maxCoord - minSize }),
      w: fc.integer({ min: minSize, max: 500 }),
      h: fc.integer({ min: minSize, max: 500 }),
      score: fc.float({ min: Math.fround(0.1), max: Math.fround(1.0), noNaN: true, noDefaultInfinity: true }),
      category_id: fc.constantFrom(0, 1, 2, 3, 4, 5, 6, 7, 8, 13, 14, 15),
      labelChoice: label
        ? fc.constant(label)
        : fc.constantFrom('title', 'text', 'abandon', 'image', 'table', 'interline_equation'),
    })
    .map(({ x0, y0, w, h, score, category_id, labelChoice }) => {
      const x1 = x0 + w;
      const y1 = y0 + h;
      return {
        poly: [x0, y0, x1, y0, x1, y1, x0, y1],
        category_id,
        score,
        original_label: labelChoice,
      };
    });
}

/**
 * Generates a tiny box (width or height < 6px) that should be filtered out.
 */
const tinyBox = fc
  .record({
    x0: fc.integer({ min: 0, max: 2000 }),
    y0: fc.integer({ min: 0, max: 2000 }),
    tinyDim: fc.constantFrom('width', 'height'),
    smallVal: fc.integer({ min: 1, max: 5 }),
    bigVal: fc.integer({ min: 10, max: 200 }),
    score: fc.float({ min: Math.fround(0.1), max: Math.fround(1.0), noNaN: true, noDefaultInfinity: true }),
    category_id: fc.constantFrom(0, 1, 3, 5, 8, 13, 14),
  })
  .map(({ x0, y0, tinyDim, smallVal, bigVal, score, category_id }) => {
    const w = tinyDim === 'width' ? smallVal : bigVal;
    const h = tinyDim === 'height' ? smallVal : bigVal;
    return {
      poly: [x0, y0, x0 + w, y0, x0 + w, y0 + h, x0, y0 + h],
      category_id,
      score,
      original_label: 'text',
    };
  });

/**
 * Generates a pair of overlapping boxes where one is contained within the other
 * (guaranteeing > 70% overlap ratio in "small" mode).
 */
const highOverlapPair = fc
  .record({
    x0: fc.integer({ min: 50, max: 1500 }),
    y0: fc.integer({ min: 50, max: 1500 }),
    w: fc.integer({ min: 50, max: 400 }),
    h: fc.integer({ min: 50, max: 400 }),
    // The larger box extends beyond the smaller one
    padLeft: fc.integer({ min: 0, max: 10 }),
    padTop: fc.integer({ min: 0, max: 10 }),
    padRight: fc.integer({ min: 1, max: 30 }),
    padBottom: fc.integer({ min: 1, max: 30 }),
    scoreA: fc.float({ min: Math.fround(0.1), max: Math.fround(1.0), noNaN: true, noDefaultInfinity: true }),
    scoreB: fc.float({ min: Math.fround(0.1), max: Math.fround(1.0), noNaN: true, noDefaultInfinity: true }),
    catA: fc.constantFrom(0, 1, 5, 8, 14, 15),
    catB: fc.constantFrom(0, 1, 5, 8, 14, 15),
    labelA: fc.constantFrom('title', 'text', 'table', 'interline_equation'),
    labelB: fc.constantFrom('title', 'text', 'table', 'interline_equation'),
  })
  .map(({ x0, y0, w, h, padLeft, padTop, padRight, padBottom, scoreA, scoreB, catA, catB, labelA, labelB }) => {
    // Smaller box
    const smallBox = {
      poly: [x0, y0, x0 + w, y0, x0 + w, y0 + h, x0, y0 + h],
      category_id: catA,
      score: scoreA,
      original_label: labelA,
    };
    // Larger box that fully contains the smaller one
    const largeBox = {
      poly: [
        x0 - padLeft, y0 - padTop,
        x0 + w + padRight, y0 - padTop,
        x0 + w + padRight, y0 + h + padBottom,
        x0 - padLeft, y0 + h + padBottom,
      ],
      category_id: catB,
      score: scoreB,
      original_label: labelB,
    };
    return { smallBox, largeBox };
  });

/**
 * Generates a pair of inline_formula boxes that overlap significantly (> 50%).
 */
const inlineFormulaPair = fc
  .record({
    x0: fc.integer({ min: 50, max: 1500 }),
    y0: fc.integer({ min: 50, max: 1500 }),
    w: fc.integer({ min: 30, max: 200 }),
    h: fc.integer({ min: 20, max: 100 }),
    // Shift for second box — small shift means high overlap
    shiftX: fc.integer({ min: 0, max: 5 }),
    shiftY: fc.integer({ min: 0, max: 5 }),
    scoreA: fc.float({ min: Math.fround(0.1), max: Math.fround(1.0), noNaN: true, noDefaultInfinity: true }),
    scoreB: fc.float({ min: Math.fround(0.1), max: Math.fround(1.0), noNaN: true, noDefaultInfinity: true }),
  })
  .map(({ x0, y0, w, h, shiftX, shiftY, scoreA, scoreB }) => {
    const boxA = {
      poly: [x0, y0, x0 + w, y0, x0 + w, y0 + h, x0, y0 + h],
      category_id: 13, // InlineEquation
      score: scoreA,
      original_label: 'inline_formula',
    };
    const boxB = {
      poly: [
        x0 + shiftX, y0 + shiftY,
        x0 + w + shiftX, y0 + shiftY,
        x0 + w + shiftX, y0 + h + shiftY,
        x0 + shiftX, y0 + h + shiftY,
      ],
      category_id: 13, // InlineEquation
      score: scoreB,
      original_label: 'inline_formula',
    };
    return { boxA, boxB };
  });

/**
 * Generates a list of non-overlapping detection boxes (spread apart).
 */
const nonOverlappingBoxes = fc
  .integer({ min: 2, max: 8 })
  .chain((count) =>
    fc.array(
      fc.record({
        idx: fc.constant(0), // placeholder
        w: fc.integer({ min: 20, max: 80 }),
        h: fc.integer({ min: 20, max: 80 }),
        score: fc.float({ min: Math.fround(0.1), max: Math.fround(1.0), noNaN: true, noDefaultInfinity: true }),
        category_id: fc.constantFrom(0, 1, 3, 5, 8, 14, 15),
        label: fc.constantFrom('title', 'text', 'image', 'table', 'interline_equation'),
      }),
      { minLength: count, maxLength: count },
    ),
  )
  .map((items) =>
    items.map((item, idx) => {
      // Place boxes far apart so they don't overlap
      const x0 = idx * 600;
      const y0 = idx * 600;
      return {
        poly: [x0, y0, x0 + item.w, y0, x0 + item.w, y0 + item.h, x0, y0 + item.h],
        category_id: item.category_id,
        score: item.score,
        original_label: item.label,
      };
    }),
  );

// --- Helper ---

function bboxFromPoly(poly) {
  return [poly[0], poly[1], poly[4], poly[5]];
}

function bboxArea(bbox) {
  return Math.abs((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));
}

// --- Property 6: Overlap Filtering Correctness ---

describe('Feature: rapid-doc-js-refactor, Property 6: Overlap Filtering Correctness', () => {
  it('(a) boxes with width or height < 6px are removed from the result', () => {
    fc.assert(
      fc.property(
        tinyBox,
        fc.array(detectionBox({ minSize: 20 }), { minLength: 0, maxLength: 5 }),
        (tiny, others) => {
          const input = [tiny, ...others];
          const result = filterOverlapBoxes(input, false);

          // The tiny box should not appear in the result
          const tinyInResult = result.some(
            (r) =>
              r.poly[0] === tiny.poly[0] &&
              r.poly[1] === tiny.poly[1] &&
              r.poly[4] === tiny.poly[4] &&
              r.poly[5] === tiny.poly[5],
          );
          expect(tinyInResult).toBe(false);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('(a) boxes with width and height >= 6px are NOT removed due to size alone', () => {
    fc.assert(
      fc.property(nonOverlappingBoxes, (boxes) => {
        // All boxes are >= 20px and non-overlapping, so none should be removed
        const result = filterOverlapBoxes(boxes, false);
        expect(result.length).toBe(boxes.length);
      }),
      { numRuns: 150 },
    );
  });

  it('(b) when two non-inline boxes overlap > 70%, the one with larger area is kept', () => {
    fc.assert(
      fc.property(highOverlapPair, ({ smallBox, largeBox }) => {
        // Skip if either has a special label that triggers the special-label exception
        const specialLabels = new Set(['image', 'seal', 'chart']);
        if (specialLabels.has(smallBox.original_label) || specialLabels.has(largeBox.original_label)) {
          return true; // skip — special label logic may prevent dropping
        }

        const input = [smallBox, largeBox];
        const result = filterOverlapBoxes(input, false);

        // The larger box should be kept
        const largeBbox = bboxFromPoly(largeBox.poly);
        const smallBbox = bboxFromPoly(smallBox.poly);
        const largeArea = bboxArea(largeBbox);
        const smallArea = bboxArea(smallBbox);

        // At least one box should remain
        expect(result.length).toBeGreaterThanOrEqual(1);

        if (largeArea > smallArea) {
          // The larger box should be in the result
          const largeInResult = result.some(
            (r) => r.poly[0] === largeBox.poly[0] && r.poly[1] === largeBox.poly[1] &&
                   r.poly[4] === largeBox.poly[4] && r.poly[5] === largeBox.poly[5],
          );
          expect(largeInResult).toBe(true);
        } else if (smallArea > largeArea) {
          // If the "small" box actually has larger area (due to padding being small),
          // it should be kept
          const smallInResult = result.some(
            (r) => r.poly[0] === smallBox.poly[0] && r.poly[1] === smallBox.poly[1] &&
                   r.poly[4] === smallBox.poly[4] && r.poly[5] === smallBox.poly[5],
          );
          expect(smallInResult).toBe(true);
        }
        // If areas are equal, either can be kept — no assertion needed
      }),
      { numRuns: 150 },
    );
  });

  it('(b) result never contains more boxes than input', () => {
    fc.assert(
      fc.property(
        fc.array(detectionBox(), { minLength: 0, maxLength: 10 }),
        (boxes) => {
          const result = filterOverlapBoxes(boxes, false);
          expect(result.length).toBeLessThanOrEqual(boxes.length);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('(c) inline formula pair handling: with useCustomOcr=false, inline formulas are not dropped due to overlap', () => {
    fc.assert(
      fc.property(inlineFormulaPair, ({ boxA, boxB }) => {
        const input = [boxA, boxB];
        const result = filterOverlapBoxes(input, false);

        // With useCustomOcr=false, inline formula overlap is skipped (continue)
        // Both boxes should remain (unless one is < 6px, which our generator avoids)
        expect(result.length).toBe(2);
      }),
      { numRuns: 150 },
    );
  });

  it('(c) inline formula pair handling: with useCustomOcr=true and > 50% overlap, inline formulas are dropped', () => {
    fc.assert(
      fc.property(inlineFormulaPair, ({ boxA, boxB }) => {
        const input = [boxA, boxB];
        const result = filterOverlapBoxes(input, true);

        // Both are inline_formula. With useCustomOcr=true and high overlap (> 50%),
        // both inline formulas should be dropped.
        // Our generator creates nearly identical boxes (shift 0-5px on 30-200px boxes)
        // so overlap should be > 50% in most cases.
        const bboxA = bboxFromPoly(boxA.poly);
        const bboxB = bboxFromPoly(boxB.poly);

        // Calculate overlap ratio manually to verify
        const xMinInter = Math.max(bboxA[0], bboxB[0]);
        const yMinInter = Math.max(bboxA[1], bboxB[1]);
        const xMaxInter = Math.min(bboxA[2], bboxB[2]);
        const yMaxInter = Math.min(bboxA[3], bboxB[3]);
        const interW = Math.max(0, xMaxInter - xMinInter);
        const interH = Math.max(0, yMaxInter - yMinInter);
        const interArea = interW * interH;
        const areaA = bboxArea(bboxA);
        const areaB = bboxArea(bboxB);
        const smallArea = Math.min(areaA, areaB);
        const overlapRatio = smallArea === 0 ? 0 : interArea / smallArea;

        if (overlapRatio > INLINE_OVERLAP_THRESHOLD) {
          // Both inline formulas should be dropped
          expect(result.length).toBe(0);
        } else {
          // Below threshold — both should remain
          expect(result.length).toBe(2);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('(c) never removes both boxes in a non-inline pair (at least one survives)', () => {
    fc.assert(
      fc.property(highOverlapPair, ({ smallBox, largeBox }) => {
        // Ensure neither is inline_formula
        const input = [
          { ...smallBox, original_label: 'text' },
          { ...largeBox, original_label: 'text' },
        ];
        const result = filterOverlapBoxes(input, false);

        // For non-inline pairs, at most one is dropped — at least one must survive
        expect(result.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 150 },
    );
  });

  it('reference boxes are excluded from filtering', () => {
    fc.assert(
      fc.property(
        fc.array(detectionBox(), { minLength: 1, maxLength: 5 }),
        (boxes) => {
          // Add a reference box — it should be excluded from the filtering process
          const refBox = {
            poly: [0, 0, 100, 0, 100, 100, 0, 100],
            category_id: 2,
            score: 0.9,
            original_label: 'reference',
          };
          const input = [refBox, ...boxes];
          const result = filterOverlapBoxes(input, false);

          // Reference boxes are filtered out at the start (filter !== "reference")
          // so they won't appear in the result
          const refInResult = result.some((r) => r.original_label === 'reference');
          expect(refInResult).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
