// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: models_download_utils.py → models_download_utils.js
 *
 * WORKAROUND: File system downloads / omegaconf / SHA256 validation
 * REASON: Browser cannot write files to disk; model files loaded via fetch/OPFS/IndexedDB
 * SOLUTION: Stub exports — model loading is handled by individual model module init().
 *   Browser model loading pattern: fetch URL → ArrayBuffer → ort.InferenceSession.create(buffer)
 *
 * All download functions are stubs that log a warning.
 */

/**
 * Load a YAML config from a URL.
 * PORTING NOTE: OmegaConf.load(file_path) → fetch + js-yaml
 * @param {string} url
 * @returns {Promise<object>}
 */
export async function readYaml(url) {
  const { load } = await import('js-yaml');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`[models_download_utils] Failed to fetch YAML: ${url}`);
  const text = await response.text();
  return load(text);
}

/**
 * Not applicable in browser — model files are loaded at init time via fetch.
 * PORTING NOTE: default_download → stub
 */
export function defaultDownload(_mineruModelsDir, _modelsPkg, _configsPkg) {
  console.warn('[models_download_utils] defaultDownload is not supported in browser. Models are loaded via fetch/WASM.');
}

/**
 * Not applicable in browser.
 * PORTING NOTE: ocr_download → stub
 */
export function ocrDownload(_mineruModelsDir, _modelsPkg, _configsPkg) {
  console.warn('[models_download_utils] ocrDownload is not supported in browser.');
}

/**
 * Fetch a model file as an ArrayBuffer (browser-native model loading).
 * Replacement for file-system based download in Python.
 *
 * @param {string} modelUrl - URL to the ONNX/model file
 * @param {object} [opts]
 * @param {string|null} [opts.sha256=null] - expected SHA-256 (currently not validated)
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchModelBuffer(modelUrl, { sha256: _sha256 = null } = {}) {
  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`[models_download_utils] Failed to fetch model: ${modelUrl}`);
  return response.arrayBuffer();
}
