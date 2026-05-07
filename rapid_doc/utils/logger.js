/**
 * PORTING NOTE: logger.py → logger.js
 *
 * WORKAROUND: Python uses loguru for structured logging
 * REASON: loguru is not available in the browser
 * SOLUTION: Thin wrapper around console.* with module-name prefix,
 *           matching the Logger(logger_name=__name__).get_log() pattern.
 *
 * AFFECTED METHODS: Logger class → console wrapper class
 */

export class Logger {
  /**
   * @param {Object} [options]
   * @param {string} [options.loggerName] - Module name prefix for log messages
   */
  constructor({ loggerName = 'rapiddoc' } = {}) {
    this._prefix = `[${loggerName}]`;
  }

  /**
   * Returns this logger instance (mirrors Python's .get_log() pattern).
   * @returns {Logger}
   */
  getLog() {
    return this;
  }

  /**
   * @param {...*} args
   */
  info(...args) {
    console.log(this._prefix, ...args);
  }

  /**
   * @param {...*} args
   */
  debug(...args) {
    console.debug(this._prefix, ...args);
  }

  /**
   * @param {...*} args
   */
  warning(...args) {
    console.warn(this._prefix, ...args);
  }

  /**
   * @param {...*} args
   */
  error(...args) {
    console.error(this._prefix, ...args);
  }

  /**
   * @param {Error|*} err
   * @param {...*} args
   */
  exception(err, ...args) {
    console.error(this._prefix, '[EXCEPTION]', err, ...args);
  }
}

/**
 * Convenience factory matching Python usage pattern:
 *   logger = Logger(logger_name=__name__).get_log()
 *
 * @param {string} moduleName
 * @returns {Logger}
 */
export function getLogger(moduleName) {
  return new Logger({ loggerName: moduleName }).getLog();
}