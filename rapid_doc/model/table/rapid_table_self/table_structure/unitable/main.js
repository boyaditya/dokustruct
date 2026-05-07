// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table_structure/unitable/main.py → main.js
// PORTING NOTE: UniTableStructure uses PyTorch encoder/decoder directly (not ONNX).
// For browser usage, this requires exporting the UniTable model to ONNX format first.
// This implementation provides an ONNX-based wrapper assuming the model has been exported.

import * as ort from "onnxruntime-web";
import { OrtInferSession } from "../../inference_engine/onnxruntime/main.js";
import { ModelProcessor } from "../../model_processor/main.js";
import { ModelType } from "../../utils/typings.js";
import { unitablePreprocess } from "./pre_process.js";
import { buildUniTableVocab, decodeUniTableOutput } from "./post_process.js";

/**
 * UniTable table structure recognizer.
 * PORTING NOTE: Original uses PyTorch encoder/decoder (torch.Tensor).
 * This wrapper expects the UniTable model exported to ONNX format.
 * W1: __init__(cfg) → static async create(cfg)
 */
export class UniTableStructure {
  constructor() {
    this.session = null;
    this.vocab = buildUniTableVocab();
  }

  /**
   * @param {object} cfg
   * @returns {Promise<UniTableStructure>}
   */
  static async create(cfg = {}) {
    const inst = new UniTableStructure();
    // PORTING NOTE: UNITABLE model may require multiple ONNX files (encoder + decoder).
    // Here we assume a single combined ONNX export.
    const modelType = cfg.model_type ?? ModelType.UNITABLE;
    const modelBytes = await ModelProcessor.getModelPath(modelType, cfg.model_dir_or_path ?? null);
    const bytes = Array.isArray(modelBytes) ? modelBytes[0] : modelBytes;
    inst.session = await OrtInferSession.create({
      model_dir_or_path: bytes,
      engine_cfg: cfg.engine_cfg ?? {},
    });
    return inst;
  }

  /**
   * Run UniTable structure recognition.
   * @param {cv.Mat[]} oriImgs
   * @returns {Promise<{ structures: string[][], cellBboxes: number[][][] }>}
   */
  async run(oriImgs) {
    const results = [];
    for (const img of oriImgs) {
      const { data, dims } = unitablePreprocess(img);
      const inputName = this.session.getInputNames()[0];
      const inputTensor = new ort.Tensor("float32", data, dims);
      const outputMap = await this.session.run({ [inputName]: inputTensor });
      const outputName = this.session.getOutputNames()[0];
      const decoded = decodeUniTableOutput(outputMap[outputName], this.vocab);
      const innerHtml = (decoded[0] ?? "").replace(/<\/?table>/g, "");
      results.push({ structure: [innerHtml || "<thead></thead><tbody></tbody>"], cellBboxes: [] });
    }
    return {
      structures: results.map(r => r.structure),
      cellBboxes: results.map(r => r.cellBboxes),
    };
  }
}

export default UniTableStructure;
