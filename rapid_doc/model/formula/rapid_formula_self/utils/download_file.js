// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: download_file.py → download_file.js
// Python requests/urllib → browser fetch + IndexedDB for caching

import { getFileSha256 } from "./utils.js";

const DB_NAME = "RapidFormulaModelCache";
const STORE_NAME = "models";

/**
 * Open IndexedDB cache.
 * @returns {Promise<IDBDatabase>}
 */
async function openCache() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "url" });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

/**
 * Get cached file from IndexedDB.
 * @param {IDBDatabase} db
 * @param {string} url
 * @returns {Promise<Uint8Array|null>}
 */
async function getCached(db, url) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(url);
    req.onsuccess = e => resolve(e.target.result ? e.target.result.data : null);
    req.onerror = e => reject(e.target.error);
  });
}

/**
 * Put file into IndexedDB.
 * @param {IDBDatabase} db
 * @param {string} url
 * @param {Uint8Array} data
 */
async function putCached(db, url, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ url, data });
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

/**
 * Input parameters for DownloadFile.
 */
export class DownloadFileInput {
  /**
   * @param {object} params
   * @param {string} params.url
   * @param {string|null} [params.savePath]
   * @param {string|null} [params.sha256]
   */
  constructor({ url, savePath = null, sha256 = null } = {}) {
    this.url = url;
    this.savePath = savePath;
    this.sha256 = sha256;
  }
}

/**
 * File downloader with IndexedDB caching.
 * PORTING NOTE: DownloadFile.run() → fetch + IndexedDB (replaces requests + pathlib)
 */
export class DownloadFile {
  /**
   * Download file from URL with optional SHA-256 verification and IndexedDB caching.
   * @param {DownloadFileInput} input
   * @param {(progress: number) => void} [onProgress]
   * @returns {Promise<Uint8Array>}
   */
  static async run(input, onProgress = null) {
    const { url, sha256 } = input;
    const db = await openCache();

    // Check cache first
    const cached = await getCached(db, url);
    if (cached) {
      if (sha256) {
        const actualHash = await getFileSha256(cached);
        if (actualHash === sha256) return cached;
      } else {
        return cached;
      }
    }

    // Fetch from network
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to download ${url}: ${resp.status} ${resp.statusText}`);

    let data;
    if (onProgress && resp.headers.get("content-length")) {
      const total = parseInt(resp.headers.get("content-length"), 10);
      const reader = resp.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        onProgress(received / total);
      }
      const combined = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      data = combined;
    } else {
      const buf = await resp.arrayBuffer();
      data = new Uint8Array(buf);
    }

    // Verify SHA-256 if provided
    if (sha256) {
      const actualHash = await getFileSha256(data);
      if (actualHash !== sha256) {
        throw new Error(`SHA-256 mismatch for ${url}: expected ${sha256}, got ${actualHash}`);
      }
    }

    await putCached(db, url, data);
    return data;
  }
}
