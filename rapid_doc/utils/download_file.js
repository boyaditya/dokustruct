/**
 * File download with IndexedDB caching, manual asset progress, and fallback URLs.
 */

import { getLogger } from './logger.js';
import {
  ASSET_MANIFEST,
  findAssetByUrl,
  getAsset,
  getAssetSourceUrls,
} from './model_url_map.js';

const logger = getLogger('download_file');
const DB_NAME = 'rapiddoc_model_cache';
const DB_VERSION = 2;
const STORE_NAME = 'models';

const memoryCache = new Map();
const objectUrlCache = new Map();

function hasIndexedDb() {
  return typeof indexedDB !== 'undefined' && indexedDB?.open;
}

function cloneArrayBuffer(buffer) {
  if (buffer instanceof ArrayBuffer) return buffer.slice(0);
  if (ArrayBuffer.isView(buffer)) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  return buffer;
}

function toUint8Array(buffer) {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

function openCacheDB() {
  return new Promise((resolve, reject) => {
    if (!hasIndexedDb()) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getFromCache(key) {
  if (memoryCache.has(key)) return cloneArrayBuffer(memoryCache.get(key));
  if (!hasIndexedDb()) return null;
  try {
    const db = await openCacheDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = (e) => {
        const value = e.target.result ?? null;
        resolve(value ? cloneArrayBuffer(value) : null);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  } catch (err) {
    logger.warning('Cache read failed:', err);
    return null;
  }
}

async function saveToCache(key, buffer) {
  const cloned = cloneArrayBuffer(buffer);
  memoryCache.set(key, cloned);
  if (!hasIndexedDb()) return;
  try {
    const db = await openCacheDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(cloned, key);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  } catch (err) {
    logger.warning('Cache write failed:', err);
  }
}

async function deleteFromCache(key) {
  memoryCache.delete(key);
  const objectUrl = objectUrlCache.get(key);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrlCache.delete(key);
  if (!hasIndexedDb()) return;
  try {
    const db = await openCacheDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  } catch (err) {
    logger.warning('Cache delete failed:', err);
  }
}

export class DownloadFileInput {
  constructor(data = {}) {
    this.url = data.url;
    this.savePath = data.savePath ?? data.url;
    this.md5 = data.md5 ?? null;
    this.sha256 = data.sha256 ?? null;
    this.onProgress = data.onProgress ?? null;
    this.signal = data.signal ?? null;
    this.fallbackUrls = data.fallbackUrls ?? [];
  }
}

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

function makeProgressEvent({
  asset = null,
  sourceUrl,
  loadedBytes = 0,
  totalBytes = 0,
  percent = 0,
  phase = 'downloading',
  group = null,
}) {
  return {
    assetId: asset?.id ?? null,
    label: asset?.label ?? sourceUrl,
    sourceUrl,
    loadedBytes,
    totalBytes,
    percent: Math.max(0, Math.min(100, Number(percent) || 0)),
    indeterminate: !totalBytes,
    phase,
    group,
  };
}

async function fetchBufferWithProgress(url, { signal = null, onProgress = null, asset = null, group = null } = {}) {
  if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');

  const response = await fetch(url, { signal: signal ?? undefined });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);

  const contentLength = Number.parseInt(response.headers.get('Content-Length') ?? '0', 10) || 0;
  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    onProgress?.(makeProgressEvent({
      asset,
      sourceUrl: url,
      loadedBytes: buffer.byteLength,
      totalBytes: buffer.byteLength,
      percent: 100,
      group,
    }));
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(makeProgressEvent({
        asset,
        sourceUrl: url,
        loadedBytes: received,
        totalBytes: contentLength,
        percent: contentLength ? (received / contentLength) * 100 : 0,
        group,
      }));
    }
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      try { await reader.cancel(); } catch { /* ignore */ }
    }
    throw err;
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  return concatUint8Arrays(chunks).buffer;
}

async function downloadFromSources({
  sources,
  cacheKey,
  signal = null,
  onProgress = null,
  asset = null,
  group = null,
}) {
  const cached = await getFromCache(cacheKey);
  if (cached) {
    onProgress?.(makeProgressEvent({
      asset,
      sourceUrl: 'cache',
      loadedBytes: cached.byteLength,
      totalBytes: cached.byteLength,
      percent: 100,
      phase: 'cached',
      group,
    }));
    return cached;
  }

  let lastError = null;
  for (const sourceUrl of sources.filter(Boolean)) {
    try {
      logger.info(`Downloading: ${sourceUrl}`);
      const buffer = await fetchBufferWithProgress(sourceUrl, {
        signal,
        onProgress,
        asset,
        group,
      });
      await saveToCache(cacheKey, buffer);
      onProgress?.(makeProgressEvent({
        asset,
        sourceUrl,
        loadedBytes: buffer.byteLength,
        totalBytes: buffer.byteLength,
        percent: 100,
        phase: 'cached',
        group,
      }));
      return buffer;
    } catch (err) {
      lastError = err;
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      logger.warning(`Download source failed: ${sourceUrl}`, err);
    }
  }
  throw lastError ?? new Error(`No download source available for ${cacheKey}`);
}

export class DownloadFile {
  async call(cfg) {
    const resolvedAsset = findAssetByUrl(cfg.url);
    if (resolvedAsset) {
      return downloadAsset(resolvedAsset.id, (event) => cfg.onProgress?.(event.percent), cfg.signal);
    }

    return downloadFromSources({
      sources: [cfg.url, ...(cfg.fallbackUrls ?? [])],
      cacheKey: cfg.savePath,
      signal: cfg.signal,
      onProgress: (event) => cfg.onProgress?.(event.percent),
    });
  }

  static async run(input, onProgress = null) {
    const cfg = input instanceof DownloadFileInput ? input : new DownloadFileInput(input);
    const buffer = await new DownloadFile().call(new DownloadFileInput({
      ...cfg,
      onProgress: onProgress
        ? (percent) => onProgress(percent)
        : cfg.onProgress,
    }));
    return toUint8Array(buffer);
  }
}

export async function getAssetStatus(assetId) {
  const asset = getAsset(assetId);
  if (!asset) return { id: assetId, status: 'unknown', cached: false, sizeBytes: 0 };
  const cached = await getFromCache(asset.cacheKey);
  return {
    id: assetId,
    label: asset.label,
    cached: Boolean(cached),
    status: cached ? 'cached' : 'missing',
    sizeBytes: cached?.byteLength ?? asset.sizeBytes ?? 0,
    expectedSizeBytes: asset.sizeBytes ?? 0,
    pack: asset.pack,
    optional: asset.optional,
  };
}

export async function getAssetsStatus(assetIds) {
  const entries = await Promise.all([...new Set(assetIds)].map(id => getAssetStatus(id)));
  return Object.fromEntries(entries.map(status => [status.id, status]));
}

export async function downloadAsset(assetId, onProgress = null, signal = null) {
  const asset = getAsset(assetId);
  if (!asset) throw new Error(`Unknown asset id "${assetId}"`);
  return downloadFromSources({
    sources: getAssetSourceUrls(assetId),
    cacheKey: asset.cacheKey,
    signal,
    onProgress,
    asset,
  });
}

export async function downloadModel(modelId, onProgress = null, signal = null) {
  return downloadAsset(modelId, (event) => {
    onProgress?.(event?.percent ?? 0);
  }, signal);
}

export async function downloadAssetGroup(assetIds, onProgress = null, signal = null) {
  const ids = [...new Set(assetIds)].filter(id => Boolean(ASSET_MANIFEST[id]));
  const totalExpectedBytes = ids.reduce((sum, id) => sum + (ASSET_MANIFEST[id].sizeBytes || 0), 0);
  let completedExpectedBytes = 0;
  const results = {};

  for (let index = 0; index < ids.length; index++) {
    if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
    const id = ids[index];
    const asset = ASSET_MANIFEST[id];
    const groupBase = {
      index,
      total: ids.length,
      completed: index,
      totalExpectedBytes,
    };
    const buffer = await downloadAsset(id, (event) => {
      const loadedWithinAsset = event.indeterminate
        ? 0
        : Math.min(event.loadedBytes, asset.sizeBytes || event.totalBytes || event.loadedBytes);
      const loadedBytes = completedExpectedBytes + loadedWithinAsset;
      const percent = totalExpectedBytes
        ? (loadedBytes / totalExpectedBytes) * 100
        : ((index + (event.percent / 100)) / Math.max(ids.length, 1)) * 100;
      onProgress?.({
        ...event,
        percent,
        group: {
          ...groupBase,
          completed: index,
          loadedBytes,
        },
      });
    }, signal);
    results[id] = buffer;
    completedExpectedBytes += asset.sizeBytes || buffer.byteLength || 0;
    onProgress?.(makeProgressEvent({
      asset,
      sourceUrl: 'cache',
      loadedBytes: completedExpectedBytes,
      totalBytes: totalExpectedBytes,
      percent: totalExpectedBytes ? (completedExpectedBytes / totalExpectedBytes) * 100 : ((index + 1) / ids.length) * 100,
      phase: 'cached',
      group: {
        ...groupBase,
        completed: index + 1,
        loadedBytes: completedExpectedBytes,
      },
    }));
  }

  return results;
}

export async function clearAsset(assetId) {
  const asset = getAsset(assetId);
  if (!asset) return;
  await deleteFromCache(asset.cacheKey);
}

export async function getCachedAssetObjectUrl(assetId) {
  const asset = getAsset(assetId);
  if (!asset) return null;
  const cached = await getFromCache(asset.cacheKey);
  if (!cached) return null;
  if (objectUrlCache.has(asset.cacheKey)) return objectUrlCache.get(asset.cacheKey);
  const url = URL.createObjectURL(new Blob([cached], { type: asset.mimeType || 'application/octet-stream' }));
  objectUrlCache.set(asset.cacheKey, url);
  return url;
}

export async function getAssetRuntimeUrl(assetId) {
  const cachedUrl = await getCachedAssetObjectUrl(assetId);
  if (cachedUrl) return cachedUrl;
  const asset = getAsset(assetId);
  return asset?.localUrl ?? asset?.url ?? null;
}

export async function fetchAssetBuffer(urlOrAssetId, onProgress = null, signal = null) {
  const asset = getAsset(urlOrAssetId) ?? findAssetByUrl(urlOrAssetId);
  if (asset) return downloadAsset(asset.id, onProgress, signal);
  return new DownloadFile().call(new DownloadFileInput({ url: urlOrAssetId, onProgress, signal }));
}

export async function fetchAssetText(urlOrAssetId, signal = null) {
  const buffer = await fetchAssetBuffer(urlOrAssetId, null, signal);
  return new TextDecoder().decode(buffer);
}

export async function fetchAssetJson(urlOrAssetId, signal = null) {
  return JSON.parse(await fetchAssetText(urlOrAssetId, signal));
}

export async function downloadFile(url, onProgress = null) {
  return fetchAssetBuffer(url, onProgress);
}

export function __resetAssetMemoryCacheForTests() {
  memoryCache.clear();
  for (const url of objectUrlCache.values()) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  objectUrlCache.clear();
}

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
