import { RapidFormula } from "./rapid_formula_self/main.js";
import { AbortException } from "../../utils/exceptions.js";
import { formatPipelineError } from "../../utils/browser_utils.js";

/**
 * Top-level entry point for formula recognition (PP-FormulaNet).
 * Implements the standard model wrapper interface: create, predict, batchPredict, dispose.
 */
export class RapidFormulaModel {
  constructor() {
    /** @type {RapidFormula|null} */
    this._model = null;
  }

  /**
   * Create and initialize the formula model.
   * @param {object|null} [formulaConfig]
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
    if (!image) return { recFormula: "", elapse: 0 };

    try {
      const result = await this._model.run([image], 1);
      return {
        recFormula: result.recFormulas[0] ?? "",
        elapse: result.elapse,
      };
    } catch (err) {
      if (err instanceof AbortException) throw err;
      console.warn(formatPipelineError({
        stage: "formula",
        module: "RapidFormulaModel",
        message: `predict failed: ${err?.message ?? err}`,
        recoverable: true,
      }));
      return { recFormula: "", elapse: 0 };
    }
  }

  /**
   * Recognize formulas in a batch of images.
   * @param {Array<HTMLImageElement|ImageBitmap|ImageData|Uint8Array|string>} images
   * @param {number} [batchSize=1]
   * @returns {Promise<{ recFormulas: string[], elapse: number }>}
   */
  async batchPredict(images, batchSize = 1) {
    if (!images || images.length === 0) return { recFormulas: [], elapse: 0 };

    try {
      return await this._model.run(images, batchSize);
    } catch (err) {
      if (err instanceof AbortException) throw err;
      console.warn(formatPipelineError({
        stage: "formula",
        module: "RapidFormulaModel",
        message: `batchPredict failed: ${err?.message ?? err}`,
        recoverable: true,
      }));
      return { recFormulas: [], elapse: 0 };
    }
  }

  /**
   * Dispose the underlying model session.
   */
  async dispose() {
    if (this._model) {
      if (typeof this._model.dispose === "function") {
        await this._model.dispose();
      }
      this._model = null;
    }
  }
}
