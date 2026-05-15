/**
 * PORTING NOTE: download_file.py → download_file.js
 *
 * WORKAROUND: Python uses urllib/requests to write files to disk
 * REASON: No filesystem write access in the browser
 * SOLUTION: fetch() with progress tracking; IndexedDB for persistent caching
 *           of model files so they are not re-downloaded on every page load.
 *
 * AFFECTED METHODS: DownloadFile.__call__ → async downloadFile(); disk cache → IndexedDB
 */

import { getLogger } from './logger.js';

const logger = getLogger('download_file');
const DB_NAME = 'rapiddoc_model_cache';
const DB_VERSION = 1;
const STORE_NAME = 'models';

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

/**
 * Open (or create) the IndexedDB model cache.
 * @returns {Promise<IDBDatabase>}
 */
function openCacheDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Retrieve a cached ArrayBuffer from IndexedDB.
 * @param {string} key - cache key (URL)
 * @returns {Promise<ArrayBuffer|null>}
 */
async function getFromCache(key) {
  try {
    const db = await openCacheDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = (e) => resolve(e.target.result ?? null);
      req.onerror = (e) => reject(e.target.error);
    });
  } catch (err) {
    logger.warning('Cache read failed:', err);
    return null;
  }
}

/**
 * Save an ArrayBuffer to IndexedDB.
 * @param {string} key
 * @param {ArrayBuffer} buffer
 * @returns {Promise<void>}
 */
async function saveToCache(key, buffer) {
  try {
    const db = await openCacheDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(buffer, key);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  } catch (err) {
    logger.warning('Cache write failed:', err);
  }
}

// ─── DownloadFileInput (mirrors Python @dataclass) ───────────────────────────

/**
 * @typedef {Object} DownloadFileInputData
 * @property {string}   url           - Remote URL of the file
 * @property {string}   [savePath]    - Logical save path / cache key override
 * @property {string}   [md5]         - Expected MD5 hash for integrity check
 * @property {function(number):void} [onProgress] - Progress callback (0-100)
 * @property {AbortSignal|null} [signal] - Optional cancellation signal
 */

export class DownloadFileInput {
  /**
   * @param {DownloadFileInputData} data
   */
  constructor(data) {
    /** @type {string} */
    this.url = data.url;
    /** @type {string} */
    this.savePath = data.savePath ?? data.url;
    /** @type {string|null} */
    this.md5 = data.md5 ?? null;
    /** @type {function(number):void|null} */
    this.onProgress = data.onProgress ?? null;
    /** @type {AbortSignal|null} */
    this.signal = data.signal ?? null;
  }
}

// ─── Concatenate Uint8Array chunks ───────────────────────────────────────────

/**
 * @param {Uint8Array[]} chunks
 * @returns {Uint8Array}
 */
function concatUint8Arrays(chunks) {
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// ─── DownloadFile (mirrors Python class) ─────────────────────────────────────

export class DownloadFile {
  /**
   * Download a file from a URL, with IndexedDB caching and progress reporting.
   * Mirrors Python: DownloadFile()(cfg)
   *
   * @param {DownloadFileInput} cfg
   * @returns {Promise<ArrayBuffer>}
   */
  async call(cfg) {
    const cacheKey = cfg.savePath;
    if (cfg.signal?.aborted) {
      throw new DOMException('Operation aborted', 'AbortError');
    }

    // Check IndexedDB cache first
    const cached = await getFromCache(cacheKey);
    if (cached) {
      logger.info(`Cache hit: ${cacheKey}`);
      return cached;
    }

    logger.info(`Downloading: ${cfg.url}`);

    const response = await fetch(cfg.url, { signal: cfg.signal ?? undefined });
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${cfg.url}`);
    }

    const contentLength = parseInt(response.headers.get('Content-Length') ?? '0', 10);
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (cfg.signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (cfg.onProgress && contentLength > 0) {
          cfg.onProgress((received / contentLength) * 100);
        }
      }
    } catch (err) {
      if (cfg.signal?.aborted || err?.name === 'AbortError') {
        try {
          await reader.cancel();
        } catch { /* ignore */ }
      }
      throw err;
    } finally {
      try {
        reader.releaseLock();
      } catch { /* ignore */ }
    }

    if (cfg.signal?.aborted) {
      throw new DOMException('Operation aborted', 'AbortError');
    }
    const buffer = concatUint8Arrays(chunks).buffer;
    await saveToCache(cacheKey, buffer);
    logger.info(`Download complete and cached: ${cacheKey}`);
    return buffer;
  }
}

/**
 * Convenience function matching Python usage.
 * @param {string} url
 * @param {function(number):void} [onProgress]
 * @returns {Promise<ArrayBuffer>}
 */
export async function downloadFile(url, onProgress = null) {
  const downloader = new DownloadFile();
  return downloader.call(new DownloadFileInput({ url, onProgress }));
}

// CPU-only model list (mirrors Python CPU_MODEL constant)
export const CPU_MODEL = Object.freeze([
  'pp_doclayoutv2.onnx',
  'pp_formulanet_plus_m.onnx',
  'ch_PP-OCRv5_rec_mobile_infer.onnx',
  'ch_PP-OCRv5_mobile_det.onnx',
  'ch_ppocr_mobile_v2.0_cls_infer.onnx',
  'ppocrv5_dict.txt',
  'FZYTK.TTF',
  'paddle_cls.onnx',
  'q_cls.onnx',
  'unet.onnx',
  'slanet-plus.onnx',
]);
