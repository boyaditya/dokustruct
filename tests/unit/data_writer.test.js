import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryDataWriter,
  FileBasedDataWriter,
  FileBasedDataReader,
  DataWriter,
  DataReader,
} from '@rapid_doc/data/data_reader_writer/index.js';

describe('MemoryDataWriter', () => {
  it('stores and retrieves binary data', () => {
    const w = new MemoryDataWriter();
    const data = new Uint8Array([1, 2, 3]);
    w.write('a/b.bin', data);
    expect(w.get('a/b.bin')).toEqual(data);
    expect(w.getStore().has('a/b.bin')).toBe(true);
  });

  it('converts ArrayBuffer to Uint8Array', () => {
    const w = new MemoryDataWriter();
    const buf = new Uint8Array([5, 6]).buffer;
    w.write('x.bin', buf);
    const got = w.get('x.bin');
    expect(got).toBeInstanceOf(Uint8Array);
    expect([...got]).toEqual([5, 6]);
  });

  it('stores strings via writeString', () => {
    const w = new MemoryDataWriter();
    w.writeString('doc.md', '# hello');
    expect(w.get('doc.md')).toBe('# hello');
  });

  it('clear empties store', () => {
    const w = new MemoryDataWriter();
    w.write('a', new Uint8Array([1]));
    w.writeString('b', 'hi');
    w.clear();
    expect(w.getStore().size).toBe(0);
  });

  it('overwrites existing path', () => {
    const w = new MemoryDataWriter();
    w.writeString('p', 'v1');
    w.writeString('p', 'v2');
    expect(w.get('p')).toBe('v2');
  });
});

describe('FileBasedDataWriter (browser stub)', () => {
  it('prefixes parentDir', () => {
    const w = new FileBasedDataWriter('/tmp/out');
    w.writeString('file.md', 'content');
    expect(w.get('/tmp/out/file.md')).toBe('content');
    expect(w.getStore().has('/tmp/out/file.md')).toBe(true);
  });

  it('also writes to shared browserFileStore readable by FileBasedDataReader', () => {
    const writer = new FileBasedDataWriter('out');
    const reader = new FileBasedDataReader('out');
    writer.writeString('a.md', 'abc');
    expect(reader.readAt('a.md')).toBe('abc');
  });

  it('preserves Uint8Array via parentDir', () => {
    const w = new FileBasedDataWriter('dir');
    const data = new Uint8Array([9, 9]);
    w.write('bin.dat', data);
    expect(new FileBasedDataReader('dir').readAt('bin.dat')).toEqual(data);
  });
});

describe('FileBasedDataReader', () => {
  it('reads via parentDir prefix', () => {
    const writer = new FileBasedDataWriter('mydir');
    writer.writeString('hello.txt', 'world');
    const reader = new FileBasedDataReader('mydir');
    expect(reader.readAt('hello.txt')).toBe('world');
    expect(reader.read('hello.txt')).toBe('world'); // alias
  });

  it('returns empty Uint8Array when missing', () => {
    const r = new FileBasedDataReader('nope');
    const got = r.readAt('missing.bin');
    expect(got).toBeInstanceOf(Uint8Array);
    expect(got.length).toBe(0);
  });

  it('warns but does not throw on missing', () => {
    const r = new FileBasedDataReader();
    expect(() => r.readAt('not/exist')).not.toThrow();
  });
});

describe('Abstract base contracts', () => {
  it('DataWriter throws on abstract write', () => {
    const dw = new DataWriter();
    expect(() => dw.write('x', new Uint8Array([]))).toThrow(/not implemented/);
    expect(() => dw.writeString('x', 's')).toThrow(/not implemented/);
  });

  it('DataReader throws on abstract readAt', () => {
    const dr = new DataReader();
    expect(() => dr.readAt('x')).toThrow(/not implemented/);
  });
});
