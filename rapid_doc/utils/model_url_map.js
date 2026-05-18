/**
 * Browser asset manifest for external-first downloads.
 *
 * External URLs are tried first. The local `/models`, `/opencv`, and `/ort`
 * paths remain fallback sources for development and offline deployments.
 */

export const HF_ASSET_BASE = 'https://huggingface.co/boyaditya/document-parsing-project/resolve/main';
const ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist';
const OPENCV_CDN = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist';

function hfAsset(path) {
  return `${HF_ASSET_BASE}/${String(path).replace(/^\/?(models\/)?/, '')}`;
}

function asset({
  id,
  label,
  pack = 'core',
  url = null,
  localUrl = null,
  cacheKey = null,
  sizeBytes = 0,
  mimeType = 'application/octet-stream',
  sha256 = null,
  optional = false,
}) {
  return Object.freeze({
    id,
    label,
    pack,
    url,
    localUrl,
    cacheKey: cacheKey ?? (localUrl ? localUrl.replace(/^\//, '').split('?')[0] : id),
    sizeBytes,
    mimeType,
    sha256,
    optional,
  });
}

export const ASSET_MANIFEST = Object.freeze({
  runtime_opencv: asset({
    id: 'runtime_opencv',
    label: 'OpenCV.js runtime',
    url: `${OPENCV_CDN}/opencv.js`,
    localUrl: '/opencv/opencv.js',
    sizeBytes: 10_378_215,
    mimeType: 'text/javascript',
  }),
  runtime_ort_jsep_mjs: asset({
    id: 'runtime_ort_jsep_mjs',
    label: 'ONNXRuntime Web loader',
    url: `${ORT_CDN}/ort-wasm-simd-threaded.jsep.mjs`,
    localUrl: '/ort/ort-wasm-simd-threaded.jsep.mjs',
    sizeBytes: 46_701,
    mimeType: 'text/javascript',
  }),
  runtime_ort_jsep_wasm: asset({
    id: 'runtime_ort_jsep_wasm',
    label: 'ONNXRuntime Web WASM',
    url: `${ORT_CDN}/ort-wasm-simd-threaded.jsep.wasm`,
    localUrl: '/ort/ort-wasm-simd-threaded.jsep.wasm',
    sizeBytes: 25_014_754,
    mimeType: 'application/wasm',
  }),

  layout_pp_doclayoutv2: asset({
    id: 'layout_pp_doclayoutv2',
    label: 'PP-DocLayoutV2',
    url: hfAsset('layout/PP-DocLayoutV2/pp_doclayoutv2.onnx'),
    localUrl: '/models/layout/PP-DocLayoutV2/pp_doclayoutv2.onnx',
    sizeBytes: 213_969_642,
  }),
  layout_pp_doclayoutv3: asset({
    id: 'layout_pp_doclayoutv3',
    label: 'PP-DocLayoutV3',
    url: hfAsset('layout/PP-DocLayoutV3/pp_doclayoutv3.onnx'),
    localUrl: '/models/layout/PP-DocLayoutV3/pp_doclayoutv3.onnx',
    sizeBytes: 129_857_962,
  }),
  layout_pp_doclayout_plus_l: asset({
    id: 'layout_pp_doclayout_plus_l',
    label: 'PP-DocLayout Plus L',
    url: hfAsset('layout/PP-DocLayout_plus-L/pp_doclayout_plus_l.onnx'),
    localUrl: '/models/layout/PP-DocLayout_plus-L/pp_doclayout_plus_l.onnx',
    sizeBytes: 129_559_772,
  }),
  layout_pp_doclayout: asset({
    id: 'layout_pp_doclayout',
    label: 'PP-DocLayout L',
    localUrl: '/models/layout/PP-DocLayout-L/pp_doclayout_l.onnx',
    sizeBytes: 129_377_291,
  }),

  ocr_det: asset({
    id: 'ocr_det',
    label: 'OCR detector',
    url: hfAsset('ocr/ch_PP-OCRv5_mobile_det.onnx'),
    localUrl: '/models/ocr/ch_PP-OCRv5_mobile_det.onnx',
    sizeBytes: 4_819_576,
  }),
  ocr_rec_ch: asset({
    id: 'ocr_rec_ch',
    label: 'OCR recognizer Chinese + English',
    url: hfAsset('ocr/ch_PP-OCRv5_rec_mobile_infer.onnx'),
    localUrl: '/models/ocr/ch_PP-OCRv5_rec_mobile_infer.onnx',
    sizeBytes: 16_631_306,
  }),
  ocr_rec_en: asset({
    id: 'ocr_rec_en',
    label: 'OCR recognizer English',
    url: hfAsset('ocr/en_PP-OCRv5_rec_mobile_infer.onnx'),
    localUrl: '/models/ocr/en_PP-OCRv5_rec_mobile_infer.onnx',
    sizeBytes: 7_872_351,
  }),
  ocr_dict_ch: asset({
    id: 'ocr_dict_ch',
    label: 'OCR dictionary Chinese + English',
    url: hfAsset('ocr/ppocrv5_dict.txt'),
    localUrl: '/models/ocr/ppocrv5_dict.txt',
    sizeBytes: 74_012,
    mimeType: 'text/plain',
  }),
  ocr_dict_en: asset({
    id: 'ocr_dict_en',
    label: 'OCR dictionary English',
    url: hfAsset('ocr/ppocrv5_en_dict.txt'),
    localUrl: '/models/ocr/ppocrv5_en_dict.txt',
    sizeBytes: 1_416,
    mimeType: 'text/plain',
  }),
  ocr_seal_det: asset({
    id: 'ocr_seal_det',
    label: 'OCR seal detector',
    url: hfAsset('ocr/pp-ocrv4_mobile_seal_det.onnx'),
    localUrl: '/models/ocr/pp-ocrv4_mobile_seal_det.onnx',
    sizeBytes: 4_826_518,
  }),

  orientation_rapid: asset({
    id: 'orientation_rapid',
    label: 'Document orientation classifier',
    url: hfAsset('orientation/rapid_orientation.onnx'),
    localUrl: '/models/orientation/rapid_orientation.onnx',
    sizeBytes: 6_783_084,
  }),

  table_unet: asset({
    id: 'table_unet',
    label: 'Table UNET structure model',
    url: hfAsset('table/unet.onnx'),
    localUrl: '/models/table/unet.onnx',
    sizeBytes: 8_335_007,
  }),
  table_slanet_plus: asset({
    id: 'table_slanet_plus',
    label: 'Table SLANet Plus model',
    url: hfAsset('table/slanet-plus.onnx'),
    localUrl: '/models/table/slanet-plus.onnx',
    sizeBytes: 7_745_780,
  }),
  table_ppstructure_zh: asset({
    id: 'table_ppstructure_zh',
    label: 'PP-Structure table Chinese',
    url: hfAsset('table/ch_ppstructure_mobile_v2_SLANet.onnx'),
    localUrl: '/models/table/ch_ppstructure_mobile_v2_SLANet.onnx',
    sizeBytes: 7_790_807,
  }),
  table_ppstructure_en: asset({
    id: 'table_ppstructure_en',
    label: 'PP-Structure table English',
    url: hfAsset('table/en_ppstructure_mobile_v2_SLANet.onnx'),
    localUrl: '/models/table/en_ppstructure_mobile_v2_SLANet.onnx',
    sizeBytes: 7_704_409,
  }),
  table_dict_ch: asset({
    id: 'table_dict_ch',
    label: 'Table structure dictionary',
    url: hfAsset('table/table_structure_dict_ch.txt'),
    localUrl: '/models/table/table_structure_dict_ch.txt',
    sizeBytes: 578,
    mimeType: 'text/plain',
  }),
  table_paddle_cls: asset({
    id: 'table_paddle_cls',
    label: 'Table Paddle classifier',
    url: hfAsset('table/table_cls/paddle_cls.onnx'),
    localUrl: '/models/table/table_cls/paddle_cls.onnx',
    sizeBytes: 6_771_838,
  }),
  table_q_cls: asset({
    id: 'table_q_cls',
    label: 'Table QAnything classifier',
    url: hfAsset('table/table_cls/q_cls.onnx'),
    localUrl: '/models/table/table_cls/q_cls.onnx',
    sizeBytes: 16_793_553,
  }),

  formula_pp_formulanet_plus_s: asset({
    id: 'formula_pp_formulanet_plus_s',
    label: 'PP-FormulaNet Plus S',
    pack: 'formula',
    url: hfAsset('formula/PP-FormulaNet_plus-S/pp_formulanet_plus_s.onnx'),
    localUrl: '/models/formula/PP-FormulaNet_plus-S/pp_formulanet_plus_s.onnx',
    sizeBytes: 233_421_946,
    optional: true,
  }),
  formula_pp_formulanet_plus_m: asset({
    id: 'formula_pp_formulanet_plus_m',
    label: 'PP-FormulaNet Plus M',
    pack: 'formula',
    url: hfAsset('formula/PP-FormulaNet_plus-M/pp_formulanet_plus_m.onnx'),
    localUrl: '/models/formula/PP-FormulaNet_plus-M/pp_formulanet_plus_m.onnx',
    sizeBytes: 593_915_961,
    optional: true,
  }),
  formula_vocab: asset({
    id: 'formula_vocab',
    label: 'Formula vocabulary',
    pack: 'formula',
    url: hfAsset('formula/formula_vocab.json'),
    localUrl: '/models/formula/formula_vocab.json',
    sizeBytes: 912_969,
    mimeType: 'application/json',
    optional: true,
  }),
  formula_latex_ocr_resizer: asset({
    id: 'formula_latex_ocr_resizer',
    label: 'LaTeX-OCR image resizer',
    pack: 'formula',
    url: hfAsset('formula/LaTeX-OCR/image_resizer.onnx'),
    localUrl: '/models/formula/LaTeX-OCR/image_resizer.onnx',
    sizeBytes: 38_967_751,
    optional: true,
  }),
  formula_latex_ocr_encoder: asset({
    id: 'formula_latex_ocr_encoder',
    label: 'LaTeX-OCR encoder',
    pack: 'formula',
    url: hfAsset('formula/LaTeX-OCR/encoder.onnx'),
    localUrl: '/models/formula/LaTeX-OCR/encoder.onnx',
    sizeBytes: 89_008_136,
    optional: true,
  }),
  formula_latex_ocr_decoder: asset({
    id: 'formula_latex_ocr_decoder',
    label: 'LaTeX-OCR decoder',
    pack: 'formula',
    url: hfAsset('formula/LaTeX-OCR/decoder.onnx'),
    localUrl: '/models/formula/LaTeX-OCR/decoder.onnx',
    sizeBytes: 50_952_726,
    optional: true,
  }),
  formula_latex_ocr_tokenizer: asset({
    id: 'formula_latex_ocr_tokenizer',
    label: 'LaTeX-OCR tokenizer',
    pack: 'formula',
    url: hfAsset('formula/LaTeX-OCR/tokenizer.json'),
    localUrl: '/models/formula/LaTeX-OCR/tokenizer.json',
    sizeBytes: 24_174,
    mimeType: 'application/json',
    optional: true,
  }),
});

export const UI_MODEL_URL_MAP = ASSET_MANIFEST;

export const RUNTIME_ASSET_IDS = Object.freeze([
  'runtime_opencv',
  'runtime_ort_jsep_mjs',
  'runtime_ort_jsep_wasm',
]);

const LAYOUT_ASSET_BY_TYPE = Object.freeze({
  pp_doclayoutv2: 'layout_pp_doclayoutv2',
  pp_doclayoutv3: 'layout_pp_doclayoutv3',
  pp_doclayout_plus_l: 'layout_pp_doclayout_plus_l',
  pp_doclayout_l: 'layout_pp_doclayout',
});

const TABLE_ASSETS_BY_TYPE = Object.freeze({
  unet_slanet_plus: ['table_unet', 'table_slanet_plus', 'table_dict_ch', 'table_paddle_cls', 'table_q_cls'],
  unet: ['table_unet'],
  slanet_plus: ['table_slanet_plus', 'table_dict_ch'],
  slanetplus: ['table_slanet_plus', 'table_dict_ch'],
  ppstructure_zh: ['table_ppstructure_zh', 'table_dict_ch'],
  ppstructure_en: ['table_ppstructure_en', 'table_dict_ch'],
});

export function getAsset(assetId) {
  return ASSET_MANIFEST[assetId] ?? null;
}

export function normalizeAssetUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(String(url), globalThis.location?.href ?? 'http://localhost/');
    return parsed.origin === 'http://localhost'
      ? parsed.pathname
      : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url).split('?')[0].split('#')[0];
  }
}

export function findAssetByUrl(url) {
  const normalized = normalizeAssetUrl(url);
  return Object.values(ASSET_MANIFEST).find((entry) => {
    return normalizeAssetUrl(entry.url) === normalized
      || normalizeAssetUrl(entry.localUrl) === normalized
      || entry.cacheKey === String(url).replace(/^\//, '').split('?')[0];
  }) ?? null;
}

export function getAssetSourceUrls(assetId) {
  const entry = getAsset(assetId);
  if (!entry) return [];
  return [entry.url, entry.localUrl].filter(Boolean);
}

export function getRequiredAssets(config = {}) {
  const required = new Set(RUNTIME_ASSET_IDS);

  const layoutType = config.layout_config?.model_type ?? config.layout_config?.modelType ?? 'pp_doclayoutv2';
  required.add(LAYOUT_ASSET_BY_TYPE[layoutType] ?? 'layout_pp_doclayoutv2');

  const language = config.language === 'en' ? 'en' : 'ch';
  required.add('ocr_det');
  required.add(language === 'en' ? 'ocr_rec_en' : 'ocr_rec_ch');
  required.add(language === 'en' ? 'ocr_dict_en' : 'ocr_dict_ch');
  if (config.ocr_config?.seal_enable !== false) {
    required.add('ocr_seal_det');
  }

  if (config.layout_config?.use_doc_orientation_classify !== false) {
    required.add('orientation_rapid');
  }

  const tableType = config.table_config?.model_type
    ?? config.table_config?.modelType
    ?? config.tableModelType
    ?? 'unet_slanet_plus';
  for (const id of TABLE_ASSETS_BY_TYPE[tableType] ?? TABLE_ASSETS_BY_TYPE.unet_slanet_plus) {
    required.add(id);
  }

  if (config.formula_enable) {
    for (const id of getFormulaAssets(config)) required.add(id);
  }

  return [...required].filter(id => Boolean(ASSET_MANIFEST[id]));
}

export const getRequiredModels = getRequiredAssets;

export function getFormulaAssets(config = {}) {
  const formulaType = config.formula_config?.modelType ?? config.formula_config?.model_type ?? 'pp_formulanet_plus_s';
  if (formulaType === 'latex_ocr') {
    return [
      'formula_latex_ocr_resizer',
      'formula_latex_ocr_encoder',
      'formula_latex_ocr_decoder',
      'formula_latex_ocr_tokenizer',
    ];
  }
  const modelId = `formula_${formulaType}`;
  return ASSET_MANIFEST[modelId] ? [modelId, 'formula_vocab'] : [];
}

export function summarizeAssets(assetIds) {
  const ids = [...new Set(assetIds)].filter(id => Boolean(ASSET_MANIFEST[id]));
  const sizeBytes = ids.reduce((sum, id) => sum + (ASSET_MANIFEST[id].sizeBytes || 0), 0);
  return {
    ids,
    assets: ids.map(id => ASSET_MANIFEST[id]),
    sizeBytes,
    coreIds: ids.filter(id => ASSET_MANIFEST[id].pack !== 'formula'),
    formulaIds: ids.filter(id => ASSET_MANIFEST[id].pack === 'formula'),
  };
}

function getAssetDetailPrefix(assetId) {
  if (assetId.startsWith('layout_')) return 'Layout model';
  if (assetId === 'ocr_det') return 'OCR model - detector';
  if (assetId === 'ocr_seal_det') return 'OCR model - seal detector';
  if (assetId.startsWith('ocr_rec_')) return 'OCR model - recognizer';
  if (assetId.startsWith('orientation_')) return 'Orientation model';
  if (assetId === 'table_paddle_cls' || assetId === 'table_q_cls') return 'Table model - classifier';
  if (assetId.startsWith('table_')) return 'Table model - structure';
  if (assetId.startsWith('formula_')) return 'Formula model';
  return 'Model';
}

function assetHasOnnxPath(asset) {
  return /\.onnx(?:[?#].*)?$/i.test(asset?.url ?? '') || /\.onnx(?:[?#].*)?$/i.test(asset?.localUrl ?? '');
}

export function getAssetDetailRows(assetIds, status = {}) {
  return [...new Set(assetIds)]
    .map(id => ASSET_MANIFEST[id])
    .filter(assetHasOnnxPath)
    .map(asset => ({
      id: asset.id,
      label: asset.label,
      prefix: getAssetDetailPrefix(asset.id),
      sizeBytes: asset.sizeBytes || status[asset.id]?.sizeBytes || 0,
      cached: Boolean(status[asset.id]?.cached),
      status: status[asset.id]?.cached ? 'Cached' : 'Missing',
    }));
}
