import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setConfig,
  readConfig,
  getDevice,
  getFormulaEnable,
  getTableEnable,
  getLatexDelimiterConfig,
} from '@rapid_doc/utils/config_reader.js';

describe('config_reader — set/read', () => {
  afterEach(() => {
    setConfig(null);
    delete globalThis.__RAPIDDOC_CONFIG__;
  });

  it('readConfig returns null when nothing set', () => {
    setConfig(null);
    delete globalThis.__RAPIDDOC_CONFIG__;
    expect(readConfig()).toBeNull();
  });

  it('setConfig/readConfig round-trips object', () => {
    const cfg = { 'latex-delimiter-config': { display: { left: '$$' } } };
    setConfig(cfg);
    expect(readConfig()).toBe(cfg);
  });

  it('reads from global __RAPIDDOC_CONFIG__ when _config is null', () => {
    setConfig(null);
    globalThis.__RAPIDDOC_CONFIG__ = { foo: 1 };
    expect(readConfig()).toEqual({ foo: 1 });
    // after first read, _config is memoized
    globalThis.__RAPIDDOC_CONFIG__ = { foo: 2 };
    // still returns first cached
    expect(readConfig()).toEqual({ foo: 1 });
  });
});

describe('config_reader — getDevice', () => {
  afterEach(() => {
    delete globalThis.__RAPIDDOC_DEVICE__;
    delete globalThis.navigator;
  });

  it('returns __RAPIDDOC_DEVICE__ when set', () => {
    globalThis.__RAPIDDOC_DEVICE__ = 'webgpu';
    expect(getDevice()).toBe('webgpu');
  });

  it('prefers webgpu when navigator.gpu exists', () => {
    delete globalThis.__RAPIDDOC_DEVICE__;
    globalThis.navigator = { gpu: {} };
    expect(getDevice()).toBe('webgpu');
  });

  it('falls back to wasm when no gpu', () => {
    delete globalThis.__RAPIDDOC_DEVICE__;
    globalThis.navigator = {};
    expect(getDevice()).toBe('wasm');
  });

  it('falls back to wasm when navigator undefined', () => {
    delete globalThis.__RAPIDDOC_DEVICE__;
    delete globalThis.navigator;
    expect(getDevice()).toBe('wasm');
  });
});

describe('config_reader — feature flags', () => {
  afterEach(() => {
    delete globalThis.__RAPIDDOC_FORMULA_ENABLE__;
    delete globalThis.__RAPIDDOC_TABLE_ENABLE__;
  });

  it('getFormulaEnable respects global override', () => {
    globalThis.__RAPIDDOC_FORMULA_ENABLE__ = false;
    expect(getFormulaEnable(true)).toBe(false);
    expect(getFormulaEnable(false)).toBe(false);
    globalThis.__RAPIDDOC_FORMULA_ENABLE__ = true;
    expect(getFormulaEnable(false)).toBe(true);
  });

  it('getFormulaEnable passes through when no global', () => {
    delete globalThis.__RAPIDDOC_FORMULA_ENABLE__;
    expect(getFormulaEnable(true)).toBe(true);
    expect(getFormulaEnable(false)).toBe(false);
  });

  it('getTableEnable respects global override', () => {
    globalThis.__RAPIDDOC_TABLE_ENABLE__ = 0;
    expect(getTableEnable(true)).toBe(false);
    delete globalThis.__RAPIDDOC_TABLE_ENABLE__;
    expect(getTableEnable(true)).toBe(true);
  });
});

describe('config_reader — getLatexDelimiterConfig', () => {
  afterEach(() => {
    setConfig(null);
    delete globalThis.__RAPIDDOC_CONFIG__;
  });

  it('returns null when no config', () => {
    setConfig(null);
    delete globalThis.__RAPIDDOC_CONFIG__;
    expect(getLatexDelimiterConfig()).toBeNull();
  });

  it('returns latex-delimiter-config when present', () => {
    const delimiters = { display: { left: '$$', right: '$$' }, inline: { left: '$', right: '$' } };
    setConfig({ 'latex-delimiter-config': delimiters });
    expect(getLatexDelimiterConfig()).toEqual(delimiters);
  });

  it('returns null when config lacks key', () => {
    setConfig({ other: 1 });
    expect(getLatexDelimiterConfig()).toBeNull();
  });
});
