/**
 * Unit tests for Audit F4: HuggingFace byte-level BPE inverse map.
 *
 * Tests cover:
 *   1. `gpt2BytesToUnicodeInverse()` helper — map correctness & caching
 *   2. `decodeByteLevelToken()` — Greek/CJK escape round-trip, ASCII pass-through, LaTeX fall-back
 *   3. `UniMERNetDecode.tokenToStr()` — byte-encoded tokens produce correct UTF-8 in output
 *
 * Validates: Requirements 7.6
 */

import { describe, it, expect } from 'vitest';
import {
  gpt2BytesToUnicodeInverse,
  decodeByteLevelToken,
} from '../../rapid_doc/model/formula/rapid_formula_self/model_handler/pp_formulanet_plus/utils.js';
import { UniMERNetDecode } from '../../rapid_doc/model/formula/rapid_formula_self/model_handler/pp_formulanet_plus/post_process.js';

// ─── gpt2BytesToUnicodeInverse ────────────────────────────────────────────────

describe('gpt2BytesToUnicodeInverse()', () => {
  it('returns a Map', () => {
    const inv = gpt2BytesToUnicodeInverse();
    expect(inv).toBeInstanceOf(Map);
  });

  it('has exactly 256 entries (one per byte value)', () => {
    const inv = gpt2BytesToUnicodeInverse();
    expect(inv.size).toBe(256);
  });

  it('all byte values 0–255 are covered (range check)', () => {
    const inv = gpt2BytesToUnicodeInverse();
    const vals = new Set(inv.values());
    for (let b = 0; b < 256; b++) {
      expect(vals.has(b)).toBe(true);
    }
  });

  it('all 256 keys are unique single characters', () => {
    const inv = gpt2BytesToUnicodeInverse();
    expect(inv.size).toBe(256);
    for (const [ch] of inv) {
      // Each key must be exactly one Unicode code point
      expect([...ch].length).toBe(1);
    }
  });

  it('identity for printable ASCII range (byte === charCode for 0x21–0x7E)', () => {
    const inv = gpt2BytesToUnicodeInverse();
    // Per GPT-2 bytes_to_unicode: bytes in 0x21–0x7E map to the same unicode char
    // So the inverse (unicode char → byte) must round-trip: '!' → 0x21, etc.
    expect(inv.get('!')).toBe(0x21);  // 33
    expect(inv.get('~')).toBe(0x7E);  // 126
    expect(inv.get('A')).toBe(0x41);  // 65
    expect(inv.get('z')).toBe(0x7A);  // 122
  });

  it('space (byte 0x20) is mapped to a non-space Unicode char (since 0x20 is excluded from printable range)', () => {
    const inv = gpt2BytesToUnicodeInverse();
    // Byte 0x20 is NOT in the printable ranges, so it gets mapped to unicode 256+n
    // This means no key in the inverse map should decode *to* byte 0x20 via a literal space char
    // The inverse key for byte 0x20 should be a char > U+00FF
    let spaceKey = null;
    for (const [ch, val] of inv) {
      if (val === 0x20) { spaceKey = ch; break; }
    }
    expect(spaceKey).not.toBeNull();
    expect(spaceKey.codePointAt(0)).toBeGreaterThanOrEqual(256);
  });

  it('returns the same Map instance on subsequent calls (cached)', () => {
    const inv1 = gpt2BytesToUnicodeInverse();
    const inv2 = gpt2BytesToUnicodeInverse();
    expect(inv1).toBe(inv2);
  });
});

// ─── decodeByteLevelToken ─────────────────────────────────────────────────────

describe('decodeByteLevelToken()', () => {
  const inverseMap = gpt2BytesToUnicodeInverse();

  /**
   * Build the GPT-2 BPE forward map (byte → unicode char) so tests can encode
   * known byte sequences and then verify that decodeByteLevelToken reverses them.
   */
  function buildForwardMap() {
    const fwd = new Map(); // byte value → unicode char
    for (const [ch, b] of inverseMap) fwd.set(b, ch);
    return fwd;
  }

  it('round-trips a single ASCII byte (e.g. byte 65 → "A")', () => {
    const fwd = buildForwardMap();
    // byte 65 = 'A' (0x41) is in the printable range → encoded as 'A' in GPT-2 BPE
    const encodedToken = fwd.get(65);
    const decoded = decodeByteLevelToken(encodedToken, inverseMap);
    expect(decoded).toBe('A');
  });

  it('round-trips a Greek letter alpha (U+03B1, UTF-8 0xCE 0xB1)', () => {
    const fwd = buildForwardMap();
    // Greek alpha = U+03B1, UTF-8 bytes: 0xCE, 0xB1
    const encodedToken = fwd.get(0xCE) + fwd.get(0xB1);
    const decoded = decodeByteLevelToken(encodedToken, inverseMap);
    expect(decoded).toBe('α');
  });

  it('round-trips a CJK character 中 (U+4E2D, UTF-8 0xE4 0xB8 0xAD)', () => {
    const fwd = buildForwardMap();
    // 中 = U+4E2D, UTF-8 bytes: 0xE4, 0xB8, 0xAD
    const encodedToken = fwd.get(0xE4) + fwd.get(0xB8) + fwd.get(0xAD);
    const decoded = decodeByteLevelToken(encodedToken, inverseMap);
    expect(decoded).toBe('中');
  });

  it('round-trips a multi-byte Greek word "αβγ" split across one token', () => {
    const fwd = buildForwardMap();
    // UTF-8 bytes for αβγ:
    // α = 0xCE 0xB1
    // β = 0xCE 0xB2
    // γ = 0xCE 0xB3
    const encoded =
      fwd.get(0xCE) + fwd.get(0xB1) +
      fwd.get(0xCE) + fwd.get(0xB2) +
      fwd.get(0xCE) + fwd.get(0xB3);
    const decoded = decodeByteLevelToken(encoded, inverseMap);
    expect(decoded).toBe('αβγ');
  });

  it('falls back to returning token as-is when it contains unmapped characters (e.g. a backslash)', () => {
    // LaTeX tokens like '\frac' contain '\' which is NOT in the GPT-2 inverse map
    // (since '\' = 0x5C is in the printable ASCII range and maps to itself — actually it IS mapped)
    // Let's use a character that is definitely not in the map: a raw emoji that GPT-2 does encode
    // but to avoid complexity, test with a known LaTeX-style token containing chars in the map
    // Actually '\' (0x5C) IS in the map, so use a token with literal chars outside the 256 range.
    // We force unmapped by using a direct string that contains a char > 0xFFFF (emoji):
    const unmappedChar = '\u{1F600}'; // emoji not in the 256-entry map
    const token = 'A' + unmappedChar;
    const decoded = decodeByteLevelToken(token, inverseMap);
    // Should fall back to original token unchanged
    expect(decoded).toBe(token);
  });

  it('handles a token consisting of only mapped characters for space byte (0x20)', () => {
    const fwd = buildForwardMap();
    // Byte 0x20 (space) is encoded as some unicode char > 0xFF in GPT-2 BPE
    const encodedSpace = fwd.get(0x20);
    const decoded = decodeByteLevelToken(encodedSpace, inverseMap);
    expect(decoded).toBe(' ');
  });
});

// ─── UniMERNetDecode.tokenToStr with byte-encoded tokens ─────────────────────

describe('UniMERNetDecode.tokenToStr() — byte-level BPE tokens', () => {
  /**
   * Build a synthetic tokenizer JSON that maps token IDs to GPT-2-BPE-encoded
   * Unicode strings for Greek and CJK characters.
   *
   * We encode known UTF-8 byte sequences using the forward map so that
   * tokenToStr should decode them back to the original characters.
   */
  function buildTokenizerWithByteEncodedTokens() {
    const fwd = new Map(); // byte → unicode char
    const inv = gpt2BytesToUnicodeInverse();
    for (const [ch, b] of inv) fwd.set(b, ch);

    // Greek alpha α = UTF-8 0xCE 0xB1 → encoded as two chars
    const alphaToken = fwd.get(0xCE) + fwd.get(0xB1);
    // CJK 中 = UTF-8 0xE4 0xB8 0xAD → encoded as three chars
    const zhToken = fwd.get(0xE4) + fwd.get(0xB8) + fwd.get(0xAD);
    // Plain ASCII 'x' (byte 0x78) → encodes as 'x' (identity)
    const xToken = fwd.get(0x78); // should be 'x'

    return {
      json: JSON.stringify({
        model: {
          vocab: {
            [alphaToken]: 10,
            [zhToken]: 11,
            [xToken]: 12,
          },
        },
        added_tokens: [
          { id: 0, content: '<sos>', special: true },
          { id: 1, content: '<pad>', special: true },
          { id: 2, content: '<eos>', special: true },
        ],
      }),
      alphaId: 10,
      zhId: 11,
      xId: 12,
    };
  }

  it('decodes Greek letter token to actual α character', () => {
    const { json, alphaId } = buildTokenizerWithByteEncodedTokens();
    const decoder = new UniMERNetDecode(json);
    const result = decoder.tokenToStr([alphaId]);
    expect(result).toContain('α');
  });

  it('decodes CJK token to actual 中 character', () => {
    const { json, zhId } = buildTokenizerWithByteEncodedTokens();
    const decoder = new UniMERNetDecode(json);
    const result = decoder.tokenToStr([zhId]);
    expect(result).toContain('中');
  });

  it('decodes sequence [α, x, 中] correctly with byte-level mapping', () => {
    const { json, alphaId, xId, zhId } = buildTokenizerWithByteEncodedTokens();
    const decoder = new UniMERNetDecode(json);
    const result = decoder.tokenToStr([alphaId, xId, zhId]);
    expect(result).toContain('α');
    expect(result).toContain('x');
    expect(result).toContain('中');
  });

  it('decodes a UTF-8 character when byte-level pieces are split across tokens', () => {
    const inv = gpt2BytesToUnicodeInverse();
    const fwd = new Map();
    for (const [ch, b] of inv) fwd.set(b, ch);

    const json = JSON.stringify({
      model: {
        vocab: {
          [fwd.get(0xCE)]: 20,
          [fwd.get(0xB1)]: 21,
        },
      },
      added_tokens: [
        { id: 0, content: '<sos>', special: true },
        { id: 1, content: '<pad>', special: true },
        { id: 2, content: '<eos>', special: true },
      ],
    });

    const decoder = new UniMERNetDecode(json);
    expect(decoder.tokenToStr([20, 21])).toBe('\u03b1');
  });

  it('still filters special tokens correctly after F4 patch', () => {
    const { json, alphaId } = buildTokenizerWithByteEncodedTokens();
    const decoder = new UniMERNetDecode(json);
    const result = decoder.tokenToStr([0, alphaId, 2]); // SOS, alpha, EOS
    expect(result).not.toContain('<sos>');
    expect(result).not.toContain('<eos>');
    expect(result).toContain('α');
  });
});
