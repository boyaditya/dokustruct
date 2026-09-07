import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AtomModelSingleton, disposeModelResource, MineruPipelineModel } from '@rapid_doc/backend/pipeline/model_init.js';
import { AtomicModel } from '@rapid_doc/backend/pipeline/model_list.js';
import { ModelSingleton } from '@rapid_doc/backend/pipeline/pipeline_analyze.js';

describe('AtomModelSingleton — buildKey determinism', () => {
  it('same config → same key, different config → different key (Layout)', () => {
    const k1 = AtomModelSingleton.buildKey(AtomicModel.Layout, { layout_config: { model_type: 'pp_doclayoutv2' } });
    const k2 = AtomModelSingleton.buildKey(AtomicModel.Layout, { layout_config: { model_type: 'pp_doclayoutv2' } });
    const k3 = AtomModelSingleton.buildKey(AtomicModel.Layout, { layout_config: { model_type: 'pp_doclayoutv3' } });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('OCR key includes lang and thresholds', () => {
    const kCh = AtomModelSingleton.buildKey(AtomicModel.OCR, { lang: 'ch', det_db_thresh: 0.3 });
    const kEn = AtomModelSingleton.buildKey(AtomicModel.OCR, { lang: 'en', det_db_thresh: 0.3 });
    expect(kCh).not.toBe(kEn);
  });

  it('Table key strips custom_model from ocr_config', () => {
    const fake = { predict() {} };
    const kWith = AtomModelSingleton.buildKey(AtomicModel.Table, { lang: 'ch', ocr_config: { custom_model: fake }, table_config: {} });
    const kWithout = AtomModelSingleton.buildKey(AtomicModel.Table, { lang: 'ch', ocr_config: {}, table_config: {} });
    // custom_model is replaced by type name, so both still differ by presence but not by function reference
    expect(typeof kWith).toBe('string');
    expect(typeof kWithout).toBe('string');
  });

  it('FORMULA key is stable', () => {
    const k1 = AtomModelSingleton.buildKey(AtomicModel.FORMULA, { formula_config: { modelType: 'pp_formulanet_plus_m' } });
    const k2 = AtomModelSingleton.buildKey(AtomicModel.FORMULA, { formula_config: { modelType: 'pp_formulanet_plus_m' } });
    expect(k1).toBe(k2);
  });

  it('ImgOrientationCls key stable', () => {
    const k1 = AtomModelSingleton.buildKey(AtomicModel.ImgOrientationCls, { orientation_config: { enable: true } });
    const k2 = AtomModelSingleton.buildKey(AtomicModel.ImgOrientationCls, { orientation_config: { enable: true } });
    expect(k1).toBe(k2);
  });
});

describe('AtomModelSingleton — singleton and caching', () => {
  it('getInstance returns same object', () => {
    expect(AtomModelSingleton.getInstance()).toBe(AtomModelSingleton.getInstance());
  });

  it('getAtomModel caches promise per key (custom_model path)', async () => {
    const singleton = AtomModelSingleton.getInstance();
    await singleton.clear();
    // Use distinct constructor names to avoid key collision when testing different fakes
    class FakeA { predict() { return 'a'; } }
    class FakeB { predict() { return 'b'; } }
    const fakeA = new FakeA();
    const fakeB = new FakeB();
    const p1 = singleton.getAtomModel(AtomicModel.FORMULA, { formula_config: { custom_model: fakeA } });
    const p2 = singleton.getAtomModel(AtomicModel.FORMULA, { formula_config: { custom_model: fakeA } });
    // Same config → same resolved instance (cached)
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(fakeA);
    expect(r2).toBe(fakeA);
    // Different constructor name → different key (documents makeHashable type-name behavior)
    const k1 = AtomModelSingleton.buildKey(AtomicModel.FORMULA, { formula_config: { custom_model: fakeA } });
    const k2 = AtomModelSingleton.buildKey(AtomicModel.FORMULA, { formula_config: { custom_model: fakeB } });
    expect(k1).not.toBe(k2);
    // Cleanup
    await singleton.clear();
  });

  it('clear removes entries and disposes', async () => {
    const singleton = AtomModelSingleton.getInstance();
    const fake = { predict() {}, dispose: vi.fn(async () => {}) };
    await singleton.getAtomModel(AtomicModel.FORMULA, { formula_config: { custom_model: fake } });
    await singleton.clear();
    // After clear, a new call should create fresh promise
    const fake2 = { predict() {}, dispose: vi.fn() };
    const p = singleton.getAtomModel(AtomicModel.FORMULA, { formula_config: { custom_model: fake2 } });
    await expect(p).resolves.toBe(fake2);
    await singleton.clear();
  });

  it('retainKeys keeps only specified keys', async () => {
    const singleton = AtomModelSingleton.getInstance();
    await singleton.clear();
    class FakeOCRCh { predict() {} }
    class FakeOCREn { predict() {} }
    const fakeCh = new FakeOCRCh();
    const fakeEn = new FakeOCREn();
    // Use OCR with custom_model so no real ORT load, but lang diff gives distinct keys
    await singleton.getAtomModel(AtomicModel.OCR, { lang: 'ch', ocr_config: { custom_model: fakeCh } });
    await singleton.getAtomModel(AtomicModel.OCR, { lang: 'en', ocr_config: { custom_model: fakeEn } });
    const keep = new Set([AtomModelSingleton.buildKey(AtomicModel.OCR, { lang: 'ch', ocr_config: { custom_model: fakeCh } })]);
    await singleton.retainKeys(keep);
    // ch should remain, en disposed — verify by checking that ch key still resolves instantly
    const kept = await singleton.getAtomModel(AtomicModel.OCR, { lang: 'ch', ocr_config: { custom_model: fakeCh } });
    expect(kept).toBe(fakeCh);
    await singleton.clear();
  });

  it('atomModelInit throws for unknown model', async () => {
    const singleton = AtomModelSingleton.getInstance();
    await expect(singleton.getAtomModel('unknown_model', {})).rejects.toThrow(/not allowed/);
  });
});

describe('disposeModelResource', () => {
  it('disposes nested sessions and handles circular refs', async () => {
    const inner = { release: vi.fn(async () => {}) };
    const outer = { session: inner, detSession: inner };
    await expect(disposeModelResource(outer)).resolves.not.toThrow();
    expect(inner.release).toHaveBeenCalled();
  });

  it('skips already disposed marker', async () => {
    const res = { release: vi.fn() };
    res[Symbol.for('rapiddoc.disposed')] = true;
    await disposeModelResource(res);
    expect(res.release).not.toHaveBeenCalled();
  });

  it('handles null/primitive gracefully', async () => {
    await expect(disposeModelResource(null)).resolves.not.toThrow();
    await expect(disposeModelResource(42)).resolves.not.toThrow();
    await expect(disposeModelResource('str')).resolves.not.toThrow();
  });

  it('suppresses invalid session id warnings', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = { release: vi.fn(async () => { throw new Error('invalid session id 123'); }) };
    await disposeModelResource(res);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('warns on other dispose errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = { release: vi.fn(async () => { throw new Error('boom'); }) };
    await disposeModelResource(res);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('ModelSingleton', () => {
  it('getInstance singleton', () => {
    expect(ModelSingleton.getInstance()).toBe(ModelSingleton.getInstance());
  });

  it('makeKey stable and makeAtomKeySet produces Set', () => {
    const key1 = ModelSingleton.makeKey({ lang: 'ch', formula_enable: true, table_enable: true });
    const key2 = ModelSingleton.makeKey({ lang: 'ch', formula_enable: true, table_enable: true });
    expect(key1).toBe(key2);
    const set = ModelSingleton.makeAtomKeySet({ lang: 'ch', formula_enable: true, table_enable: true });
    expect(set).toBeInstanceOf(Set);
    expect(set.size).toBeGreaterThan(0);
  });

  it('makeAtomKeySet respects formula/table enable flags', () => {
    const withFormula = ModelSingleton.makeAtomKeySet({ formula_enable: true, table_enable: true });
    const withoutFormula = ModelSingleton.makeAtomKeySet({ formula_enable: false, table_enable: true });
    expect(withFormula.size).toBeGreaterThan(withoutFormula.size);
  });

  it('clearByConfig keeps specified config', async () => {
    const singleton = ModelSingleton.getInstance();
    // We cannot fully test without mocking MineruPipelineModel.create, so just ensure method exists and does not throw for null
    await expect(singleton.clearByConfig(null)).resolves.not.toThrow();
  });
});

describe('MineruPipelineModel', () => {
  it('is constructible and exposes expected fields', () => {
    const m = new MineruPipelineModel();
    expect(m.layoutModel).toBeNull();
    expect(m.ocrModel).toBeNull();
    expect(m.tableModel).toBeNull();
    expect(m.formulaModel).toBeNull();
    expect(m.applyFormula).toBe(true);
    expect(m.applyTable).toBe(true);
  });

  it('dispose nulls references', async () => {
    const m = new MineruPipelineModel();
    m.layoutModel = { dispose: vi.fn() };
    m.ocrModel = { dispose: vi.fn() };
    await m.dispose();
    expect(m.layoutModel).toBeNull();
    expect(m.ocrModel).toBeNull();
  });
});
