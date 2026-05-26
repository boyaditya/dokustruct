// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: typings.py → typings.js
// Python dataclasses + Enum → JS classes + Object.freeze constants

/** @enum {string} */
export const ModelType = Object.freeze({
  PP_FORMULANET_PLUS_S: "pp_formulanet_plus_s",
  PP_FORMULANET_PLUS_M: "pp_formulanet_plus_m",
  PP_FORMULANET_PLUS_L: "pp_formulanet_plus_l",
});

/** @enum {string} */
export const EngineType = Object.freeze({
  ONNXRUNTIME: "onnxruntime",
  TORCH: "torch",
});

/**
 * Input configuration for RapidFormula.
 */
export class RapidFormulaInput {
  /**
   * @param {object} params
   * @param {string} [params.modelType]
   * @param {string|null} [params.modelDirOrPath]
   * @param {string|null} [params.dictKeysPath]
   * @param {string} [params.engineType]
   * @param {object} [params.engineCfg]
   */
  constructor({
    // INTENTIONAL F2: browser default uses S for cleaner/faster UI output; Python parity callers should pass M explicitly.
    modelType = ModelType.PP_FORMULANET_PLUS_S,
    modelDirOrPath = null,
    dictKeysPath = null,
    engineType = EngineType.ONNXRUNTIME,
    engineCfg = null,
  } = {}) {
    this.modelType = modelType;
    this.modelDirOrPath = modelDirOrPath;
    this.dictKeysPath = dictKeysPath;
    this.engineType = engineType;
    this.engineCfg = engineCfg;
  }
}

/**
 * Output from RapidFormula inference.
 */
export class RapidFormulaOutput {
  /**
   * @param {object} params
   * @param {ImageData|null} [params.img]
   * @param {string[]|null} [params.recFormula]
   * @param {number} [params.elapse]
   */
  constructor({ img = null, recFormula = null, elapse = 0 } = {}) {
    this.img = img;
    this.recFormula = recFormula;
    this.elapse = elapse;
  }
}
