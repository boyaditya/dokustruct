// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: rapid_formula_self/main.py → main.js
// W1: sync __init__ → static async create(); __call__ → async run()

import { RapidFormulaInput, RapidFormulaOutput, ModelType, EngineType } from "./utils/typings.js";
import { OrtInferSession } from "./inference_engine/onnxruntime/main.js";
import { ModelHandler } from "./model_handler/main.js";
import { ModelProcessor } from "./model_handler/utils.js";
import { LoadImage } from "./utils/load_image.js";
import { Logger } from "./utils/logger.js";

const logger = new Logger("RapidFormula").getLog();

/**
 * Main formula recognition class.
 * PORTING NOTE: RapidFormula(cfg) → static async create(cfg)
 *               RapidFormula.__call__(imgContents, batchSize) → async run(imgContents, batchSize)
 */
export class RapidFormula {
  constructor() {
    this._session = null;
    this._modelHandler = null;
    this._loadImage = new LoadImage();
  }

  /**
   * Create and initialize a RapidFormula instance.
   * @param {RapidFormulaInput|object|null} cfg
   * @returns {Promise<RapidFormula>}
   */
  static async create(cfg = null) {
    const inst = new RapidFormula();
    const config = cfg instanceof RapidFormulaInput ? cfg : new RapidFormulaInput(cfg ?? {});

    // Download / get model bytes
    const modelBytes = await ModelProcessor.getModelPath(
      config.modelType,
      config.modelDirOrPath
    );

    // Build session config
    const sessionCfg = {
      modelDirOrPath: modelBytes,
      engineCfg: config.engineCfg ?? {},
    };

    // Create inference session
    if (config.engineType === EngineType.TORCH) {
      throw new Error("RapidFormula: 'torch' engine is not supported in browser");
    }
    inst._session = await OrtInferSession.create(sessionCfg);
    inst._modelHandler = new ModelHandler(config, inst._session);

    logger.info(`RapidFormula initialized with model type: ${config.modelType}`);
    return inst;
  }

  /**
   * Recognize formulas in a list of images.
   * @param {Array<HTMLImageElement|ImageBitmap|ImageData|Uint8Array|string>} imgContents
   * @param {number} [batchSize=1]
   * @returns {Promise<{ recFormulas: string[], elapse: number }>}
   */
  async run(imgContents, batchSize = 1) {
    console.log(`[RapidFormula] run started for ${imgContents.length} images, batchSize=${batchSize}`);
    const t0 = performance.now();
    const allFormulas = [];

    // SEQUENTIAL PIPELINE: FormulaNet is a large Transformer with static shapes (384x384).
    // ORT WebGPU reuses internal GPU buffers for static shapes, so overlapping pipelines
    // cause race conditions that hang the GPU device queue. Process strictly one-at-a-time.
    for (let i = 0; i < imgContents.length; i += batchSize) {
      const batch = imgContents.slice(i, i + batchSize);
      console.log(`[RapidFormula] Processing formula ${i+1}/${imgContents.length}...`);
      
      // Load each image into cv.Mat
      const mats = await Promise.all(batch.map(img => this._loadImage.run(img)));
      try {
        const outputs = await this._modelHandler.run(mats);
        console.log(`[RapidFormula] Formula ${i+1} done (${((performance.now()-t0)/1000).toFixed(1)}s elapsed)`);
        for (const out of outputs) {
          allFormulas.push(out.recFormula);
        }
      } finally {
        for (const mat of mats) {
          if (mat && !mat.isDeleted()) mat.delete();
        }
      }
    }

    const elapse = (performance.now() - t0) / 1000;
    console.log(`[RapidFormula] run finished, ${allFormulas.length} formulas in ${elapse.toFixed(1)}s`);
    return { recFormulas: allFormulas, elapse };
  }
}

export default RapidFormula;
