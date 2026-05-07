/**
 * rapid_doc/utils/model_url_map.js
 *
 * Central registry mapping UI model IDs (from ModelManager.MODEL_CATALOG) to
 * their download URLs.
 *
 * WHY HUGGINGFACE:
 *   modelscope.cn does NOT send CORS headers, so browser fetch() is blocked.
 *   Hugging Face CDN (hf.co/resolve) explicitly allows cross-origin requests,
 *   enabling browser-side model downloads without a proxy.
 *
 * CACHE KEY:
 *   The cacheKey is used as the IndexedDB key so that the same binary is not
 *   re-downloaded if the UI model ID changes but the file is the same.
 */

import { DownloadFile, DownloadFileInput } from './download_file.js';

// ─── Model base URLs ──────────────────────────────────────────────────────────
// Source URLs match the project's own default_models.yaml configs exactly.
//
// NOTE: modelscope.cn does NOT send CORS headers on all endpoints, so browser
// fetch() may be blocked. If downloads fail with CORS errors, either:
//   a) Copy models locally with `python scripts/copy-models-to-public.py`
//      and set BASE_MODEL = '/models'   (local Vite-served files, no CORS)
//   b) Route through a CORS proxy
const MS_RAPIDDOC   = '/models';
const MS_RAPIDTABLE = '/models/table';
const MS_OCR_DET    = '/models/ocr';
const MS_OCR_REC    = '/models/ocr';

/**
 * Map of UI model IDs → download metadata.
 *
 * Each entry has:
 *   url      {string}        – CORS-enabled download URL
 *   cacheKey {string}        – stable IndexedDB cache key
 *   sha256   {string|null}   – optional integrity hash (verified if present)
 *
 * A null entry means no separate ONNX model is needed for that "model"
 * (e.g. checkbox uses pure OpenCV morphology).
 *
 * @type {Record<string, {url: string, cacheKey: string, sha256: string|null} | null>}
 */
export const UI_MODEL_URL_MAP = Object.freeze({

  // ── Layout ─────────────────────────────────────────────────────────────────
  // Source: rapid_doc/model/layout/rapid_layout_self/configs/default_models.yaml
  layout_pp_doclayoutv2: {
    url:      `${MS_RAPIDDOC}/layout/PP-DocLayoutV2/pp_doclayoutv2.onnx?t=patched3`,
    cacheKey: 'layout/PP-DocLayoutV2/pp_doclayoutv2.onnx_patched3',
    sha256:   null,
  },

  layout_pp_doclayout: {
    url:      `${MS_RAPIDDOC}/layout/PP-DocLayout-L/pp_doclayout_l.onnx?t=patched2`,
    cacheKey: 'layout/PP-DocLayout-L/pp_doclayout_l.onnx_patched2',
    sha256:   null,
  },

  layout_pp_doclayout_plus_l: {
    url:      `${MS_RAPIDDOC}/layout/PP-DocLayout_plus-L/pp_doclayout_plus_l.onnx`,
    cacheKey: 'layout/PP-DocLayout_plus-L/pp_doclayout_plus_l.onnx',
    sha256:   null,
  },

  // ── OCR ────────────────────────────────────────────────────────────────────
  // Source: rapid_doc/model/ocr/rapid_ocr.js comments
  ocr_det: {
    url:      `${MS_OCR_DET}/ch_PP-OCRv5_mobile_det.onnx`,
    cacheKey: 'ocr/ch_PP-OCRv5_mobile_det.onnx',
    sha256:   null,
  },

  ocr_rec: {
    url:      `${MS_OCR_REC}/ch_PP-OCRv5_rec_mobile_infer.onnx`,
    cacheKey: 'ocr/ch_PP-OCRv5_rec_mobile_infer.onnx',
    sha256:   null,
  },

  // ── Formula ────────────────────────────────────────────────────────────────
  // Source: rapid_doc/model/formula/rapid_formula_self/configs/default_models.yaml
  formula_pp_formulanet_plus_m: {
    url:      `${MS_RAPIDDOC}/formula/PP-FormulaNet_plus-M/pp_formulanet_plus_m.onnx`,
    cacheKey: 'formula/PP-FormulaNet_plus-M/pp_formulanet_plus_m.onnx',
    sha256:   null,
  },

  // ── Table ──────────────────────────────────────────────────────────────────
  // Source: rapid_doc/model/table/rapid_table_self/default_models.yaml
  table_unet_slanet: {
    url:      `${MS_RAPIDTABLE}/ch_ppstructure_mobile_v2_SLANet.onnx`,
    cacheKey: 'table/ch_ppstructure_mobile_v2_SLANet.onnx',
    sha256:   null,
  },

  // ── Checkbox ───────────────────────────────────────────────────────────────
  // Checkbox detection/classification uses pure OpenCV morphology — no ONNX model.
  checkbox: null,
});

// ─── downloadModel ────────────────────────────────────────────────────────────

/**
 * Download (and IndexedDB-cache) a model by its UI model ID.
 *
 * This is the function that `pipelineAdapter._downloadSingleModel()` calls via
 * `engine.downloadModel(modelId, onProgress, signal)`.
 *
 * @param {string}   modelId    – key from UI_MODEL_URL_MAP / MODEL_CATALOG.id
 * @param {(pct: number) => void} [onProgress] – called with 0-100 progress
 * @param {AbortSignal} [_signal]  – reserved; not yet forwarded to fetch
 * @returns {Promise<ArrayBuffer>}  – the cached model bytes
 * @throws {Error} if modelId is unknown or download fails
 */
export async function downloadModel(modelId, onProgress = null, _signal = null) {
  const entry = UI_MODEL_URL_MAP[modelId];
  if (entry === undefined) {
    throw new Error(`downloadModel: unknown model id "${modelId}"`);
  }
  if (entry === null) {
    // No ONNX model needed (e.g. checkbox) — resolve immediately
    onProgress?.(100);
    return new ArrayBuffer(0);
  }

  const cfg = new DownloadFileInput({
    url:        entry.url,
    savePath:   entry.cacheKey,
    onProgress: onProgress ?? null,
  });

  const downloader = new DownloadFile();
  return downloader.call(cfg);
}
