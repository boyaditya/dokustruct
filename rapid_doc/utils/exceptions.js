/**
 * PORTING NOTE: exceptions.py → exceptions.js
 *
 * WORKAROUND: Python custom exception classes extend Exception
 * REASON: JS uses Error subclasses instead
 * SOLUTION: Standard ES6 class extending Error with same names
 *
 * AFFECTED METHODS: All exception constructors
 */

export class FileNotExistsException extends Error {
  /** @param {string} message */
  constructor(message = 'File does not exist') {
    super(message);
    this.name = 'FileNotExistsException';
  }
}

export class EmptyDataException extends Error {
  /** @param {string} message */
  constructor(message = 'Data is empty') {
    super(message);
    this.name = 'EmptyDataException';
  }
}

export class InvalidParams extends Error {
  /** @param {string} message */
  constructor(message = 'Invalid parameters') {
    super(message);
    this.name = 'InvalidParams';
  }
}

export class AbortException extends Error {
  /** @param {string} message */
  constructor(message = 'Operation aborted') {
    super(message);
    this.name = 'AbortException';
  }
}