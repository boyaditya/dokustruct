// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: model_handler/main.py → main.js
// ModelHandler dispatches to the correct sub-handler based on model_type.

import { ModelType } from "../utils/typings.js";
import { PPFormulaNetPlusModelHandler } from "./pp_formulanet_plus/main.js";
import { fetchAssetText } from "../../../../utils/download_file.js";

// Target sizes per model variant
const TARGET_SIZE_MAP = {
  [ModelType.PP_FORMULANET_PLUS_L]: [768, 768],
  [ModelType.PP_FORMULANET_PLUS_M]: [384, 384],
  [ModelType.PP_FORMULANET_PLUS_S]: [384, 384],
};
let warnedMissingFastTokenizer = false;

/**
 * Factory that creates the correct model handler given config + session.
 * PORTING NOTE: ModelHandler(cfg, session).__call__ → ModelHandler.create(cfg, session).run()
 */
export class ModelHandler {
  /**
   * @param {import('../utils/typings.js').RapidFormulaInput} cfg
   * @param {import('../inference_engine/onnxruntime/main.js').OrtInferSession} session
   */
  constructor(cfg, session) {
    this.cfg = cfg;
    this.session = session;
    const targetSize = TARGET_SIZE_MAP[cfg.modelType] ?? [384, 384];

    // Create sub-handler asynchronously (need to fetch tokenizer if missing)
    this._initPromise = this._initialize(cfg, session, targetSize);
  }

  async _initialize(cfg, session, targetSize) {
    let tokenizerJson = "{}";
    const metaMap = session.session?.customMetadataMap ?? {};

    if (session.haveKey && session.haveKey("fast_tokenizer_file")) {
      tokenizerJson = metaMap["fast_tokenizer_file"];
    } else {
      if (!warnedMissingFastTokenizer) {
        console.warn('[RapidFormula] "fast_tokenizer_file" not found in model metadata; using fallback vocab.');
        warnedMissingFastTokenizer = true;
      }
      try {
        const vocabUrl = '/models/formula/formula_vocab.json';
        tokenizerJson = await fetchAssetText(vocabUrl);
        if (!tokenizerJson.trim()) throw new Error('empty tokenizer file');
      } catch (err) {
        console.error('[RapidFormula] Failed to load fallback tokenizer:', err.message);
      }
    }

    const modelTypeLower = (cfg.modelType ?? "").toLowerCase();
    if (modelTypeLower.includes("pp_formulanet_plus")) {
      this._handler = new PPFormulaNetPlusModelHandler(cfg, session, targetSize, tokenizerJson);
    } else {
      throw new Error(`ModelHandler: unsupported model type '${cfg.modelType}'`);
    }
  }

  /**
   * Run inference on a batch of images.
   * @param {cv.Mat[]} oriImgList
   * @returns {Promise<import('../utils/typings.js').RapidFormulaOutput[]>}
   */
  async run(oriImgList) {
    await this._initPromise;
    return this._handler.run(oriImgList);
  }
}

export default ModelHandler;
