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
    // SHA-256 of locally-patched file (via patch_ppdoclayout.py)
    sha256: '6f4cd6e99c9384751923adb02565b5541f19fa8b5a4b4fdc1e24c7c30883d1a0',
  }),
  layout_pp_doclayoutv3: asset({
    id: 'layout_pp_doclayoutv3',
    label: 'PP-DocLayoutV3',
    url: hfAsset('layout/PP-DocLayoutV3/pp_doclayoutv3.onnx'),
    localUrl: '/models/layout/PP-DocLayoutV3/pp_doclayoutv3.onnx',
    sizeBytes: 129_857_962,
    // SHA-256 of locally-patched file (via patch_ppdoclayout.py)
    sha256: '0f5997e6bef6eaaa8b3f2b487106877d55a0b9b218b353895bb3a2df0c6d9393',
  }),
  layout_pp_doclayout_plus_l: asset({
    id: 'layout_pp_doclayout_plus_l',
    label: 'PP-DocLayout Plus L',
    url: hfAsset('layout/PP-DocLayout_plus-L/pp_doclayout_plus_l.onnx'),
    localUrl: '/models/layout/PP-DocLayout_plus-L/pp_doclayout_plus_l.onnx',
    sizeBytes: 129_559_772,
    // SHA-256 of locally-patched file (via patch_ppdoclayout.py)
    sha256: '79583a4b865279d50dd20f6b74436927e91ef6c63dea2f09a8cdb714a7fd09b5',
  }),
  layout_pp_doclayout: asset({
    id: 'layout_pp_doclayout',
    label: 'PP-DocLayout L',
    localUrl: '/models/layout/PP-DocLayout-L/pp_doclayout_l.onnx',
    sizeBytes: 129_377_291,
    // TODO: file not present locally — fill in sha256 when model is available
  }),

  ocr_det: asset({
    id: 'ocr_det',
    label: 'OCR detector',
    url: hfAsset('ocr/ch_PP-OCRv5_mobile_det.onnx'),
    localUrl: '/models/ocr/ch_PP-OCRv5_mobile_det.onnx',
    sizeBytes: 4_819_576,
    sha256: '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae',
  }),
  ocr_rec_ch: asset({
    id: 'ocr_rec_ch',
    label: 'OCR recognizer Chinese + English',
    url: hfAsset('ocr/ch_PP-OCRv5_rec_mobile_infer.onnx'),
    localUrl: '/models/ocr/ch_PP-OCRv5_rec_mobile_infer.onnx',
    sizeBytes: 16_631_306,
    sha256: '5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5',
  }),
  ocr_rec_en: asset({
    id: 'ocr_rec_en',
    label: 'OCR recognizer English',
    url: hfAsset('ocr/en_PP-OCRv5_rec_mobile_infer.onnx'),
    localUrl: '/models/ocr/en_PP-OCRv5_rec_mobile_infer.onnx',
    sizeBytes: 7_872_351,
    sha256: 'c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8',
  }),
  ocr_dict_ch: asset({
    id: 'ocr_dict_ch',
    label: 'OCR dictionary Chinese + English',
    url: hfAsset('ocr/ppocrv5_dict.txt'),
    localUrl: '/models/ocr/ppocrv5_dict.txt',
    sizeBytes: 74_012,
    mimeType: 'text/plain',
    sha256: 'd1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b',
  }),
  ocr_dict_en: asset({
    id: 'ocr_dict_en',
    label: 'OCR dictionary English',
    url: hfAsset('ocr/ppocrv5_en_dict.txt'),
    localUrl: '/models/ocr/ppocrv5_en_dict.txt',
    sizeBytes: 1_416,
    mimeType: 'text/plain',
    sha256: 'e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6',
  }),
  ocr_seal_det: asset({
    id: 'ocr_seal_det',
    label: 'OCR seal detector',
    url: hfAsset('ocr/pp-ocrv4_mobile_seal_det.onnx'),
    localUrl: '/models/ocr/pp-ocrv4_mobile_seal_det.onnx',
    sizeBytes: 4_826_518,
    sha256: 'e6109a1022b5ebf0822fc00646ef2398a7ef387390ca5c978de79352b1314204',
  }),

  orientation_rapid: asset({
    id: 'orientation_rapid',
    label: 'Document orientation classifier',
    url: hfAsset('orientation/rapid_orientation.onnx'),
    localUrl: '/models/orientation/rapid_orientation.onnx',
    sizeBytes: 6_783_084,
    sha256: '2f62c9bfb830a0b417241269fde7ef2d0ad5446c0ed2b8af33b1f6543545e8e2',
  }),

  table_unet: asset({
    id: 'table_unet',
    label: 'Table UNET structure model',
    url: hfAsset('table/unet.onnx'),
    localUrl: '/models/table/unet.onnx',
    sizeBytes: 8_335_007,
    sha256: '0ea48d3a17e35ef5c2e498a5e799566073234d39b1079ca21d9f4fafe73c6d20',
  }),
  table_slanet_plus: asset({
    id: 'table_slanet_plus',
    label: 'Table SLANet Plus model',
    url: hfAsset('table/slanet-plus.onnx'),
    localUrl: '/models/table/slanet-plus.onnx',
    sizeBytes: 7_745_780,
    sha256: 'f9ce699522678406dbab901f4f663346dd8f04f7c752dd3c1bb70554871e49b7',
  }),
  table_ppstructure_zh: asset({
    id: 'table_ppstructure_zh',
    label: 'PP-Structure table Chinese',
    url: hfAsset('table/ch_ppstructure_mobile_v2_SLANet.onnx'),
    localUrl: '/models/table/ch_ppstructure_mobile_v2_SLANet.onnx',
    sizeBytes: 7_790_807,
    sha256: 'ddfc6c97ee4db2a5e9de4de8b6a14508a39d42d228503219fdfebfac364885e3',
  }),
  table_ppstructure_en: asset({
    id: 'table_ppstructure_en',
    label: 'PP-Structure table English',
    url: hfAsset('table/en_ppstructure_mobile_v2_SLANet.onnx'),
    localUrl: '/models/table/en_ppstructure_mobile_v2_SLANet.onnx',
    sizeBytes: 7_704_409,
    sha256: '2cae17d16a16f9df7229e21665fe3fbe06f3ca85b2024772ee3e3142e955aa60',
  }),
  table_dict_ch: asset({
    id: 'table_dict_ch',
    label: 'Table structure dictionary',
    url: hfAsset('table/table_structure_dict_ch.txt'),
    localUrl: '/models/table/table_structure_dict_ch.txt',
    sizeBytes: 578,
    mimeType: 'text/plain',
    sha256: '68d344a84b726e043f390122240ff2b2ced2949b2a80ce9b61ae955054d190ef',
  }),
  table_paddle_cls: asset({
    id: 'table_paddle_cls',
    label: 'Table Paddle classifier',
    url: hfAsset('table/table_cls/paddle_cls.onnx'),
    localUrl: '/models/table/table_cls/paddle_cls.onnx',
    sizeBytes: 6_771_838,
    sha256: '21c801f0c403cf960f9f1ccaecf506585b3b98421208033755b9e67cd2371492',
  }),
  table_q_cls: asset({
    id: 'table_q_cls',
    label: 'Table QAnything classifier',
    url: hfAsset('table/table_cls/q_cls.onnx'),
    localUrl: '/models/table/table_cls/q_cls.onnx',
    sizeBytes: 16_793_553,
    sha256: 'ef940037471c49f5d35ba2b1d9df9a19eabddf03f1689026d2a5bcab5efe577b',
  }),

  formula_pp_formulanet_plus_s: asset({
    id: 'formula_pp_formulanet_plus_s',
    label: 'PP-FormulaNet Plus S',
    pack: 'formula',
    url: hfAsset('formula/PP-FormulaNet_plus-S/pp_formulanet_plus_s.onnx'),
    localUrl: '/models/formula/PP-FormulaNet_plus-S/pp_formulanet_plus_s.onnx',
    sizeBytes: 233_421_946,
    sha256: '30998d10c94ccff1ad8981df0c71048cb1f3eec7b1e515b809767f1f72aebe3b',
    optional: true,
  }),
  formula_pp_formulanet_plus_m: asset({
    id: 'formula_pp_formulanet_plus_m',
    label: 'PP-FormulaNet Plus M',
    pack: 'formula',
    url: hfAsset('formula/PP-FormulaNet_plus-M/pp_formulanet_plus_m.onnx'),
    localUrl: '/models/formula/PP-FormulaNet_plus-M/pp_formulanet_plus_m.onnx',
    sizeBytes: 593_915_961,
    sha256: '71b6d389cf7b857e45252a4b98cfced1a3ffca7bf24d9497d02d052a41d9493b',
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
    sha256: '6a64ac1bde7d52ebf91da36e30e0ea36df0771d9b5f734f58fa60662f0e9e84b',
    optional: true,
  }),
  formula_latex_ocr_resizer: asset({
    id: 'formula_latex_ocr_resizer',
    label: 'LaTeX-OCR image resizer',
    pack: 'formula',
    url: hfAsset('formula/LaTeX-OCR/image_resizer.onnx'),
    localUrl: '/models/formula/LaTeX-OCR/image_resizer.onnx',
    sizeBytes: 38_967_751,
    sha256: 'e0b075c39700f64d50400f39c8fc186bbb3b5d84d31864008313f376603aca9d',
    optional: true,
  }),
  formula_latex_ocr_encoder: asset({
    id: 'formula_latex_ocr_encoder',
    label: 'LaTeX-OCR encoder',
    pack: 'formula',
    url: hfAsset('formula/LaTeX-OCR/encoder.onnx'),
    localUrl: '/models/formula/LaTeX-OCR/encoder.onnx',
    sizeBytes: 89_008_136,
    sha256: '01bf5dc25539ca0cd5b1bd29296ea495977a6ba5f629dc4178277809d26e5e7d',
    optional: true,
  }),
  formula_latex_ocr_decoder: asset({
    id: 'formula_latex_ocr_decoder',
    label: 'LaTeX-OCR decoder',
    pack: 'formula',
    url: hfAsset('formula/LaTeX-OCR/decoder.onnx'),
    localUrl: '/models/formula/LaTeX-OCR/decoder.onnx',
    sizeBytes: 50_952_726,
    sha256: 'bd695497bf1b22279b7626f5916c79226e1e244c84355f8da7edfd2d921d0072',
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
    sha256: '1dc27b18d6a518d0d5ff3f4bb7bd98521fe80ad39e5b2a246d4109f1bb9d5019',
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
