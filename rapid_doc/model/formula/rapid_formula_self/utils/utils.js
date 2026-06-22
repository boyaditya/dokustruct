// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: utils.py → utils.js
// Python pathlib/yaml/hashlib → browser fetch/TextDecoder/SubtleCrypto

/**
 * Check if a string is a URL.
 * @param {string} s
 * @returns {boolean}
 */
export function isUrl(s) {
  return typeof s === "string" && (s.startsWith("http://") || s.startsWith("https://"));
}

/**
 * Read a YAML/config file from a URL or path.
 * PORTING NOTE: yaml.safe_load → fetch + manual YAML line parser (basic key: value).
 * For complex YAML, consider a js-yaml dependency.
 * @param {string} urlOrPath
 * @returns {Promise<object>}
 */
export async function readYaml(urlOrPath) {
  const url = isUrl(urlOrPath) ? urlOrPath : urlOrPath;
  const resp = await fetch(url);
  const text = await resp.text();
  // Basic YAML line-by-line parser (key: value only, no nesting needed for configs)
  const result = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 1).trim();
    if (val === "null" || val === "~") val = null;
    else if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (!isNaN(Number(val)) && val !== "") val = Number(val);
    result[key] = val;
  }
  return result;
}

/**
 * Compute SHA-256 hex digest of an ArrayBuffer/Uint8Array.
 * PORTING NOTE: hashlib.sha256 → SubtleCrypto.digest
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<string>}
 */
export async function getFileSha256(data) {
  const buf = data instanceof Uint8Array ? data.buffer : data;
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * No-op stub for Python importPackage (dynamic import handled natively by browser ES modules).
 * @param {string} _pkgName
 * @returns {null}
 */
export function importPackage(_pkgName) {
  // PORTING NOTE: importPackage is a Python runtime import helper.
  // In browser ES modules, use native `import()` syntax instead.
  return null;
}

/**
 * mkdir stub — no filesystem in browser.
 * PORTING NOTE: pathlib.mkdir → no-op in browser; IndexedDB handles storage.
 * @param {string} _dirPath
 */
export function mkdir(_dirPath) {
  // no-op in browser
}
