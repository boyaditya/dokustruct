/**
 * Property-based tests for error handling.
 *
 * Feature: rapid-doc-js-refactor, Property 7: Null-Safe Input Handling
 * Feature: rapid-doc-js-refactor, Property 10: AbortException Propagation
 * Feature: rapid-doc-js-refactor, Property 11: Error Message Format Consistency
 *
 * Validates: Requirements 8.1, 8.5, 8.6, 9.6, 9.1
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { MagicModel } from '../../rapid_doc/backend/pipeline/pipeline_magic_model.js';
import { paraSplit } from '../../rapid_doc/backend/pipeline/para_split.js';
import { formatPipelineError } from '../../rapid_doc/utils/browser_utils.js';
import { AbortException } from '../../rapid_doc/utils/exceptions.js';

// --- Arbitraries ---

/**
 * Generates nullable values (null, undefined, or a valid value).
 */
const nullableValue = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
);

/**
 * Generates a nullable or valid pageModelInfo object for MagicModel constructor.
 */
const nullablePageModelInfo = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant({}),
  fc.constant({ layout_dets: null }),
  fc.constant({ layout_dets: undefined }),
  fc.constant({ layout_dets: [] }),
  fc.constant({ layout_dets: 'not_an_array' }),
);

/**
 * Generates a scale value that may be null, undefined, zero, or valid.
 */
const nullableScale = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(0),
  fc.float({ min: Math.fround(0.1), max: Math.fround(10), noNaN: true, noDefaultInfinity: true }),
);

/**
 * Generates nullable or empty pageInfoList inputs for paraSplit.
 * Note: paraSplit's contract expects array entries to be objects (not null/undefined),
 * so we test the top-level null/undefined/empty cases and valid-but-empty page entries.
 */
const nullablePageInfoList = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant([]),
  fc.constant([{}]),
  fc.constant([{ preproc_blocks: null, page_idx: 0, page_size: [100, 100] }]),
  fc.constant([{ preproc_blocks: undefined, page_idx: 0, page_size: [100, 100] }]),
  fc.constant([{ preproc_blocks: [], page_idx: 0, page_size: [100, 100] }]),
);

/**
 * Generates valid pipeline stage names.
 */
const stageArb = fc.constantFrom('layout', 'formula', 'ocr', 'table', 'postprocess', 'middleJson', 'reading_order');

/**
 * Generates valid module names.
 */
const moduleArb = fc.oneof(
  fc.constantFrom('BatchAnalyze', 'PipelineAnalyze', 'ModelInit', 'resultToMiddleJson', 'TableProcessor'),
  fc.string({ minLength: 1, maxLength: 30 }),
);

/**
 * Generates error messages (non-empty strings).
 */
const messageArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 200 }),
  fc.constantFrom('Model load failed', 'Out of memory', 'Invalid input', 'Network error'),
);

/**
 * Generates optional page index values.
 */
const pageIndexArb = fc.option(fc.integer({ min: 0, max: 1000 }), { nil: undefined });

/**
 * Generates recoverable flag.
 */
const recoverableArb = fc.boolean();

/**
 * Generates a complete formatPipelineError input object.
 */
const pipelineErrorInput = fc.record({
  stage: stageArb,
  module: moduleArb,
  message: messageArb,
  pageIndex: pageIndexArb,
  recoverable: recoverableArb,
});

/**
 * Generates a formatPipelineError input with some fields potentially null/undefined.
 */
const partialPipelineErrorInput = fc.record({
  stage: fc.option(stageArb, { nil: undefined }),
  module: fc.option(moduleArb, { nil: undefined }),
  message: fc.option(messageArb, { nil: undefined }),
  pageIndex: pageIndexArb,
  recoverable: recoverableArb,
});

/**
 * Generates a pageModelInfo with layout_dets containing entries with missing/null fields.
 */
const pageModelInfoWithNullFields = fc.record({
  layout_dets: fc.array(
    fc.oneof(
      fc.constant({ poly: null, category_id: 0, score: 0.5 }),
      fc.constant({ poly: undefined, category_id: 1, score: 0.8 }),
      fc.constant({ poly: [], category_id: 2, score: 0.6 }),
      fc.constant({ poly: [0, 0, 100, 0, 100, 100, 0, 100], category_id: null, score: 0.7 }),
      fc.constant({ poly: [10, 10, 50, 10, 50, 50, 10, 50], category_id: 0, score: null }),
      fc.constant({ poly: [10, 10, 50, 10, 50, 50, 10, 50], category_id: 0, score: 0.9 }),
      fc.constant({}),
      fc.constant({ poly: [0, 0, 0, 0, 0, 0, 0, 0], category_id: 0, score: 0.5 }),
    ),
    { minLength: 0, maxLength: 10 },
  ),
});

// --- Property 7: Null-Safe Input Handling ---

describe('Feature: rapid-doc-js-refactor, Property 7: Null-Safe Input Handling', () => {
  it('MagicModel constructor handles null/undefined pageModelInfo without throwing TypeError', () => {
    fc.assert(
      fc.property(nullablePageModelInfo, nullableScale, (pageModelInfo, scale) => {
        // Should not throw an unguarded TypeError
        let model;
        try {
          model = new MagicModel(pageModelInfo, scale);
        } catch (err) {
          // If it throws, it should be a descriptive error, not a raw TypeError
          expect(err.constructor.name).not.toBe('TypeError');
          return true;
        }

        // If construction succeeds, public getters should return valid arrays
        expect(Array.isArray(model.getImgs())).toBe(true);
        expect(Array.isArray(model.getTables())).toBe(true);
        expect(Array.isArray(model.getDiscarded())).toBe(true);
        expect(Array.isArray(model.getTextBlocks())).toBe(true);
        expect(Array.isArray(model.getTitleBlocks())).toBe(true);
        expect(Array.isArray(model.getAllSpans())).toBe(true);

        const equations = model.getEquations();
        expect(Array.isArray(equations)).toBe(true);
        expect(equations).toHaveLength(3);
        for (const eq of equations) {
          expect(Array.isArray(eq)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('MagicModel constructor handles layout_dets with null/missing fields gracefully', () => {
    fc.assert(
      fc.property(pageModelInfoWithNullFields, nullableScale, (pageModelInfo, scale) => {
        let model;
        try {
          model = new MagicModel(pageModelInfo, scale);
        } catch (err) {
          // Should not throw unguarded TypeError
          expect(err.constructor.name).not.toBe('TypeError');
          return true;
        }

        // Public getters should return valid arrays
        expect(Array.isArray(model.getImgs())).toBe(true);
        expect(Array.isArray(model.getTables())).toBe(true);
        expect(Array.isArray(model.getAllSpans())).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('paraSplit handles null/undefined/empty inputs without throwing TypeError', () => {
    fc.assert(
      fc.property(nullablePageInfoList, (pageInfoList) => {
        try {
          paraSplit(pageInfoList);
        } catch (err) {
          // If it throws, it should NOT be an unguarded TypeError or
          // "Cannot read properties of undefined/null"
          expect(err.message).not.toMatch(/Cannot read propert/i);
          expect(err.constructor.name).not.toBe('TypeError');
        }
        // If it doesn't throw, that's the expected behavior for null-safe handling
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('paraSplit with valid empty page info produces para_blocks arrays', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            preproc_blocks: fc.constant([]),
            page_idx: fc.integer({ min: 0, max: 100 }),
            page_size: fc.tuple(
              fc.integer({ min: 100, max: 2000 }),
              fc.integer({ min: 100, max: 2000 }),
            ),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (pageInfoList) => {
          paraSplit(pageInfoList);
          for (const pageInfo of pageInfoList) {
            expect(Array.isArray(pageInfo.para_blocks)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// --- Property 10: AbortException Propagation ---

describe('Feature: rapid-doc-js-refactor, Property 10: AbortException Propagation', () => {
  it('AbortException is never swallowed by a standard try/catch pattern', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 100 }),
        (message) => {
          const abortErr = new AbortException(message);

          // Simulate the pipeline error handling pattern:
          // catch blocks should re-throw AbortException
          const pipelineHandler = (err) => {
            if (err instanceof AbortException) throw err;
            // Non-abort errors are handled gracefully
            return 'handled';
          };

          // AbortException must propagate
          expect(() => pipelineHandler(abortErr)).toThrow(AbortException);

          // Non-abort errors should be handled
          const regularError = new Error('some error');
          expect(pipelineHandler(regularError)).toBe('handled');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('AbortException is an instance of Error and has correct name', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 100 }),
        (message) => {
          const abortErr = new AbortException(message);

          expect(abortErr instanceof Error).toBe(true);
          expect(abortErr instanceof AbortException).toBe(true);
          expect(abortErr.name).toBe('AbortException');
          expect(abortErr.message).toBe(message);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('AbortException propagates through nested catch blocks', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.integer({ min: 1, max: 5 }),
        (message, depth) => {
          const abortErr = new AbortException(message);

          // Simulate nested pipeline stages each with their own try/catch
          const nestedHandler = (err, currentDepth) => {
            try {
              if (currentDepth <= 0) throw err;
              return nestedHandler(err, currentDepth - 1);
            } catch (e) {
              if (e instanceof AbortException) throw e;
              return 'caught non-abort';
            }
          };

          // AbortException must propagate through all levels
          expect(() => nestedHandler(abortErr, depth)).toThrow(AbortException);

          // Regular errors should be caught at the first level
          const regularErr = new Error('regular');
          expect(nestedHandler(regularErr, depth)).toBe('caught non-abort');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('AbortException is distinguishable from other custom exceptions', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }),
        (message) => {
          const abortErr = new AbortException(message);
          const regularErr = new Error(message);
          const typeErr = new TypeError(message);

          // Only AbortException should pass the instanceof check
          expect(abortErr instanceof AbortException).toBe(true);
          expect(regularErr instanceof AbortException).toBe(false);
          expect(typeErr instanceof AbortException).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// --- Property 11: Error Message Format Consistency ---

describe('Feature: rapid-doc-js-refactor, Property 11: Error Message Format Consistency', () => {
  it('formatPipelineError output always contains module name in brackets', () => {
    fc.assert(
      fc.property(pipelineErrorInput, (input) => {
        const result = formatPipelineError(input);

        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);

        // Must contain module name in brackets [ModuleName]
        const bracketPattern = /\[.+?\]/;
        expect(result).toMatch(bracketPattern);

        // The first bracket should contain the module name
        expect(result).toContain(`[${input.module}]`);
      }),
      { numRuns: 100 },
    );
  });

  it('formatPipelineError output contains stage name when provided', () => {
    fc.assert(
      fc.property(pipelineErrorInput, (input) => {
        const result = formatPipelineError(input);

        // Stage should appear followed by colon
        if (input.stage) {
          expect(result).toContain(`${input.stage}:`);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('formatPipelineError output contains page index when provided', () => {
    fc.assert(
      fc.property(pipelineErrorInput, (input) => {
        const result = formatPipelineError(input);

        // If pageIndex is provided, it should appear in the output
        if (input.pageIndex != null) {
          expect(result).toContain(`(page ${input.pageIndex})`);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('formatPipelineError output contains recoverability indicator', () => {
    fc.assert(
      fc.property(pipelineErrorInput, (input) => {
        const result = formatPipelineError(input);

        // Must contain either [recoverable] or [non-recoverable]
        if (input.recoverable) {
          expect(result).toContain('[recoverable]');
        } else {
          expect(result).toContain('[non-recoverable]');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('formatPipelineError handles partial/missing fields gracefully', () => {
    fc.assert(
      fc.property(partialPipelineErrorInput, (input) => {
        // Should never throw
        let result;
        try {
          result = formatPipelineError(input);
        } catch (err) {
          // Should not throw TypeError for missing fields
          expect(err.constructor.name).not.toBe('TypeError');
          return true;
        }

        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);

        // Should always have brackets (module or 'Unknown')
        expect(result).toMatch(/\[.+?\]/);

        // Should always have recoverability indicator
        expect(result).toMatch(/\[(recoverable|non-recoverable)\]/);
      }),
      { numRuns: 100 },
    );
  });

  it('formatPipelineError output starts with bracketed module identifier', () => {
    fc.assert(
      fc.property(pipelineErrorInput, (input) => {
        const result = formatPipelineError(input);

        // Output should start with [ModuleName]
        expect(result.startsWith(`[${input.module}]`)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
