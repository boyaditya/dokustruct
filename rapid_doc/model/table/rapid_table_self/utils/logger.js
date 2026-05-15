// Copyright (c) Opendatalab. All rights reserved.

/** @type {Map<string, object>} */
const _loggerCache = new Map();

/**
 * Get (or create) a logger for the given name.
 * @param {string} name
 * @returns {{ debug: Function, info: Function, warn: Function, warning: Function, error: Function }}
 */
export function getLogger(name) {
  if (_loggerCache.has(name)) return _loggerCache.get(name);
  const prefix = `[${name}]`;
  const logger = {
    debug: (...args) => console.debug(prefix, ...args),
    info: (...args) => console.info(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    warning: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
  _loggerCache.set(name, logger);
  return logger;
}

export default getLogger;
