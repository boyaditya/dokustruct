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
export function resolveDetUrl(params, cfg) {
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
