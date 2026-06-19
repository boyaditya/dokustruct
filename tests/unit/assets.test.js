import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  HF_ASSET_BASE,
  findAssetByUrl,
  getAssetDetailRows,
  getAssetSourceUrls,
  getRequiredAssets,
} from '../../rapid_doc/utils/model_url_map.js';
import {
  __resetAssetMemoryCacheForTests,
  downloadAsset,
  downloadAssetGroup,
  getAssetStatus,
} from '../../rapid_doc/utils/download_file.js';

afterEach(() => {
  vi.unstubAllGlobals();
  __resetAssetMemoryCacheForTests();
});

describe('asset manifest resolution', () => {
  it('resolves the core pack without formula assets', () => {
    const ids = getRequiredAssets({
      language: 'ch',
      formula_enable: false,
      layout_config: { model_type: 'pp_doclayoutv2', use_doc_orientation_classify: true },
      table_config: { model_type: 'unet_slanet_plus' },
    });

    expect(ids).toContain('runtime_opencv');
    expect(ids).toContain('runtime_ort_jsep_wasm');
    expect(ids).toContain('layout_pp_doclayoutv2');
    expect(ids).toContain('ocr_det');
    expect(ids).toContain('ocr_rec_ch');
    expect(ids).toContain('ocr_seal_det');
    expect(ids).toContain('table_unet');
    expect(ids).toContain('table_slanet_plus');
    expect(ids).toContain('table_dict_ch');
    expect(ids).toContain('table_paddle_cls');
    expect(ids).toContain('table_q_cls');
    expect(ids.some(id => id.startsWith('formula_'))).toBe(false);
  });

  it('adds only the selected formula pack when formula is enabled', () => {
    const ppFormula = getRequiredAssets({
      formula_enable: true,
      formula_config: { modelType: 'pp_formulanet_plus_m' },
      layout_config: { model_type: 'pp_doclayoutv3' },
      table_config: { model_type: 'ppstructure_zh' },
    });
    expect(ppFormula).toContain('formula_pp_formulanet_plus_m');
    expect(ppFormula).toContain('formula_vocab');
    expect(ppFormula).not.toContain('formula_pp_formulanet_plus_l');

  });

  it('matches local model URLs even when cache-busting query strings are present', () => {
    const asset = findAssetByUrl('/models/layout/PP-DocLayoutV2/pp_doclayoutv2.onnx?t=patched');
    expect(asset?.id).toBe('layout_pp_doclayoutv2');
  });

  it('keeps local URLs before external fallback URLs', () => {
    const sources = getAssetSourceUrls('layout_pp_doclayoutv2');
    expect(sources[0]).toBe('/models/layout/PP-DocLayoutV2/pp_doclayoutv2.onnx');
    expect(sources.at(-1)).toBe(`${HF_ASSET_BASE}/layout/PP-DocLayoutV2/pp_doclayoutv2.onnx`);
  });

  it('keeps Hugging Face as fallback for model and data assets', () => {
    expect(getAssetSourceUrls('ocr_dict_ch').at(-1)).toBe(`${HF_ASSET_BASE}/ocr/ppocrv5_dict.txt`);
    expect(getAssetSourceUrls('table_paddle_cls').at(-1)).toBe(`${HF_ASSET_BASE}/table/table_cls/paddle_cls.onnx`);
  });

  it('keeps runtime assets local-first with runtime source fallback', () => {
    const ortSources = getAssetSourceUrls('runtime_ort_jsep_wasm');
    const opencvSources = getAssetSourceUrls('runtime_opencv');
    expect(ortSources[0]).toBe('/ort/ort-wasm-simd-threaded.jsep.wasm');
    expect(ortSources.at(-1)).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@/);
    expect(opencvSources[0]).toBe('/opencv/opencv.js');
    expect(opencvSources.at(-1)).toBe('https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js');
  });

  it('formats asset details as ONNX-only user-facing rows', () => {
    const rows = getAssetDetailRows([
      'runtime_ort_jsep_wasm',
      'ocr_dict_ch',
      'layout_pp_doclayoutv2',
      'ocr_rec_ch',
      'table_q_cls',
      'formula_vocab',
      'formula_pp_formulanet_plus_m',
    ], {
      table_q_cls: { cached: true },
    });

    expect(rows.map(row => row.id)).toEqual([
      'layout_pp_doclayoutv2',
      'ocr_rec_ch',
      'table_q_cls',
      'formula_pp_formulanet_plus_m',
    ]);
    expect(rows.map(row => row.prefix)).toEqual([
      'Layout model',
      'OCR model - recognizer',
      'Table model - classifier',
      'Formula model',
    ]);
    expect(rows.find(row => row.id === 'table_q_cls')?.status).toBe('Cached');
  });

  it('does not expose Formula Plus L in setup or required assets', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).not.toContain('pp_formulanet_plus_l');
    expect(html).not.toContain('assetAcknowledge');

    const ids = getRequiredAssets({
      formula_enable: true,
      formula_config: { modelType: 'pp_formulanet_plus_l' },
    });
    expect(ids).not.toContain('formula_pp_formulanet_plus_l');
  });
});

describe('asset cache downloads', () => {
  it('tries the local source first, falls back externally, and caches the result', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn(async (url) => {
      if (!String(url).startsWith('https://')) {
        return new Response('missing', { status: 404 });
      }
      return new Response(bytes, {
        status: 200,
        headers: { 'Content-Length': String(bytes.byteLength) },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const progress = [];
    const buffer = await downloadAsset('layout_pp_doclayoutv2', event => progress.push(event));
    expect([...new Uint8Array(buffer)]).toEqual([...bytes]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/models/layout/PP-DocLayoutV2/pp_doclayoutv2.onnx');
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/^https:\/\//);
    expect(progress.at(-1)?.percent).toBe(100);

    const status = await getAssetStatus('layout_pp_doclayoutv2');
    expect(status.cached).toBe(true);

    const cached = await downloadAsset('layout_pp_doclayoutv2');
    expect([...new Uint8Array(cached)]).toEqual([...bytes]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects unknown assets', async () => {
    await expect(downloadAsset('missing_asset')).rejects.toThrow(/Unknown asset id/);
  });

  it('emits indeterminate progress when Content-Length is missing', async () => {
    const bytes = new Uint8Array([5, 6, 7]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { status: 200 },
    )));

    const progress = [];
    const buffer = await downloadAsset('runtime_ort_jsep_mjs', event => progress.push(event));
    expect([...new Uint8Array(buffer)]).toEqual([...bytes]);
    expect(progress.some(event => event.indeterminate && event.loadedBytes === bytes.byteLength)).toBe(true);
    expect(progress.at(-1)?.phase).toBe('cached');
    expect(progress.at(-1)?.percent).toBe(100);
  });

  it('aborts before starting a fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(downloadAsset('layout_pp_doclayoutv2', null, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the final source error when every source fails', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).startsWith('https://')) throw new Error('external down');
      return new Response('missing', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadAsset('layout_pp_doclayoutv2')).rejects.toThrow(/external down/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await getAssetStatus('layout_pp_doclayoutv2')).toMatchObject({ cached: false });
  });

  it('reports grouped download totals and active asset labels', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([9]), {
      status: 200,
      headers: { 'Content-Length': '1' },
    })));

    const progress = [];
    await downloadAssetGroup(['runtime_ort_jsep_mjs', 'table_dict_ch'], event => progress.push(event));

    expect(progress.some(event => event.group?.total === 2 && event.assetId === 'runtime_ort_jsep_mjs')).toBe(true);
    expect(progress.some(event => event.group?.completed === 2 && event.phase === 'cached')).toBe(true);
    expect(progress.at(-1)?.percent).toBe(100);
  });
});
