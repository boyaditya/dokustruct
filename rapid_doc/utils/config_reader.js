// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: config_reader.py → config_reader.js
 *
 * WORKAROUND: os.path.expanduser / os.getenv / file I/O
 * REASON: No filesystem or OS env in browser
 * SOLUTION: Config loaded from a globally registered object (window.__RAPIDDOC_CONFIG__)
 *   or from a pre-loaded JSON object; all getDevice() returns 'wasm' by default.
 *
 * WORKAROUND: torch.cuda.is_available() / torch.backends.mps.is_available()
 * REASON: No PyTorch in browser
 * SOLUTION: getDevice() always returns 'wasm' in browser
 *
 * WORKAROUND: S3 config (bucket_info)
 * REASON: S3 not used in browser
 * SOLUTION: getS3Config / getS3ConfigDict stubs that throw
 */

/**
 * Registry for runtime config injection.
 * Call `setConfig(jsonObject)` before using this module.
 * PORTING NOTE: ~/magic.json → in-memory config object
 */
let _config = null;

/**
 * Inject config at runtime (called by the embedding app).
 * @param {object|null} configObject
 */
export function setConfig(configObject) {
  _config = configObject;
}

/**
 * Read the current config (may be null).
 * PORTING NOTE: read_config() → readConfig()
 * @returns {object|null}
 */
export function readConfig() {
  // Support window-level injection for browser apps
  if (_config !== null) return _config;
  if (typeof globalThis !== 'undefined' && globalThis.__RAPIDDOC_CONFIG__) {
    _config = globalThis.__RAPIDDOC_CONFIG__;
    return _config;
  }
  return null;
}

// ---------------------------------------------------------------------------
// S3 (not applicable in browser — stub)
// ---------------------------------------------------------------------------

/**
 * @throws {Error} always — S3 not supported in browser
 */
export function getS3Config(_bucketName) {
  throw new Error('[config_reader] S3 is not supported in browser environments.');
}

/**
 * @throws {Error} always
 */
export function getS3ConfigDict(_path) {
  throw new Error('[config_reader] S3 is not supported in browser environments.');
}

/**
 * Extract bucket name from an S3 path.
 * @param {string} path
 * @returns {string}
 */
export function getBucketName(path) {
  return parseBucketKey(path)[0];
}

/**
 * Parse an S3 full path into [bucket, key].
 * @param {string} s3FullPath
 * @returns {[string, string]}
 */
export function parseBucketKey(s3FullPath) {
  let path = s3FullPath.trim();
  if (path.startsWith('s3://')) path = path.slice(5);
  if (path.startsWith('/')) path = path.slice(1);
  const idx = path.indexOf('/');
  return [path.slice(0, idx), path.slice(idx + 1)];
}

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------

/**
 * Get the compute device.
 * PORTING NOTE: CUDA/MPS/NPU detection → always 'wasm' in browser
 * @returns {string}
 */
export function getDevice() {
  // PORTING NOTE: os.getenv('MINERU_DEVICE_MODE') → check global injection
  if (typeof globalThis !== 'undefined' && globalThis.__RAPIDDOC_DEVICE__) {
    return globalThis.__RAPIDDOC_DEVICE__;
  }
  // In browser: WebGPU is the preferred EP; fall back to wasm
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    return 'webgpu';
  }
  return 'wasm';
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

/**
 * PORTING NOTE: os.getenv('MINERU_FORMULA_ENABLE') → globalThis injection
 * @param {boolean} formulaEnable
 * @returns {boolean}
 */
export function getFormulaEnable(formulaEnable) {
  if (typeof globalThis !== 'undefined' && globalThis.__RAPIDDOC_FORMULA_ENABLE__ != null) {
    return Boolean(globalThis.__RAPIDDOC_FORMULA_ENABLE__);
  }
  return formulaEnable;
}

/**
 * PORTING NOTE: os.getenv('MINERU_TABLE_ENABLE') → globalThis injection
 * @param {boolean} tableEnable
 * @returns {boolean}
 */
export function getTableEnable(tableEnable) {
  if (typeof globalThis !== 'undefined' && globalThis.__RAPIDDOC_TABLE_ENABLE__ != null) {
    return Boolean(globalThis.__RAPIDDOC_TABLE_ENABLE__);
  }
  return tableEnable;
}

/**
 * PORTING NOTE: latex-delimiter-config from ~/magic.json → readConfig()
 * @returns {object|null}
 */
export function getLatexDelimiterConfig() {
  const config = readConfig();
  if (!config) return null;
  return config['latex-delimiter-config'] ?? null;
}
