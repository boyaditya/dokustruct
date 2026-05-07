// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table logger — simple console wrapper with lru_cache pattern
// getLogger(name) → returns logger object (cached per name)

/** @type {Map<string, object>} */
const _loggerCache = new Map();

/**
 * Get (or create) a logger for the given name.
 * PORTING NOTE: Python lru_cache(maxsize=None) → JS Map cache
 * @param {string} name
 * @returns {{ debug: Function, info: Function, warning: Function, error: Function }}
 */
export function getLogger(name) {
  if (_loggerCache.has(name)) return _loggerCache.get(name);
  const prefix = `[${name}]`;
  const logger = {
    debug: (...args) => console.debug(prefix, ...args),
    info: (...args) => console.info(prefix, ...args),
    warning: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
  _loggerCache.set(name, logger);
  return logger;
}

export default getLogger;
