// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: logger.py → logger.js
// Python logging module → browser console

/**
 * Simple logger wrapper that prefixes messages with the module name.
 */
export class Logger {
  /**
   * @param {string} loggerName
   */
  constructor(loggerName) {
    this.prefix = `[${loggerName}]`;
  }

  /**
   * @returns {{ debug: Function, info: Function, warning: Function, error: Function }}
   */
  getLog() {
    const prefix = this.prefix;
    return {
      debug: (...args) => console.debug(prefix, ...args),
      info: (...args) => console.info(prefix, ...args),
      warning: (...args) => console.warn(prefix, ...args),
      error: (...args) => console.error(prefix, ...args),
    };
  }
}

export default Logger;
