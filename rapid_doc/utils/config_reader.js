// Copyright (c) Opendatalab. All rights reserved.

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
// Device
// ---------------------------------------------------------------------------

/**
 * Get the compute device.
 * In browser: WebGPU preferred, falls back to 'wasm'.
 * @returns {string}
 */
export function getDevice() {
  if (typeof globalThis !== 'undefined' && globalThis.__RAPIDDOC_DEVICE__) {
    return globalThis.__RAPIDDOC_DEVICE__;
  }
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    return 'webgpu';
  }
  return 'wasm';
}

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

/**
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
 * @returns {object|null}
 */
export function getLatexDelimiterConfig() {
  const config = readConfig();
  if (!config) return null;
  return config['latex-delimiter-config'] ?? null;
}
