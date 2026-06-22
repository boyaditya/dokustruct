// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: PyPDFium2Parser.py → PyPDFium2Parser.js
 *
 * WORKAROUND: threading.Lock()
 * REASON: JavaScript/browser is single-threaded; mutex locks are N/A
 * SOLUTION: Export a no-op lock stub that satisfies import references
 */

/**
 * No-op lock stub — browser is single-threaded.
 * PORTING NOTE: threading.Lock() → stub object
 */
export const lock = {
  acquire: () => Promise.resolve(true),
  release: () => {},
};
