/**
 * Regression test for _normalize workaround removal.
 *
 * The `_normalize` method in `UniMERNetDecode` was a workaround that masked
 * the root-cause bug (a BGR/RGB channel swap in pre_process.js). Now that the
 * swap is fixed, `_normalize` was removed as dead code.
 *
 * These tests assert that:
 *   1. `_normalize` is NOT a method on `UniMERNetDecode` instances.
 *   2. `_normalize` is NOT exported from the post_process module.
 *   3. `tokenToStr` still works correctly without the workaround.
 */

import { describe, it, expect } from 'vitest';
import { UniMERNetDecode, PPPostProcess } from '../../rapid_doc/model/formula/rapid_formula_self/model_handler/pp_formulanet_plus/post_process.js';

// Minimal tokenizer JSON with a small vocab sufficient for testing
const MINIMAL_TOKENIZER_JSON = JSON.stringify({
  model: {
    vocab: {
      'x': 3,
      '+': 4,
      '=': 5,
      '1': 6,
      '\\frac': 7,
    },
  },
  added_tokens: [
    { id: 0, content: '<sos>', special: true },
    { id: 1, content: '<pad>', special: true },
    { id: 2, content: '<eos>', special: true },
  ],
});

// ─── the fix regression: _normalize must not exist ────────────────────────────

describe('UniMERNetDecode: _normalize workaround removed', () => {
  it('UniMERNetDecode instance does NOT have a _normalize method', () => {
    const decoder = new UniMERNetDecode(MINIMAL_TOKENIZER_JSON);
    expect(typeof decoder._normalize).toBe('undefined');
  });

  it('_normalize is NOT present anywhere on UniMERNetDecode prototype', () => {
    expect(Object.prototype.hasOwnProperty.call(UniMERNetDecode.prototype, '_normalize')).toBe(false);
    expect('_normalize' in UniMERNetDecode.prototype).toBe(false);
  });

  it('_normalize is NOT exported from the post_process module', async () => {
    const mod = await import('../../rapid_doc/model/formula/rapid_formula_self/model_handler/pp_formulanet_plus/post_process.js');
    expect(mod._normalize).toBeUndefined();
  });

  it('PPPostProcess decoder instance also does NOT have _normalize', () => {
    const pp = new PPPostProcess(MINIMAL_TOKENIZER_JSON);
    expect(typeof pp.decoder._normalize).toBe('undefined');
  });
});

// ─── Sanity: tokenToStr still works correctly after workaround removal ────────

describe('UniMERNetDecode: tokenToStr still functions without _normalize', () => {
  it('decodes known token IDs to the expected string', () => {
    const decoder = new UniMERNetDecode(MINIMAL_TOKENIZER_JSON);
    // token IDs: x(3) + (4) =(5) → "x+=" (no special tokens)
    const result = decoder.tokenToStr([3, 4, 5]);
    expect(typeof result).toBe('string');
    // The result should contain the decoded tokens
    expect(result).toContain('x');
    expect(result).toContain('+');
    expect(result).toContain('=');
  });

  it('special tokens (SOS, PAD, EOS) are filtered from output', () => {
    const decoder = new UniMERNetDecode(MINIMAL_TOKENIZER_JSON);
    // SOS(0) x(3) EOS(2) → should only include "x"
    const result = decoder.tokenToStr([0, 3, 2]);
    expect(result).not.toContain('<sos>');
    expect(result).not.toContain('<eos>');
    expect(result).toContain('x');
  });

  it('empty token list returns empty string', () => {
    const decoder = new UniMERNetDecode(MINIMAL_TOKENIZER_JSON);
    const result = decoder.tokenToStr([]);
    expect(result).toBe('');
  });

  it('run() returns array of strings (end-to-end decode still works)', () => {
    const decoder = new UniMERNetDecode(MINIMAL_TOKENIZER_JSON);
    const vocabSize = 8;
    const seqLen = 3;
    // Fake [1, seqLen, vocabSize] preds tensor — argmax at index 3 (token 'x')
    const data = new Float32Array(1 * seqLen * vocabSize);
    for (let s = 0; s < seqLen; s++) {
      data[s * vocabSize + 3] = 1.0; // argmax = 3 → 'x'
    }
    const preds = { data, dims: [1, seqLen, vocabSize], cpuData: null };
    const results = decoder.run(preds);
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(1);
    expect(typeof results[0]).toBe('string');
  });
});
