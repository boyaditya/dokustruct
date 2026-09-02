/**
 * OCR helper utilities — model URL resolution, caching, and character list preparation.
 */

import { DownloadFile, DownloadFileInput } from '../../utils/download_file.js';

// ─── Default model URLs ───────────────────────────────────────────────────────

export const DEFAULT_DET_MODEL_URL = '/models/ocr/ch_PP-OCRv5_mobile_det.onnx';
export const DEFAULT_REC_MODEL_URL_CH = '/models/ocr/ch_PP-OCRv5_rec_mobile_infer.onnx';
export const DEFAULT_REC_MODEL_URL_EN = '/models/ocr/en_PP-OCRv5_rec_mobile_infer.onnx';
export const REMOTE_REC_MODEL_URL_EN_CANDIDATES = [
  'https://www.modelscope.cn/models/RapidAI/PP-OCRv5_rec/resolve/main/en_PP-OCRv5_rec_mobile_infer.onnx',
  'https://www.modelscope.cn/models/RapidAI/PP-OCRv5_rec/resolve/main/PP-OCRv5_mobile_rec.onnx',
];

// SHA-256 hashes for OCR model files in public/models/
export const DEFAULT_DET_MODEL_SHA256 = '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae';
export const DEFAULT_REC_MODEL_SHA256_CH = '5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5';
export const DEFAULT_REC_MODEL_SHA256_EN = 'c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8';
export const DEFAULT_SEAL_DET_MODEL_URL = '/models/ocr/pp-ocrv4_mobile_seal_det.onnx';
export const DEFAULT_SEAL_DET_MODEL_SHA256 = 'e6109a1022b5ebf0822fc00646ef2398a7ef387390ca5c978de79352b1314204';

/**
 * Normalizes a URL to a cache key suitable for IndexedDB/Cache API storage.
 * Same-origin paths are stripped to relative form; cross-origin URLs are kept as-is.
 * @param {string} url
 * @returns {string}
 */
export function buildOcrCacheKey(url) {
  if (!url) return url;
  if (url.startsWith('/')) return url.slice(1);
  try {
    const parsed = new URL(url, self?.location?.href ?? undefined);
    if (parsed.origin === self?.location?.origin) {
      return parsed.pathname.replace(/^\//, '');
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Fetches a file as ArrayBuffer, using the download cache layer.
 * @param {string} url
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchArrayBufferCached(url) {
  const downloader = new DownloadFile();
  const cacheKey = buildOcrCacheKey(url);
  const cfg = new DownloadFileInput({ url, savePath: cacheKey });
  return downloader.call(cfg);
}

/**
 * Fetches a text file, using the download cache layer.
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function fetchTextCached(url) {
  const buf = await fetchArrayBufferCached(url);
  return new TextDecoder().decode(buf);
}

/**
 * Resolves the detection model URL from params/config.
 * @param {object} params
 * @param {object} cfg
 * @returns {string}
 */
export function resolveDetUrl(params, _cfg) {
  return params.detModelUrl ?? DEFAULT_DET_MODEL_URL;
}

/**
 * Builds a minimal fallback character list (ASCII digits + letters + punctuation).
 * @returns {string[]}
 */
export function buildDefaultCharList() {
  const chars = [];
  for (let c = 48; c <= 57; c++) chars.push(String.fromCharCode(c));
  for (let c = 65; c <= 90; c++) chars.push(String.fromCharCode(c));
  for (let c = 97; c <= 122; c++) chars.push(String.fromCharCode(c));
  chars.push(...' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
  return chars;
}

/**
 * Prepares the CTC character list by adding blank token at index 0 and space at end.
 * @param {string[]} rawCharList
 * @returns {string[]}
 */
export function prepareCtcCharacterList(rawCharList) {
  const chars = Array.isArray(rawCharList) ? [...rawCharList] : [];
  chars.push(' ');
  chars.unshift('blank');
  return chars;
}
