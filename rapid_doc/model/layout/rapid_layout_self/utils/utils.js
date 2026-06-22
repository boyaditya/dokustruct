/**
 * Browser-adapted utility functions for the layout module.
 */

/**
 * Check whether a string is a fetchable URL (absolute HTTP/HTTPS or root-relative path).
 * @param {string} url
 * @returns {boolean}
 */
export function isUrl(url) {
  if (typeof url !== 'string') return false;
  if (url.startsWith('/')) return true;
  return /^https?:\/\/.+/.test(url);
}
