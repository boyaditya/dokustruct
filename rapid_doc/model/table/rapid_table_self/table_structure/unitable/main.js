// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table_structure/unitable/main.py → main.js
// UniTable requires a two-stage autoregressive encoder/decoder with kv-cache that
// cannot be trivially expressed with a single ONNX graph. Deferred to a future milestone.
// See documentation/KNOWN_ISSUES.md — T5/T23 for implementation requirements and target milestone.

/**
 * UniTable table structure recognizer — NOT YET SUPPORTED IN JS.
 *
 * The Python implementation uses a PyTorch encoder/decoder with autoregressive
 * decoding and kv-cache, which requires exporting two separate ONNX graphs
 * (encoder + decoder) plus an autoregressive loop and vocab handling.
 *
 * This class intentionally throws on construction so that callers receive a
 * clear error rather than silently producing wrong results.
 *
 * See documentation/KNOWN_ISSUES.md for full details.
 */
export class UniTableStructure {
  constructor() {
    throw new Error('UniTable not yet supported in JS — see KNOWN_ISSUES.md');
  }

  /**
   * Factory method — also throws to prevent async construction paths from
   * silently bypassing the constructor guard.
   *
   * @param {object} _cfg
   * @returns {Promise<never>}
   */
  static async create(_cfg = {}) {
    throw new Error('UniTable not yet supported in JS — see KNOWN_ISSUES.md');
  }
}

export default UniTableStructure;
