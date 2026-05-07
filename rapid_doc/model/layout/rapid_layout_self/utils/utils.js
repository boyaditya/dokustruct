/**
 * PORTING NOTE: rapid_layout_self/utils/utils.py → utils.js
 *
 * WORKAROUND: Python uses hashlib, pathlib, omegaconf, and cv2 for various utils
 * REASON: None of those are available in the browser
 * SOLUTION:
 *   - read_yaml   → fetch() + js-yaml (async)
 *   - get_file_sha256 → SubtleCrypto SHA-256 via bufferSha256() (async)
 *   - save_img    → Canvas API → Blob URL (browser download or in-memory; async)
 *   - mkdir       → no-op (no filesystem in browser)
 *   - import_package → no-op / returns null (no dynamic require in browser bundles)
 *   - is_url      → URL constructor check (synchronous, unchanged)
 *
 * AFFECTED METHODS:
 *   mkdir         → no-op
 *   read_yaml     → async readYaml(urlOrText)
 *   get_file_sha256 → async getBufferSha256(buffer)
 *   save_img      → async saveImg(filename, mat)
 *   is_url        → isUrl(url)  [sync]
 *   import_package → not ported (module system handles this at build time)
 */

import * as jsyaml from 'js-yaml';

// ─── mkdir ────────────────────────────────────────────────────────────────────

/**
 * No-op in the browser (no filesystem).
 * Matches Python: mkdir(dir_path)
 * @param {string} _dirPath
 */
export function mkdir(_dirPath) {
  // No-op in browser context
}

// ─── read_yaml ────────────────────────────────────────────────────────────────

/**
 * Load and parse a YAML file from a URL (or parse a raw YAML string directly).
 * Matches Python: read_yaml(file_path) → DictConfig
 *
 * @param {string} urlOrText - A URL string (fetched via fetch) or raw YAML text
 * @returns {Promise<Object>} Parsed YAML as a plain JS object
 */
export async function readYaml(urlOrText) {
  let text;
  if (isUrl(urlOrText)) {
    const response = await fetch(urlOrText);
    if (!response.ok) {
      throw new Error(`readYaml: Failed to fetch ${urlOrText}: ${response.status}`);
    }
    text = await response.text();
  } else {
    // Treat as raw YAML string (e.g. inline config passed directly)
    text = urlOrText;
  }
  return jsyaml.load(text);
}

// ─── get_file_sha256 ─────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hex digest of an ArrayBuffer.
 * Matches Python: get_file_sha256(file_path) but operates on in-memory buffer.
 *
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>} hex string
 */
export async function getBufferSha256(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── save_img ─────────────────────────────────────────────────────────────────

/**
 * Encode a BGR cv.Mat to a PNG Blob and trigger a browser download.
 * Matches Python: save_img(save_path, img)
 *
 * @param {string} filename  - Suggested download filename (e.g. 'output.png')
 * @param {cv.Mat} mat       - BGR cv.Mat
 * @returns {Promise<Blob>}  - The PNG Blob (also triggers download in browser)
 */
export async function saveImg(filename, mat) {
  const canvas = new OffscreenCanvas(mat.cols, mat.rows);
  const ctx = canvas.getContext('2d');

  // Convert BGR → RGBA for Canvas
  let rgba = new cv.Mat();
  try {
    cv.cvtColor(mat, rgba, cv.COLOR_BGR2RGBA);
    const imageData = new ImageData(
      new Uint8ClampedArray(rgba.data),
      rgba.cols,
      rgba.rows,
    );
    ctx.putImageData(imageData, 0, 0);
  } finally {
    rgba.delete();
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });

  // Trigger browser download (only works in a Window context, not a Worker)
  if (typeof URL !== 'undefined' && typeof document !== 'undefined') {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  return blob;
}

// ─── is_url ───────────────────────────────────────────────────────────────────

/**
 * Check whether a string is an absolute HTTP/HTTPS URL.
 * Matches Python: is_url(url) → bool
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.scheme !== '' && parsed.host !== '';
  } catch {
    // Fallback regex for environments where URL constructor throws on relative paths
    return /^https?:\/\/.+/.test(url);
  }
}

// ─── import_package ───────────────────────────────────────────────────────────

/**
 * Dynamic module import (browser ES module equivalent of Python importlib).
 * Returns null if the module cannot be loaded, matching Python behaviour.
 *
 * NOTE: The module specifier must be a valid ES module URL or bare specifier
 * resolvable by the bundler's import map.
 *
 * @param {string} specifier - ES module specifier
 * @returns {Promise<Object|null>}
 */
export async function importPackage(specifier) {
  try {
    return await import(/* @vite-ignore */ specifier);
  } catch {
    return null;
  }
}
