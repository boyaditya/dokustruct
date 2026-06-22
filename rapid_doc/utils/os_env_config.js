// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: os_env_config.py → os_env_config.js
 *
 * WORKAROUND: os.getenv('MINERU_PDF_RENDER_TIMEOUT')
 * REASON: No OS environment variables in browser
 * SOLUTION: Return default value (300) always
 */

/**
 * Get PDF image load timeout in seconds.
 * PORTING NOTE: os.getenv('MINERU_PDF_RENDER_TIMEOUT', 300) → hardcoded 300
 * @returns {number}
 */
export function getLoadImagesTimeout() {
  return 300;
}

/**
 * Parse a positive integer from a string with fallback.
 * @param {string|null|undefined} envValue
 * @param {number} defaultValue
 * @returns {number}
 */
export function getValueFromString(envValue, defaultValue) {
  if (envValue != null) {
    const num = parseInt(envValue, 10);
    if (!isNaN(num) && num > 0) return num;
    return defaultValue;
  }
  return defaultValue;
}
