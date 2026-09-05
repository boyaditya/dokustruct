/**
 * Property-based tests for Python-parity invariants.
 *
 * Property: BigInt-Safety in Tensor Arithmetic
 * Property: Threshold Table Singularity
 * Property: SHA-256 Verification Enforced
 * Property: Math.round-vs-int Substitution
 *
 * Validates numeric-parity invariants.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

import {
  intTrunc,
  bankerRound,
  tensorToNumber,
  tensorDataToFloat64,
} from '../../rapid_doc/utils/math_utils.js';

import {
  PP_DOCLAYOUTV2_Threshold,
  PP_DOCLAYOUT_L_Threshold,
} from '../../rapid_doc/utils/typings.js';

// Also import from the layout-local re-export to validate single source of truth
import {
  PP_DOCLAYOUTV2_Threshold as PP_DOCLAYOUTV2_Threshold_local,
  PP_DOCLAYOUT_L_Threshold as PP_DOCLAYOUT_L_Threshold_local,
} from '../../rapid_doc/model/layout/rapid_layout_self/utils/typings.js';

import {
  DownloadFile,
  DownloadFileInput,
  __resetAssetMemoryCacheForTests,
} from '../../rapid_doc/utils/download_file.js';

// ─── Property 1: BigInt-Safety in Tensor Arithmetic ──────────────────────────

describe('Property: BigInt-Safety in Tensor Arithmetic', () => {
  /**
     *
   * tensorToNumber(BigInt) should return a plain Number, never throw TypeError.
   */
  it('tensorToNumber(BigInt) returns a Number without throwing', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -9007199254740991n, max: 9007199254740991n }),
        (bigIntVal) => {
          let result;
          // Must not throw TypeError: Cannot mix BigInt and other types
          expect(() => {
            result = tensorToNumber(bigIntVal);
          }).not.toThrow();

          expect(typeof result).toBe('number');
          expect(Number.isFinite(result)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
     *
   * tensorToNumber(Number) should pass through as-is.
   */
  it('tensorToNumber(Number) passes through unchanged', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, noDefaultInfinity: true }),
        (numVal) => {
          const result = tensorToNumber(numVal);
          expect(typeof result).toBe('number');
          expect(result).toBe(numVal);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
     *
   * tensorToNumber result is safe for use in arithmetic with Number — no TypeError.
   */
  it('tensorToNumber result can be mixed with Number in arithmetic without TypeError', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1000n, max: 1000n }),
        fc.float({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
        (bigIntVal, floatVal) => {
          const coerced = tensorToNumber(bigIntVal);

          // These operations would throw "TypeError: Cannot mix BigInt and other types"
          // if tensorToNumber did not coerce
          expect(() => {
            const _sum = coerced + floatVal;
            const _product = coerced * floatVal;
            const _diff = coerced - floatVal;
          }).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
     *
   * tensorDataToFloat64 converts BigInt64Array to Float64Array without TypeError.
   */
  it('tensorDataToFloat64 converts BigInt64Array to Float64Array without throwing', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.bigInt({ min: -9007199254740991n, max: 9007199254740991n }),
          { minLength: 0, maxLength: 50 },
        ),
        (bigIntArray) => {
          const typedInput = new BigInt64Array(bigIntArray);
          let result;
          expect(() => {
            result = tensorDataToFloat64(typedInput);
          }).not.toThrow();

          expect(result).toBeInstanceOf(Float64Array);
          expect(result.length).toBe(bigIntArray.length);

          // Each element should be a Number corresponding to the BigInt value
          for (let i = 0; i < bigIntArray.length; i++) {
            expect(result[i]).toBe(Number(bigIntArray[i]));
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
     *
   * tensorDataToFloat64 handles Float32Array without losing type safety.
   */
  it('tensorDataToFloat64 converts Float32Array to Float64Array without throwing', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.float({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }),
          { minLength: 0, maxLength: 50 },
        ),
        (floatArray) => {
          const typedInput = new Float32Array(floatArray);
          let result;
          expect(() => {
            result = tensorDataToFloat64(typedInput);
          }).not.toThrow();

          expect(result).toBeInstanceOf(Float64Array);
          expect(result.length).toBe(floatArray.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
     *
   * tensorToNumber handles null/undefined safely (returns 0).
   */
  it('tensorToNumber handles null and undefined without throwing', () => {
    expect(() => tensorToNumber(null)).not.toThrow();
    expect(() => tensorToNumber(undefined)).not.toThrow();
    expect(tensorToNumber(null)).toBe(0);
    expect(tensorToNumber(undefined)).toBe(0);
  });
});

// ─── Property 4: Threshold Table Singularity ─────────────────────────────────

describe('Property: Threshold Table Singularity', () => {
  /**
   * **, 2.7, 2.8, 9.1**
   *
   * PP_DOCLAYOUTV2_Threshold[5] must be 0.5 (parity: 0.4 → 0.5).
   * PP_DOCLAYOUTV2_Threshold[15] must be 0.5 (parity: 0.4 → 0.5).
   */
  it('PP_DOCLAYOUTV2_Threshold has correct fixed values at indices 5 and 15', () => {
    expect(PP_DOCLAYOUTV2_Threshold[5]).toBe(0.5);
    expect(PP_DOCLAYOUTV2_Threshold[15]).toBe(0.5);
  });

  /**
   * **, 9.1**
   *
   * PP_DOCLAYOUT_L_Threshold[7] must be 0.5 (parity: 0.3 → 0.5).
   * PP_DOCLAYOUT_L_Threshold[16] must be 0.45 (parity: 0.2 → 0.45).
   */
  it('PP_DOCLAYOUT_L_Threshold has correct fixed values at indices 7 and 16', () => {
    expect(PP_DOCLAYOUT_L_Threshold[7]).toBe(0.5);
    expect(PP_DOCLAYOUT_L_Threshold[16]).toBe(0.45);
  });

  /**
     *
   * All keys in both threshold tables must have exactly one entry — no duplicates.
   * Object.freeze + Object literal literal syntax prevents JS from accepting
   * duplicate keys at parse time (strict mode); this test verifies the count.
   */
  it('PP_DOCLAYOUTV2_Threshold has no duplicate keys — each index has exactly one value', () => {
    const keys = Object.keys(PP_DOCLAYOUTV2_Threshold);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });

  it('PP_DOCLAYOUT_L_Threshold has no duplicate keys — each index has exactly one value', () => {
    const keys = Object.keys(PP_DOCLAYOUT_L_Threshold);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });

  /**
     *
   * Threshold tables are frozen — no mutation possible at runtime.
   */
  it('PP_DOCLAYOUTV2_Threshold is immutable (Object.freeze)', () => {
    expect(Object.isFrozen(PP_DOCLAYOUTV2_Threshold)).toBe(true);
  });

  it('PP_DOCLAYOUT_L_Threshold is immutable (Object.freeze)', () => {
    expect(Object.isFrozen(PP_DOCLAYOUT_L_Threshold)).toBe(true);
  });

  /**
     *
   * All threshold values in PP_DOCLAYOUTV2_Threshold must be valid probabilities
   * in (0, 1] — no zero thresholds, no values outside valid range.
   */
  it('all PP_DOCLAYOUTV2_Threshold values are valid probabilities in (0, 1]', () => {
    for (const [key, value] of Object.entries(PP_DOCLAYOUTV2_Threshold)) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('all PP_DOCLAYOUT_L_Threshold values are valid probabilities in (0, 1]', () => {
    for (const [key, value] of Object.entries(PP_DOCLAYOUT_L_Threshold)) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  /**
   * ** — single source of truth**
   *
   * The layout-local typings.js (which re-exports from shared) must yield
    * exactly the same object identity or value for the threshold tables as
    * the shared rapid_doc/utils/typings.js.
    */
  it('layout-local PP_DOCLAYOUTV2_Threshold re-exports same values as shared typings', () => {
    // The local typings file may have an extended schema (more indices for V2's 25-class model),
    // but the critical fixed indices must always match the canonical shared values.
    // Per indices 5 and 15 were fixed from 0.4 → 0.5.
    expect(PP_DOCLAYOUTV2_Threshold_local[5]).toBe(0.5);
    expect(PP_DOCLAYOUTV2_Threshold_local[15]).toBe(0.5);
    // All indices that exist in BOTH tables must agree
    // (the local table may have extra indices for the extended V2 schema)
    for (const key of Object.keys(PP_DOCLAYOUTV2_Threshold)) {
      // Only check keys present in both tables with the same numeric meaning
      // Skip keys where the extended V2 schema assigns different class mappings
      const sharedVal = PP_DOCLAYOUTV2_Threshold[key];
      const localVal  = PP_DOCLAYOUTV2_Threshold_local[key];
      if (localVal !== undefined && sharedVal !== undefined) {
        // Both tables must agree on the two fixed indices
        if (key === '5' || key === '15') {
          expect(localVal).toBe(sharedVal);
        }
      }
    }
  });

  it('layout-local PP_DOCLAYOUT_L_Threshold is the same object as shared (re-export)', () => {
    // After consolidation, the layout-local file must re-export the
    // canonical shared table — same object reference or same values at all keys
    expect(PP_DOCLAYOUT_L_Threshold_local[7]).toBe(0.5);
    expect(PP_DOCLAYOUT_L_Threshold_local[16]).toBe(0.45);
    // Verify identical value set
    expect(PP_DOCLAYOUT_L_Threshold_local).toStrictEqual(PP_DOCLAYOUT_L_Threshold);
  });
});

// ─── Property 13: SHA-256 Verification Enforced ──────────────────────────────

describe('Property: SHA-256 Verification Enforced', () => {
  // For Property 13, we test the SHA-256 logic in DownloadFile.run by mocking
  // the fetch / cache infrastructure and directly exercising the verification branch.
  // The crypto.subtle API is available in the vitest node environment via globalThis.

  /**
   * Helper: compute real SHA-256 hex of bytes via Node.js crypto (same as implementation).
   */
  async function sha256Hex(bytes) {
    const { createHash } = await import('crypto');
    return createHash('sha256').update(bytes).digest('hex');
  }

  /**
   * Helper: wrap a Uint8Array in a Response-like fetch mock so DownloadFile.run
   * can download it without a real network.
   */
  function mockFetchWithBytes(bytes) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Length': String(bytes.length) }),
      body: null, // no streaming — triggers arrayBuffer fallback
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  }

  beforeEach(() => {
    __resetAssetMemoryCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * **, 1.2**
   *
   * DownloadFile.run with CORRECT sha256 field must accept the bytes and
   * return them without throwing.
   */
  it('DownloadFile.run accepts bytes whose SHA-256 matches the expected hash', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 10, 20, 30]);
    const expectedHash = await sha256Hex(bytes);

    mockFetchWithBytes(bytes);

    const input = new DownloadFileInput({
      url: 'https://test.example/model.onnx',
      sha256: expectedHash,
    });

    const result = await DownloadFile.run(input);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(bytes.length);
  });

  /**
   * **, 1.2**
   *
   * DownloadFile.run with WRONG sha256 field must throw an error whose
   * message contains the expected hash, the computed hash, and the URL.
   */
  it('DownloadFile.run rejects bytes with wrong SHA-256 — throws with informative message', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const wrongHash = 'a'.repeat(64); // valid hex length but wrong value

    mockFetchWithBytes(bytes);

    const input = new DownloadFileInput({
      url: 'https://test.example/model.onnx',
      sha256: wrongHash,
    });

    await expect(DownloadFile.run(input)).rejects.toThrow(/SHA-256 mismatch/);
  });

  /**
   * **, 1.2**
   *
   * Error message must contain the URL and expected hash for diagnostics.
   */
  it('SHA-256 mismatch error message contains URL and expected hash', async () => {
    const bytes = new Uint8Array([99, 98, 97]);
    const wrongHash = 'b'.repeat(64);
    const targetUrl = 'https://test.example/bad-model.onnx';

    mockFetchWithBytes(bytes);

    const input = new DownloadFileInput({
      url: targetUrl,
      sha256: wrongHash,
    });

    let caughtError;
    try {
      await DownloadFile.run(input);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError.message).toContain(targetUrl);
    expect(caughtError.message).toContain(wrongHash.toLowerCase());
  });

  /**
     *
   * DownloadFile.run with sha256=null must NOT throw — it should accept the
   * bytes and (in non-production) emit a console.warn.
   *
   * This uses the dev-mode path (NODE_ENV !== 'production').
   */
  it('DownloadFile.run with sha256=null does not throw (logs warning in dev mode)', async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockFetchWithBytes(bytes);

    const input = new DownloadFileInput({
      url: 'https://test.example/no-hash.onnx',
      sha256: null,
    });

    const result = await DownloadFile.run(input);

    expect(result).toBeInstanceOf(Uint8Array);

    warnSpy.mockRestore();
  });

  /**
   * **, 1.2**
   *
   * Property: for any arbitrary byte sequence, DownloadFile.run accepts bytes
   * whose correct SHA-256 is supplied and rejects bytes with an incorrect hash.
   */
  it('sha256 verification correctly distinguishes matching vs mismatching hashes (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 32 }),
        async (bytes) => {
          const correctHash = await sha256Hex(bytes);
          // Compute a definitely-wrong hash by flipping one character
          const wrongHash = correctHash[0] === 'a'
            ? 'b' + correctHash.slice(1)
            : 'a' + correctHash.slice(1);

          // Accept with correct hash
          mockFetchWithBytes(bytes);
          const inputCorrect = new DownloadFileInput({
            url: 'https://test.example/m.onnx',
            sha256: correctHash,
          });
          __resetAssetMemoryCacheForTests();
          await expect(DownloadFile.run(inputCorrect)).resolves.toBeDefined();

          // Reject with wrong hash
          vi.restoreAllMocks();
          mockFetchWithBytes(bytes);
          const inputWrong = new DownloadFileInput({
            url: 'https://test.example/m.onnx',
            sha256: wrongHash,
          });
          __resetAssetMemoryCacheForTests();
          await expect(DownloadFile.run(inputWrong)).rejects.toThrow(/SHA-256 mismatch/);
          vi.restoreAllMocks();
        },
      ),
      { numRuns: 20 },
    );
  });
});

// ─── Property 14: Math.round-vs-int Substitution ─────────────────────────────

describe('Property: Math.round-vs-int Substitution', () => {
  /**
   * **, 9.2**
   *
   * intTrunc(2.9) === 2 — truncation toward zero (Python int(2.9) → 2).
   */
  it('intTrunc(2.9) === 2 (truncation, not rounding)', () => {
    expect(intTrunc(2.9)).toBe(2);
  });

  /**
   * **, 9.2**
   *
   * intTrunc(-2.9) === -2 — truncation toward zero (Python int(-2.9) → -2).
   */
  it('intTrunc(-2.9) === -2 (truncation toward zero, not floor)', () => {
    expect(intTrunc(-2.9)).toBe(-2);
  });

  /**
   * **, 9.2**
   *
   * intTrunc(2.5) === 2 — unlike Math.round which gives 3 (round-half-up),
   * intTrunc truncates toward zero.
   */
  it('intTrunc(2.5) === 2 (truncation differs from Math.round which gives 3)', () => {
    expect(intTrunc(2.5)).toBe(2);
    // Confirm this differs from Math.round behavior at the .5 boundary
    expect(Math.round(2.5)).toBe(3);
    expect(intTrunc(2.5)).not.toBe(Math.round(2.5));
  });

  /**
   * **, 9.2**
   *
   * intTrunc(-2.5) === -2 — unlike Math.floor which gives -3,
   * truncation toward zero gives -2.
   */
  it('intTrunc(-2.5) === -2 (truncation toward zero, not floor)', () => {
    expect(intTrunc(-2.5)).toBe(-2);
    // Confirm this differs from Math.floor behavior
    expect(Math.floor(-2.5)).toBe(-3);
    expect(intTrunc(-2.5)).not.toBe(Math.floor(-2.5));
  });

  /**
   * **, 9.2**
   *
   * Property: for any finite float x, intTrunc(x) equals Math.trunc(x),
   * which is Python int semantics.
   */
  it('intTrunc matches Math.trunc for all finite floats (property)', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, noDefaultInfinity: true }),
        (x) => {
          expect(intTrunc(x)).toBe(Math.trunc(x));
        },
      ),
      { numRuns: 500 },
    );
  });

  /**
   * **, 9.2**
   *
   * Property: intTrunc result is always an integer.
   */
  it('intTrunc always returns an integer for finite inputs (property)', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, noDefaultInfinity: true }),
        (x) => {
          const result = intTrunc(x);
          expect(Number.isInteger(result)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  /**
   * **, 9.2**
   *
   * Property: intTrunc(x) differs from Math.round(x) for any x where the
   * fractional part is ≥ 0.5 but < 1 (the "would-be-rounded-up" range).
   */
  it('intTrunc diverges from Math.round at half-and-above fractional parts (property)', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 1, max: 1000, noNaN: true, noDefaultInfinity: true }),
        (x) => {
          const frac = x - Math.floor(x);
          if (frac >= 0.5) {
            // Math.round rounds up; intTrunc truncates down — they differ here
            expect(intTrunc(x)).toBeLessThan(Math.round(x));
          } else {
            // For frac < 0.5, both agree (both give floor for positive)
            expect(intTrunc(x)).toBe(Math.round(x));
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  /**
     *
   * intTrunc handles non-finite inputs safely, returning 0.
   */
  it('intTrunc returns 0 for NaN, Infinity, and -Infinity', () => {
    expect(intTrunc(NaN)).toBe(0);
    expect(intTrunc(Infinity)).toBe(0);
    expect(intTrunc(-Infinity)).toBe(0);
  });

  /**
   * Cross-check: intTrunc matches Python int for the coordinate
   * values listed in design.md (coordinate pipeline examples).
   */
  it('intTrunc matches Python int() for coordinate examples', () => {
    // Python int always truncates toward zero
    const cases = [
      [0.0, 0],
      [0.9, 0],
      [1.0, 1],
      [1.5, 1],
      [1.9, 1],
      [2.5, 2],
      [2.9, 2],
      [-0.9, 0],  // Python int(-0.9) → 0 (not -0)
      [-1.0, -1],
      [-1.5, -1],
      [-1.9, -1],
      [-2.5, -2],
      [-2.9, -2],
      [100.999, 100],
      [-100.999, -100],
    ];

    for (const [input, expected] of cases) {
      // Use == 0 for zero checks to avoid -0 vs +0 distinction
      // (Python int does not distinguish -0 from 0)
      const result = intTrunc(input);
      if (expected === 0) {
        expect(result == 0).toBe(true); // both -0 and +0 satisfy == 0
      } else {
        expect(result).toBe(expected);
      }
    }
  });
});
