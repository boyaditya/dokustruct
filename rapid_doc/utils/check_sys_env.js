// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: check_sys_env.py → check_sys_env.js
 *
 * WORKAROUND: platform.system() / platform.machine() / platform.mac_ver()
 * REASON: No `platform` module in browser
 * SOLUTION: Use navigator.platform / userAgent heuristics
 *   - isWindowsEnvironment → navigator.platform check for Win
 *   - isMacEnvironment → navigator.platform check for Mac
 *   - isAppleSiliconCpu → hardcoded false (no ARM detection in browser)
 *   - isMacOsVersionSupported → hardcoded false (no OS version in browser)
 */

/**
 * Returns true if running on Windows.
 * PORTING NOTE: platform.system() == "Windows" → navigator.platform
 * @returns {boolean}
 */
export function isWindowsEnvironment() {
  return /Win/.test(typeof navigator !== 'undefined' ? navigator.platform : '');
}

/**
 * Returns true if running on macOS.
 * PORTING NOTE: platform.system() == "Darwin" → navigator.platform
 * @returns {boolean}
 */
export function isMacEnvironment() {
  return /Mac/.test(typeof navigator !== 'undefined' ? navigator.platform : '');
}

/**
 * Returns true if running on Apple Silicon.
 * PORTING NOTE: platform.machine() in ["arm64","aarch64"] → always false in browser
 * @returns {boolean}
 */
export function isAppleSiliconCpu() {
  // Browser JS cannot reliably detect ARM vs x86
  return false;
}

/**
 * Returns true if macOS version >= minVersion.
 * PORTING NOTE: platform.mac_ver()[0] version parse → always false in browser
 * @param {string} _minVersion
 * @returns {boolean}
 */
export function isMacOsVersionSupported(_minVersion = '13.5') {
  // macOS version not accessible from browser JS
  return false;
}
