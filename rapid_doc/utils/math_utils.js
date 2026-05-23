// Copyright (c) Opendatalab. All rights reserved.
/**
 * Shared math helpers for parity with Python numeric semantics.
 *
 * Design rules (Requirement 1.3, 1.4 / Audit anti-patterns):
 *   - All functions are pure — no imports from cv or ort.
 *   - null / NaN / ±Infinity inputs return 0 (safe for coordinate pipelines).
 *   - intTrunc  → Python int()    / numpy astype(int)   → Math.trunc
 *   - bankerRound → Python round() / numpy round()      → half-to-even
 *   - tensorToNumber → BigInt → Number coercion before arithmetic
 *   - tensorDataToFloat64 → flat typed-array → Float64Array for mixed sources
 */

/**
 * Truncate a number toward zero — matches Python `int()` and `numpy.astype(int)`.
 *
 * Use instead of `Math.round()` wherever Python code uses `int()` truncation
 * on coordinates or histogram indices (Audit finding L9, R5, R7, R8, R9, T10).
 *
 * @param {number} x  Input value (may be NaN / ±Infinity / null / undefined).
 * @returns {number}  Integer (Math.trunc semantics), or 0 for non-finite input.
 *
 * @example
 * intTrunc(2.9)   // 2   (Python int(2.9)  → 2)
 * intTrunc(-2.9)  // -2  (Python int(-2.9) → -2)
 * intTrunc(NaN)   // 0
 */
export function intTrunc(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.trunc(x);
}

/**
 * Banker's rounding (round-half-to-even) — matches Python `round()` and
 * `numpy.round()`.
 *
 * Standard `Math.round` uses round-half-up, which drifts from Python for
 * values exactly at .5 boundaries. Use this function for coordinates that
 * Python rounds with `round()`.
 *
 * @param {number} x  Input value (may be NaN / ±Infinity / null / undefined).
 * @returns {number}  Nearest integer (half-to-even tie-break), or 0 for
 *                    non-finite input.
 *
 * @example
 * bankerRound(0.5)  // 0  (Python round(0.5) → 0, rounds to even)
 * bankerRound(1.5)  // 2  (Python round(1.5) → 2, rounds to even)
 * bankerRound(2.5)  // 2  (Python round(2.5) → 2, rounds to even)
 * bankerRound(3.5)  // 4  (Python round(3.5) → 4, rounds to even)
 * bankerRound(NaN)  // 0
 */
export function bankerRound(x) {
  if (!Number.isFinite(x)) return 0;
  const floor = Math.floor(x);
  // Check if x is exactly at a half-way point (within floating-point tolerance)
  if (Math.abs(x - floor - 0.5) < 1e-9) {
    // Half-to-even: pick the even neighbour
    return floor % 2 === 0 ? floor : Math.ceil(x);
  }
  return Math.round(x);
}

/**
 * Coerce an ONNX tensor data element to a plain `Number`.
 *
 * ONNX int64 tensor outputs arrive as `BigInt` in onnxruntime-web, which
 * causes `TypeError: Cannot mix BigInt and other types` in arithmetic.
 * Wrap any tensor element with this before doing math (Audit finding L1).
 *
 * @param {number|bigint|null|undefined} v  Raw tensor element.
 * @returns {number}  Number value, or 0 for null / undefined input.
 *
 * @example
 * tensorToNumber(42n)   // 42
 * tensorToNumber(3.14)  // 3.14
 * tensorToNumber(null)  // 0
 */
export function tensorToNumber(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'bigint') return Number(v);
  return v;
}

/**
 * Convert flat tensor data (any typed-array or plain array) to a
 * `Float64Array` of `Number` values, handling `BigInt64Array` safely.
 *
 * ONNX int64 outputs produce `BigInt64Array` in onnxruntime-web; `Float64Array
 * .from()` cannot convert BigInt elements without an explicit coercion step.
 *
 * @param {Float32Array|Float64Array|Int32Array|BigInt64Array|number[]|null|undefined} data
 *   Source typed-array or plain array.
 * @returns {Float64Array}  Numeric float64 view of the data, or an empty
 *   `Float64Array` for null / undefined input.
 *
 * @example
 * tensorDataToFloat64(new BigInt64Array([1n, 2n, 3n]))
 *   // Float64Array [1, 2, 3]
 * tensorDataToFloat64(new Float32Array([0.5, 1.5]))
 *   // Float64Array [0.5, 1.5]
 * tensorDataToFloat64(null)
 *   // Float64Array []
 */
export function tensorDataToFloat64(data) {
  if (data === null || data === undefined) return new Float64Array(0);
  if (data instanceof BigInt64Array) {
    const out = new Float64Array(data.length);
    for (let i = 0; i < data.length; i++) {
      out[i] = Number(data[i]);
    }
    return out;
  }
  return Float64Array.from(data);
}
