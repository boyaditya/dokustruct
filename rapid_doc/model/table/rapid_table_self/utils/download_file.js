// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: rapid_table_self/utils/download_file.py → download_file.js
// Same W4 pattern as formula's download_file.js with a different DB name.

import { getFileSha256 } from "./utils.js";

const DB_NAME = "RapidTableModelCache";
const STORE_NAME = "models";

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

async function getCached(db, url) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(url);
    req.onsuccess = e => resolve(e.target.result?.data ?? null);
    req.onerror = e => reject(e.target.error);
  });
}

async function putCached(db, url, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ url, data });
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

export class DownloadFileInput {
  constructor({ url, savePath = null, sha256 = null } = {}) {
    this.url = url;
    this.savePath = savePath;
    this.sha256 = sha256;
  }
}

export class DownloadFile {
  /**
   * @param {DownloadFileInput} input
   * @param {(progress: number) => void} [onProgress]
   * @returns {Promise<Uint8Array>}
   */
  static async run(input, onProgress = null) {
    const { url, sha256 } = input;
    const db = await openCache();
    const cached = await getCached(db, url);
    if (cached) {
      if (!sha256 || (await getFileSha256(cached)) === sha256) return cached;
    }
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`DownloadFile: failed to fetch ${url}: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const data = new Uint8Array(buf);
    if (sha256 && (await getFileSha256(data)) !== sha256) {
      throw new Error(`DownloadFile: SHA-256 mismatch for ${url}`);
    }
    await putCached(db, url, data);
    return data;
  }
}
