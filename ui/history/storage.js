/**
 * ui/history/storage.js
 *
 * Extracted from ui/app.js. Signature unchanged.
 */

const HISTORY_ASSET_DB = 'dokustruct_history_assets';
const OLD_HISTORY_ASSET_DB = 'rapiddoc_history_assets';
const HISTORY_ASSET_STORE = 'assets';

/**
 * Open (or create) the history asset IndexedDB.
 * @param {string} [dbName]
 * @returns {Promise<IDBDatabase>}
 */
export function openHistoryAssetDb(dbName = HISTORY_ASSET_DB) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HISTORY_ASSET_STORE)) {
        db.createObjectStore(HISTORY_ASSET_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Write a value to the history asset store.
 * @param {string} key
 * @param {any} value
 */
export async function writeHistoryAsset(key, value) {
  const db = await openHistoryAssetDb(HISTORY_ASSET_DB);
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_ASSET_STORE, 'readwrite');
      tx.objectStore(HISTORY_ASSET_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Read a value from the history asset store.
 * Falls back to the legacy DB if not found in the primary.
 * @param {string} key
 * @returns {Promise<any>}
 */
export async function readHistoryAsset(key) {
  let db = await openHistoryAssetDb(HISTORY_ASSET_DB);
  try {
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_ASSET_STORE, 'readonly');
      const req = tx.objectStore(HISTORY_ASSET_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (value !== undefined) return value;
  } finally {
    db.close();
  }

  // Fallback to legacy DB
  db = await openHistoryAssetDb(OLD_HISTORY_ASSET_DB);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HISTORY_ASSET_STORE, 'readonly');
      const req = tx.objectStore(HISTORY_ASSET_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Delete a value from both the primary and legacy history asset stores.
 * @param {string} key
 */
export async function deleteHistoryAsset(key) {
  if (!key) return;
  for (const dbName of [HISTORY_ASSET_DB, OLD_HISTORY_ASSET_DB]) {
    const db = await openHistoryAssetDb(dbName);
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_ASSET_STORE, 'readwrite');
        tx.objectStore(HISTORY_ASSET_STORE).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
}
