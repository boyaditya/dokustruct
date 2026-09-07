import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  bytesMd5,
  strMd5,
  makeHashable,
  strSha256,
} from '@rapid_doc/utils/hash_utils.js';

describe('hash_utils — MD5', () => {
  it('bytesMd5 matches Node crypto for arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 255, 128, 64]);
    const expected = createHash('md5').update(bytes).digest('hex');
    expect(bytesMd5(bytes)).toBe(expected);
  });

  it('strMd5 matches Node crypto and bytesMd5(TextEncoder)', () => {
    const text = 'Hello DokuStruct × α 中';
    const expected = createHash('md5').update(Buffer.from(text, 'utf8')).digest('hex');
    expect(strMd5(text)).toBe(expected);
    expect(strMd5(text)).toBe(bytesMd5(new TextEncoder().encode(text)));
  });

  it('bytesMd5 is stable for empty input', () => {
    const expected = createHash('md5').update(new Uint8Array([])).digest('hex');
    expect(bytesMd5(new Uint8Array([]))).toBe(expected);
    expect(bytesMd5(new Uint8Array([]))).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('bytesMd5 accepts ArrayBuffer', () => {
    const buf = new Uint8Array([10, 20, 30]).buffer;
    const expected = createHash('md5').update(new Uint8Array(buf)).digest('hex');
    expect(bytesMd5(buf)).toBe(expected);
  });

  it('strSha256 matches Node crypto (async SubtleCrypto)', async () => {
    const text = 'rapid_doc hash parity';
    const expected = createHash('sha256').update(text, 'utf8').digest('hex');
    const got = await strSha256(text);
    expect(got).toBe(expected);
  });
});

describe('hash_utils — makeHashable', () => {
  it('produces stable sorted JSON for object keys', () => {
    const a = makeHashable({ b: 2, a: 1 });
    const b = makeHashable({ a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2}');
  });

  it('recurses into nested objects and arrays', () => {
    const val = { outer: { inner: 2, a: 1 }, list: [3, { z: 9, y: 8 }] };
    const hashed = makeHashable(val);
    // outer should be JSON string with sorted keys
    expect(hashed).toContain('"outer"');
    expect(typeof hashed).toBe('string');
    // Should be deterministic
    expect(makeHashable(val)).toBe(hashed);
  });

  it('replaces custom_model value with type name', () => {
    class FakeModel { predict() {} }
    const fake = new FakeModel();
    const hashed = makeHashable({ custom_model: fake, other: 1 });
    expect(hashed).toContain('"custom_model":"FakeModel"');
    expect(hashed).not.toContain('predict');
  });

  it('handles custom_model null', () => {
    const hashed = makeHashable({ custom_model: null });
    expect(hashed).toContain('"custom_model":"null"');
  });

  it('passes through primitives and arrays as JSON', () => {
    expect(makeHashable(null)).toBe(null);
    expect(makeHashable(42)).toBe(42);
    expect(makeHashable('str')).toBe('str');
    expect(makeHashable([1, 2])).toBe('[1,2]');
    expect(makeHashable([1, { b: 2, a: 1 }])).toBeDefined();
  });

  it('is deterministic across calls (used for AtomModelSingleton keys)', () => {
    const cfg1 = { layout_config: { model_type: 'pp_doclayoutv2' }, lang: 'ch' };
    const cfg2 = { lang: 'ch', layout_config: { model_type: 'pp_doclayoutv2' } };
    // Same content, different key order → same hashable after sorting outer keys,
    // but inner objects are sorted as well
    expect(makeHashable(cfg1)).toBe(makeHashable(cfg2));
  });
});
