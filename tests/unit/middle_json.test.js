import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resultToMiddleJson, makePageInfoDict, pageModelInfoToPageInfo } from '@rapid_doc/backend/pipeline/model_json_to_middle_json.js';
import { MemoryDataWriter } from '@rapid_doc/data/data_reader_writer/index.js';
import { AtomModelSingleton } from '@rapid_doc/backend/pipeline/model_init.js';
import { AtomicModel } from '@rapid_doc/backend/pipeline/model_list.js';

describe('middle_json — makePageInfoDict', () => {
  it('creates correct structure', () => {
    const dict = makePageInfoDict([{ type: 'text' }], 2, 100, 200, []);
    expect(dict.page_idx).toBe(2);
    expect(dict.page_size).toEqual([100, 200]);
    expect(dict.preproc_blocks).toEqual([{ type: 'text' }]);
    expect(dict.discarded_blocks).toEqual([]);
  });
  it('handles empty blocks', () => {
    const dict = makePageInfoDict([], 0, 0, 0, []);
    expect(dict.preproc_blocks).toEqual([]);
  });
});

describe('middle_json — pageModelInfoToPageInfo null guards', () => {
  it('returns null for null inputs', async () => {
    const writer = new MemoryDataWriter();
    expect(await pageModelInfoToPageInfo(null, { scale: 1, img_pil: new Uint8Array([]) }, {}, writer, 0)).toBeNull();
    expect(await pageModelInfoToPageInfo({ layout_dets: [] }, null, {}, writer, 0)).toBeNull();
  });

  it('returns pageInfo with empty blocks when magicModel has no content (scale 1)', async () => {
    const writer = new MemoryDataWriter();
    // Minimal valid pageModelInfo with empty layout_dets, scale 1
    // MagicModel will produce empty groups → pageModelInfoToPageInfo may return null or object with empty blocks
    const result = await pageModelInfoToPageInfo(
      { layout_dets: [] },
      { scale: 1, img_pil: { width: 100, height: 100 } },
      { size: [100, 100], ori_image_list: [] },
      writer,
      0
    );
    // Should be null (no blocks) or object with empty preproc_blocks
    expect(result === null || Array.isArray(result.preproc_blocks)).toBe(true);
  });
});

describe('middle_json — resultToMiddleJson', () => {
  beforeEach(async () => {
    // Ensure clean singleton before each
    await AtomModelSingleton.getInstance().clear();
  });

  it('returns empty pdf_info for empty modelList', async () => {
    const writer = new MemoryDataWriter();
    const res = await resultToMiddleJson([], [], [], writer, {});
    expect(res.pdf_info).toEqual([]);
    expect(res._backend).toBe('pipeline');
  });

  it('returns empty pdf_info for null modelList', async () => {
    const writer = new MemoryDataWriter();
    const res = await resultToMiddleJson(null, [], [], writer, {});
    expect(res.pdf_info).toEqual([]);
  });

  it('handles per-page errors gracefully (returns placeholder page)', async () => {
    // Mock AtomModelSingleton.getAtomModel to return a fake OCR that will be used in postProcessOcr?
    // For this test we want resultToMiddleJson to not throw even if pageModelInfo causes error.
    // We provide a modelList with one entry that will cause pageModelInfoToPageInfo to create a page but postProcess may be skipped
    // To avoid real OCR, mock AtomModelSingleton
    const fakeOcr = {
      batchPredict: undefined,
      ocr: vi.fn(async () => [[], []]), // not called because no spans with np_img
    };
    // Inject fake OCR into singleton cache directly via custom_model path? Simpler: mock getAtomModel
    const singleton = AtomModelSingleton.getInstance();
    const origGet = singleton.getAtomModel.bind(singleton);
    singleton.getAtomModel = vi.fn(async (name) => {
      if (name === AtomicModel.OCR) return fakeOcr;
      // For other models, return minimal stub
      return { batchPredict: () => [] };
    });

    const writer = new MemoryDataWriter();
    const modelList = [{ layout_dets: [] }];
    const imagesList = [{ scale: 1, img_pil: { width: 100, height: 100 } }];
    const pageDictList = [{ size: [100, 100], ori_image_list: [], table_fill_image_list: [] }];

    const res = await resultToMiddleJson(modelList, imagesList, pageDictList, writer, { lang: 'ch' });
    expect(res.pdf_info.length).toBe(1);
    expect(res.pdf_info[0].page_idx).toBe(0);

    singleton.getAtomModel = origGet;
    await AtomModelSingleton.getInstance().clear();
  });

  it('respects batch_idx * pdf_pages_batch pageId offset', async () => {
    const fakeOcr = { ocr: vi.fn(async () => [[], []]) };
    const singleton = AtomModelSingleton.getInstance();
    const origGet = singleton.getAtomModel.bind(singleton);
    singleton.getAtomModel = vi.fn(async () => fakeOcr);

    const writer = new MemoryDataWriter();
    const modelList = [{ layout_dets: [] }, { layout_dets: [] }];
    const imagesList = [
      { scale: 1, img_pil: { width: 100, height: 100 } },
      { scale: 1, img_pil: { width: 100, height: 100 } },
    ];
    const pageDictList = [
      { size: [100, 100], ori_image_list: [] },
      { size: [100, 100], ori_image_list: [] },
    ];
    const res = await resultToMiddleJson(modelList, imagesList, pageDictList, writer, {
      lang: 'ch',
      batch_idx: 2,
      pdf_pages_batch: 10,
    });
    expect(res.pdf_info[0].page_idx).toBe(20);
    expect(res.pdf_info[1].page_idx).toBe(21);

    singleton.getAtomModel = origGet;
    await AtomModelSingleton.getInstance().clear();
  });

  it('skipCrossPageMerge still runs paraSplit (streaming)', async () => {
    const fakeOcr = { ocr: vi.fn(async () => [[], []]) };
    const singleton = AtomModelSingleton.getInstance();
    const origGet = singleton.getAtomModel.bind(singleton);
    singleton.getAtomModel = vi.fn(async () => fakeOcr);

    const writer = new MemoryDataWriter();
    const modelList = [{ layout_dets: [] }];
    const imagesList = [{ scale: 1, img_pil: { width: 100, height: 100 } }];
    const pageDictList = [{ size: [100, 100], ori_image_list: [] }];
    const res = await resultToMiddleJson(modelList, imagesList, pageDictList, writer, {
      lang: 'ch',
      skipCrossPageMerge: true,
    });
    // paraSplit should have created para_blocks
    expect(res.pdf_info[0].para_blocks).toBeDefined();

    singleton.getAtomModel = origGet;
    await AtomModelSingleton.getInstance().clear();
  });
});
