// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: rapid_formula_model.py → rapid_formula_model.js
// W1 pattern: sync __init__(formulaConfig) → static async create(formulaConfig=null)

import { RapidFormula } from "./rapid_formula_self/main.js";
import { RapidFormulaInput } from "./rapid_formula_self/utils/typings.js";

/**
 * Top-level entry point for formula recognition.
 * PORTING NOTE: RapidFormulaModel(formulaConfig) → static async create(formulaConfig)
 */
export class RapidFormulaModel {
  constructor() {
    /** @type {RapidFormula|null} */
    this._model = null;
  }

  /**
   * Create and initialize the formula model.
   * @param {RapidFormulaInput|object|null} [formulaConfig]
   * @returns {Promise<RapidFormulaModel>}
   */
  static async create(formulaConfig = null) {
    const inst = new RapidFormulaModel();
    inst._model = await RapidFormula.create(formulaConfig);
    return inst;
  }

  /**
   * Recognize formula in a single image.
   * @param {HTMLImageElement|ImageBitmap|ImageData|Uint8Array|string} image
   * @returns {Promise<{ recFormula: string, elapse: number }>}
   */
  async predict(image) {
    const result = await this._model.run([image], 1);
    return {
      recFormula: result.recFormulas[0] ?? "",
      elapse: result.elapse,
    };
  }

  /**
   * Recognize formulas in a batch of images.
   * @param {Array<HTMLImageElement|ImageBitmap|ImageData|Uint8Array|string>} images
   * @param {number} [batchSize=1]
   * @returns {Promise<{ recFormulas: string[], elapse: number }>}
   */
  async batchPredict(images, batchSize = 1) {
    return this._model.run(images, batchSize);
  }
}

export default RapidFormulaModel;
