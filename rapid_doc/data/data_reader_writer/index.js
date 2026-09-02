const browserFileStore = new Map();

/**
 * rapid_doc/data/data_reader_writer/index.js
 * PORTING NOTE: data/data_reader_writer/__init__.py → index.js
 *             + filebase.py, dummy.py → browser-compatible implementations
 *
 * WORKAROUND: Python file I/O + S3/cloud storage → in-memory Map storage
 * REASON: No filesystem access in browser.
 * SOLUTION: MemoryDataWriter stores bytes/strings keyed by path in a Map.
 *           FileBasedDataWriter is a browser stub (warns on write, returns empty on read).
 */

// ─── Base abstract types ──────────────────────────────────────────────────────

/**
 * Abstract base for data writers.
 * PORTING NOTE: base.DataWriter ABC → JS base class
 */
export class DataWriter {
  /** @param {string} _path @param {Uint8Array} _data */
  write(_path, _data) { throw new Error('DataWriter.write() not implemented'); }
  /** @param {string} _path @param {string} _data */
  writeString(_path, _data) { throw new Error('DataWriter.writeString() not implemented'); }
}

/**
 * Abstract base for data readers.
 * PORTING NOTE: base.DataReader ABC → JS base class
 */
export class DataReader {
  /** @param {string} _path @returns {Uint8Array} */
  readAt(_path) { throw new Error('DataReader.readAt() not implemented'); }
  /** @param {string} path @returns {Uint8Array} */
  read(path) { return this.readAt(path); }
}

// ─── MemoryDataWriter ─────────────────────────────────────────────────────────

/**
 * In-memory data writer.
 * PORTING NOTE: dummy.DummyDataWriter adapted to store data for downstream use.
 */
export class MemoryDataWriter extends DataWriter {
  constructor() {
    super();
    /** @type {Map<string, Uint8Array|string>} */
    this._store = new Map();
  }

  /**
   * @param {string} path
   * @param {Uint8Array|ArrayBuffer} data
   */
  write(path, data) {
    this._store.set(path, data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  }

  /**
   * @param {string} path
   * @param {string} data
   */
  writeString(path, data) {
    this._store.set(path, data);
  }

  /**
   * Retrieve stored data by path.
   * @param {string} path
   * @returns {Uint8Array|string|undefined}
   */
  get(path) { return this._store.get(path); }

  /** @returns {Map<string, Uint8Array|string>} */
  getStore() { return this._store; }

  /** Clear all stored data */
  clear() { this._store.clear(); }
}

// ─── FileBasedDataWriter ─────────────────────────────────────────────────────

/**
 * File-based data writer — delegates to MemoryDataWriter in browser.
 * PORTING NOTE: filebase.FileBasedDataWriter → browser stub backed by MemoryDataWriter.
 */
export class FileBasedDataWriter extends MemoryDataWriter {
  /**
   * @param {string} [parentDir='']
   */
  constructor(parentDir = '') {
    super();
    this._parentDir = parentDir;
  }

  /**
   * @param {string} path
   * @param {Uint8Array|ArrayBuffer} data
   */
  write(path, data) {
    const fullPath = this._parentDir ? `${this._parentDir}/${path}` : path;
    browserFileStore.set(fullPath, data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    super.write(fullPath, data);
  }

  /**
   * @param {string} path
   * @param {string} data
   */
  writeString(path, data) {
    const fullPath = this._parentDir ? `${this._parentDir}/${path}` : path;
    browserFileStore.set(fullPath, data);
    super.writeString(fullPath, data);
  }
}

// ─── FileBasedDataReader ─────────────────────────────────────────────────────

/**
 * File-based data reader — no-op in browser (files come from File API).
 * PORTING NOTE: filebase.FileBasedDataReader → browser stub
 */
export class FileBasedDataReader extends DataReader {
  constructor(parentDir = '') {
    super();
    this._parentDir = parentDir;
  }

  /** @returns {Uint8Array|string} */
  readAt(path) {
    const fullPath = this._parentDir ? `${this._parentDir}/${path}` : path;
    const value = browserFileStore.get(fullPath) ?? browserFileStore.get(path);
    if (value !== undefined) return value;
    console.warn(`[FileBasedDataReader] ${fullPath} is not present in the browser-backed file store.`);
    return new Uint8Array(0);
  }
}
