// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: model_handler/pp_formulanet_plus/main.py → main.js
// sync __init__ → static async create(); cv.Mat cleanup in try/finally

import * as ort from "onnxruntime-web";
import { BaseModelHandler } from "../base/index.js";
import { PPPreProcess } from "./pre_process.js";
import { PPPostProcess } from "./post_process.js";
import { RapidFormulaOutput } from "../../utils/typings.js";

/**
 * Model handler for PP-FormulaNet-Plus (S/M/L variants).
 * PORTING NOTE: PPFormulaNetPlusModelHandler(character_dict, session, target_size)
 */
export class PPFormulaNetPlusModelHandler extends BaseModelHandler {
  /**
   * @param {object} cfg
   * @param {import('../../inference_engine/onnxruntime/main.js').OrtInferSession} session
   * @param {[number,number]} targetSize
   * @param {string} tokenizerJson
   */
  constructor(cfg, session, targetSize, tokenizerJson) {
    super();
    this.session = session;
    this.targetSize = targetSize;
    this.preProcessor = new PPPreProcess(targetSize);
    this.postProcessor = new PPPostProcess(tokenizerJson);
  }

  /**
   * Run inference on a batch of images.
   * @param {cv.Mat[]} oriImgList
   * @returns {Promise<RapidFormulaOutput[]>}
   */
  async run(oriImgList) {
    const t0 = performance.now();

    // 1. Preprocess
    const { data, dims } = this.preProcessor.run(oriImgList);

    // 2. Build input tensor & run inference
    const inputName = this.session.getInputNames()[0];
    const inputTensor = new ort.Tensor("float32", data, dims);
    let outputMap = null;

    try {
      // NOTE: Formula model runs on WASM (not WebGPU) because its ONNX graph
      // contains a Loop operator (autoregressive decoder: 717 ops × ~600 iterations).
      // WebGPU dispatch overhead (~0.03ms/op) makes Loop-based models 10-20x slower
      // than WASM with SIMD. No GPU mutex needed for WASM execution.
      outputMap = await this.session.run({ [inputName]: inputTensor });

      // 3. Postprocess (WASM output is already on CPU — no getData needed)
      const outputName = this.session.getOutputNames()[0];
      const predTensor = outputMap instanceof Map
        ? (outputMap.get(outputName) ?? outputMap.values().next().value)
        : outputMap[outputName];

      const formulas = this.postProcessor.run(predTensor);

      const elapse = (performance.now() - t0) / 1000;

      return formulas.map((formula, i) => new RapidFormulaOutput({
        img: oriImgList[i],
        recFormula: formula,
        elapse: elapse / oriImgList.length,
      }));
    } finally {
      inputTensor.dispose?.();
      if (outputMap) {
        const tensors = outputMap instanceof Map ? outputMap.values() : Object.values(outputMap);
        for (const tensor of tensors) {
          tensor?.dispose?.();
        }
      }
    }
  }

  /**
   * @param {cv.Mat[]} oriImgList
   */
  preprocess(oriImgList) {
    return this.preProcessor.run(oriImgList);
  }

  /**
   * @param {import('onnxruntime-web').Tensor} preds
   */
  postprocess(preds) {
    return this.postProcessor.run(preds);
  }
}

export default PPFormulaNetPlusModelHandler;
