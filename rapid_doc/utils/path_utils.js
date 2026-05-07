/**
 * PORTING NOTE: path_utils.py → path_utils.js
 *
 * WORKAROUND: Python uses pathlib.Path and os.path for filesystem operations
 * REASON: No filesystem access in the browser; paths are URLs or virtual strings
 * SOLUTION: URL-based path manipulation using string operations and the URL API
 *
 * AFFECTED METHODS: All path functions → URL/string equivalents
 */

/**
 * Join URL path segments (equivalent to os.path.join).
 * @param {...string} parts
 * @returns {string}
 */
export function joinPath(...parts) {
  return parts
    .map((part, i) => {
      if (i === 0) return part.replace(/\/+$/, '');
      return part.replace(/^\/+/, '').replace(/\/+$/, '');
    })
    .filter(Boolean)
    .join('/');
}

/**
 * Get the filename stem (without extension), equivalent to Path.stem.
 * @param {string} filePath
 * @returns {string}
 */
export function getStem(filePath) {
  const base = filePath.split('/').pop().split('\\').pop();
  const dotIndex = base.lastIndexOf('.');
  return dotIndex > 0 ? base.slice(0, dotIndex) : base;
}

/**
 * Get the file extension including the dot, equivalent to Path.suffix.
 * @param {string} filePath
 * @returns {string}
 */
export function getSuffix(filePath) {
  const base = filePath.split('/').pop().split('\\').pop();
  const dotIndex = base.lastIndexOf('.');
  return dotIndex > 0 ? base.slice(dotIndex) : '';
}

/**
 * Get the parent directory path, equivalent to Path.parent.
 * @param {string} filePath
 * @returns {string}
 */
export function getParent(filePath) {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(0, lastSlash) || '/' : '.';
}

/**
 * Get the base name (filename with extension), equivalent to os.path.basename.
 * @param {string} filePath
 * @returns {string}
 */
export function getBasename(filePath) {
  return filePath.split('/').pop().split('\\').pop();
}

/**
 * Check if a path is an HTTP/HTTPS URL.
 * @param {string} path
 * @returns {boolean}
 */
export function isUrl(path) {
  try {
    const url = new URL(path);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Resolve a path relative to a base URL (equivalent to Path.resolve or os.path.abspath).
 * @param {string} base - Base URL string
 * @param {string} relative - Relative path
 * @returns {string}
 */
export function resolvePath(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return joinPath(base, relative);
  }
}