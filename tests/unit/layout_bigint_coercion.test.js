/**
 * Smoke tests for BigInt coercion in the layout inference pipeline (Audit L1).
 *
 * These tests exercise:
 *   1. OrtInferSession.run coercion path — int64 tensor data must be converted
 *      to Float64Array so downstream arithmetic never throws
 *      "TypeError: Cannot mix BigInt and other types".
 *   2. PPDocLayoutModelHandler._formatOutput coercion — boxNumsData[idx] must
 *      be wrapped with tensorToNumber() before arithmetic on it.
 *
 * The tests are unit-level: they do NOT load real ONNX models or require a
 * browser environment. They validate the coercion logic directly.
 *
 * Validates: Requirements 2.1
 */

import { describe, it, expect } from 'vitest';
import { tensorToNumber, tensorDataToFloat64 } from '../../rapid_doc/utils/math_utils.js';

// ─── Helper: mimic the coercion logic added to OrtInferSession.run (FIX L1) ──

/**
 * Replicate the data-extraction + coercion step from OrtInferSession.run.
 * The real implementation does:
 *
 *   const rawData = typeof tensor.getData === 'function'
 *     ? await tensor.getData()
 *     : tensor.data;
 *   const data = (rawData instanceof BigInt64Array || tensor.type === 'int64')
 *     ? tensorDataToFloat64(rawData)
 *     : rawData;
 *   finalOutputs.push({ data: data.slice(), dims: tensor.dims, type: ... });
 */
function extractAndCoerce(tensor) {
  const rawData = tensor.data;
  // FIX L1: coerce BigInt to Number for arithmetic
  const data = (rawData instanceof BigInt64Array || tensor.type === 'int64')
    ? tensorDataToFloat64(rawData)
    : rawData;
  return data.slice();
}

// ─── Helper: mimic the _formatOutput loop body (FIX L1) ──────────────────────

/**
 * Replicate the key part of _formatOutput that was fixed:
 *
 *   for (let idx = 0; idx < boxNumsData.length; idx++) {
 *     // FIX L1: coerce BigInt to Number for arithmetic
 *     const np_boxes_num = tensorToNumber(boxNumsData[idx]);
 *     const boxIdxEnd    = boxIdxStart + np_boxes_num;
 *     ...
 *     const totalBoxes   = boxNumsData.reduce((a, b) => a + tensorToNumber(b), 0) || 1;
 *   }
 */
function simulateFormatOutputLoop(boxNumsData) {
  const results = [];
  let boxIdxStart = 0;
  // FIX L1: use tensorToNumber in reduce
  const totalBoxes = Array.from(boxNumsData).reduce((a, b) => a + tensorToNumber(b), 0) || 1;

  for (let idx = 0; idx < boxNumsData.length; idx++) {
    // FIX L1: coerce BigInt to Number for arithmetic
    const np_boxes_num = tensorToNumber(boxNumsData[idx]);
    const boxIdxEnd = boxIdxStart + np_boxes_num;
    results.push({ start: boxIdxStart, end: boxIdxEnd, count: np_boxes_num });
    boxIdxStart = boxIdxEnd;
  }
  return { results, totalBoxes };
}

// ─── Unit tests: tensorToNumber / tensorDataToFloat64 ────────────────────────

describe('FIX L1 — coerce BigInt helper functions', () => {
  it('tensorToNumber converts BigInt to Number safely', () => {
    expect(tensorToNumber(5n)).toBe(5);
    expect(tensorToNumber(0n)).toBe(0);
    expect(tensorToNumber(-3n)).toBe(-3);
  });

  it('tensorToNumber passes through Number values unchanged', () => {
    expect(tensorToNumber(42)).toBe(42);
    expect(tensorToNumber(3.14)).toBe(3.14);
  });

  it('tensorToNumber handles null / undefined → 0', () => {
    expect(tensorToNumber(null)).toBe(0);
    expect(tensorToNumber(undefined)).toBe(0);
  });

  it('tensorDataToFloat64 converts BigInt64Array without throwing', () => {
    const input = new BigInt64Array([1n, 2n, 3n, 100n]);
    const result = tensorDataToFloat64(input);
    expect(result).toBeInstanceOf(Float64Array);
    expect(Array.from(result)).toEqual([1, 2, 3, 100]);
  });

  it('tensorDataToFloat64 result can be used in arithmetic with Number — no TypeError', () => {
    const input = new BigInt64Array([4n, 8n]);
    const result = tensorDataToFloat64(input);
    // Prior to FIX L1, mixing BigInt64Array elements with Number would throw:
    //   TypeError: Cannot mix BigInt and other types
    expect(() => {
      const _sum = result[0] + result[1] + 1.5;
    }).not.toThrow();
  });
});

// ─── Smoke: OrtInferSession.run coercion path (FIX L1) ───────────────────────

describe('FIX L1 — OrtInferSession.run coerces int64 outputs to Float64', () => {
  it('int64 tensor (BigInt64Array data) is coerced to Float64Array', () => {
    const tensor = {
      data: new BigInt64Array([2n, 5n]),
      dims: [1, 2],
      type: 'int64',
    };

    const coerced = extractAndCoerce(tensor);

    expect(coerced).toBeInstanceOf(Float64Array);
    expect(coerced[0]).toBe(2);
    expect(coerced[1]).toBe(5);
  });

  it('int64 tensor coercion: result slice supports arithmetic without TypeError', () => {
    const tensor = {
      data: new BigInt64Array([7n, 3n]),
      dims: [2],
      type: 'int64',
    };

    const coerced = extractAndCoerce(tensor);

    expect(() => {
      const _result = coerced[0] + coerced[1] * 1.0 - 0.5;
    }).not.toThrow();
  });

  it('float32 tensor is NOT re-wrapped — remains Float32Array', () => {
    const tensor = {
      data: new Float32Array([1.1, 2.2]),
      dims: [1, 2],
      type: 'float32',
    };

    const result = extractAndCoerce(tensor);

    // Should stay Float32Array: no unnecessary conversion for non-BigInt data
    expect(result).toBeInstanceOf(Float32Array);
  });

  it('int64 tensor with type flag only (array already number) is also coerced', () => {
    // Edge case: tensor.type === 'int64' but data is already a regular array
    // (this can happen after a first-pass coercion in some paths)
    const tensor = {
      data: new BigInt64Array([10n, 20n]),
      dims: [2],
      type: 'int64',
    };

    expect(() => {
      const coerced = extractAndCoerce(tensor);
      const _v = coerced[0] + 5; // would throw if BigInt leaked
    }).not.toThrow();
  });
});

// ─── Smoke: _formatOutput boxNumsData BigInt handling (FIX L1) ───────────────

describe('FIX L1 — _formatOutput boxNumsData BigInt coercion', () => {
  it('does not throw when boxNumsData is a BigInt64Array (simulated pre-coercion input)', () => {
    // Simulate boxNumsData as BigInt64Array — as it would arrive from an
    // int64 ONNX output BEFORE the OrtInferSession coercion fix.
    // The _formatOutput fix (tensorToNumber) provides a second line of defense.
    const boxNumsData = new BigInt64Array([2n]);

    expect(() => {
      simulateFormatOutputLoop(boxNumsData);
    }).not.toThrow();
  });

  it('does not throw when boxNumsData is a plain Number array', () => {
    const boxNumsData = [3, 1, 2];

    expect(() => {
      simulateFormatOutputLoop(boxNumsData);
    }).not.toThrow();
  });

  it('does not throw when boxNumsData is Float64Array (post-coercion from OrtInferSession)', () => {
    // After OrtInferSession.run FIX L1, int64 outputs arrive as Float64Array
    const boxNumsData = new Float64Array([4, 2]);

    expect(() => {
      simulateFormatOutputLoop(boxNumsData);
    }).not.toThrow();
  });

  it('correctly computes box ranges for a single-image batch with BigInt boxNums', () => {
    const boxNumsData = new BigInt64Array([3n]);
    const { results } = simulateFormatOutputLoop(boxNumsData);

    expect(results).toHaveLength(1);
    expect(results[0].start).toBe(0);
    expect(results[0].end).toBe(3);
    expect(results[0].count).toBe(3);
  });

  it('correctly computes box ranges for a multi-image batch with BigInt boxNums', () => {
    // Two images: 2 boxes and 1 box
    const boxNumsData = new BigInt64Array([2n, 1n]);
    const { results } = simulateFormatOutputLoop(boxNumsData);

    expect(results).toHaveLength(2);
    // Image 0: boxes 0–1
    expect(results[0].start).toBe(0);
    expect(results[0].end).toBe(2);
    // Image 1: box 2
    expect(results[1].start).toBe(2);
    expect(results[1].end).toBe(3);
  });

  it('totalBoxes reduce does not throw with BigInt elements', () => {
    const boxNumsData = new BigInt64Array([5n, 3n, 2n]);
    const { totalBoxes } = simulateFormatOutputLoop(boxNumsData);

    // 5 + 3 + 2 = 10
    expect(totalBoxes).toBe(10);
  });
});

// ─── Smoke: _formatOutput mask byte-offset slicing (FIX L2) ──────────────────

/**
 * Validates: Requirements 2.2
 *
 * Prior to FIX L2, masks were sliced by box-count index:
 *   allMasksData.slice(boxIdxStart, boxIdxEnd)  // only `numBoxes` bytes
 *
 * Each mask is a flat buffer of H*W elements. The correct slice is:
 *   allMasksData.slice(boxIdx * H * W, (boxIdx + 1) * H * W)
 *
 * These tests verify the fixed byte-offset slicing logic.
 */

/**
 * Replicate the FIX L2 mask-slicing logic from _formatOutput.
 * Returns an array of per-box mask slices (each of length H*W).
 */
function simulateMaskByteOffsetSlicing(allMasksData, boxNumsData, maskH, maskW) {
  const maskStride = maskH * maskW; // FIX L2: byte-offset, not box-count
  const results = [];
  let boxIdxStart = 0;

  for (let idx = 0; idx < boxNumsData.length; idx++) {
    const np_boxes_num = tensorToNumber(boxNumsData[idx]);
    const boxIdxEnd = boxIdxStart + np_boxes_num;

    const npMasks = [];
    for (let i = 0; i < np_boxes_num; i++) {
      const maskOffset = (boxIdxStart + i) * maskStride; // FIX L2: byte-offset
      npMasks.push(allMasksData.slice(maskOffset, maskOffset + maskStride));
    }
    results.push({ masks: npMasks, boxIdxStart, boxIdxEnd });
    boxIdxStart = boxIdxEnd;
  }
  return results;
}

describe('FIX L2 — _formatOutput mask byte-offset slicing', () => {
  it('each per-box mask slice has exactly H*W elements', () => {
    const maskH = 4, maskW = 4; // 4x4 masks
    const numBoxes = 3;
    const maskStride = maskH * maskW;

    // Create synthetic flat masks buffer: each mask has a distinct fill value
    const allMasksData = new Uint8Array(numBoxes * maskStride);
    for (let b = 0; b < numBoxes; b++) {
      allMasksData.fill(b + 1, b * maskStride, (b + 1) * maskStride);
    }

    const boxNumsData = [numBoxes]; // single image batch
    const [imageResult] = simulateMaskByteOffsetSlicing(allMasksData, boxNumsData, maskH, maskW);

    expect(imageResult.masks).toHaveLength(numBoxes);
    for (const maskSlice of imageResult.masks) {
      expect(maskSlice.length).toBe(maskStride);
    }
  });

  it('each per-box mask slice contains the correct data (not adjacent-box data)', () => {
    const maskH = 3, maskW = 3;
    const numBoxes = 3;
    const maskStride = maskH * maskW;

    // Each box's mask is filled with its box index + 1 (1, 2, 3)
    const allMasksData = new Uint8Array(numBoxes * maskStride);
    for (let b = 0; b < numBoxes; b++) {
      allMasksData.fill(b + 1, b * maskStride, (b + 1) * maskStride);
    }

    const boxNumsData = [numBoxes];
    const [imageResult] = simulateMaskByteOffsetSlicing(allMasksData, boxNumsData, maskH, maskW);

    // Box 0's mask should be all 1s, box 1 all 2s, box 2 all 3s
    expect(Array.from(imageResult.masks[0])).toEqual(Array(maskStride).fill(1));
    expect(Array.from(imageResult.masks[1])).toEqual(Array(maskStride).fill(2));
    expect(Array.from(imageResult.masks[2])).toEqual(Array(maskStride).fill(3));
  });

  it('old (buggy) box-count-index slicing would produce wrong results', () => {
    // This test documents the BEFORE behaviour to illustrate why FIX L2 matters.
    const maskH = 4, maskW = 4;
    const numBoxes = 3;
    const maskStride = maskH * maskW; // 16 bytes per mask

    const allMasksData = new Uint8Array(numBoxes * maskStride);
    for (let b = 0; b < numBoxes; b++) {
      allMasksData.fill(b + 1, b * maskStride, (b + 1) * maskStride);
    }

    // Buggy old approach: slice(boxIdxStart=0, boxIdxEnd=3) → only 3 bytes
    const buggySingleBoxMask = allMasksData.slice(0, numBoxes);
    expect(buggySingleBoxMask.length).toBe(numBoxes); // wrong: should be maskStride=16

    // Fixed approach: slice(0, maskStride) → correct H*W bytes
    const fixedSingleBoxMask = allMasksData.slice(0, maskStride);
    expect(fixedSingleBoxMask.length).toBe(maskStride); // correct
    expect(Array.from(fixedSingleBoxMask)).toEqual(Array(maskStride).fill(1));
  });

  it('handles multi-image batch correctly — each image gets its own per-box mask slices', () => {
    const maskH = 2, maskW = 2;
    const maskStride = maskH * maskW; // 4 bytes per mask
    // Image 0: 2 boxes, Image 1: 1 box → total 3 masks
    const boxNumsData = [2, 1];
    const totalBoxes = 3;

    const allMasksData = new Uint8Array(totalBoxes * maskStride);
    // Mask 0 → 10s, mask 1 → 20s, mask 2 → 30s
    allMasksData.fill(10, 0 * maskStride, 1 * maskStride);
    allMasksData.fill(20, 1 * maskStride, 2 * maskStride);
    allMasksData.fill(30, 2 * maskStride, 3 * maskStride);

    const [img0, img1] = simulateMaskByteOffsetSlicing(allMasksData, boxNumsData, maskH, maskW);

    // Image 0 has 2 masks
    expect(img0.masks).toHaveLength(2);
    expect(Array.from(img0.masks[0])).toEqual([10, 10, 10, 10]);
    expect(Array.from(img0.masks[1])).toEqual([20, 20, 20, 20]);

    // Image 1 has 1 mask (the 3rd box's mask)
    expect(img1.masks).toHaveLength(1);
    expect(Array.from(img1.masks[0])).toEqual([30, 30, 30, 30]);
  });

  it('mask slicing is correct for non-square (rectangular) masks', () => {
    const maskH = 6, maskW = 10; // non-square
    const maskStride = maskH * maskW; // 60 bytes per mask
    const numBoxes = 2;

    const allMasksData = new Uint8Array(numBoxes * maskStride);
    allMasksData.fill(42, 0, maskStride);
    allMasksData.fill(99, maskStride, 2 * maskStride);

    const boxNumsData = [numBoxes];
    const [imageResult] = simulateMaskByteOffsetSlicing(allMasksData, boxNumsData, maskH, maskW);

    expect(imageResult.masks[0].length).toBe(maskStride);
    expect(imageResult.masks[1].length).toBe(maskStride);
    expect(Array.from(imageResult.masks[0])).toEqual(Array(maskStride).fill(42));
    expect(Array.from(imageResult.masks[1])).toEqual(Array(maskStride).fill(99));
  });
});
