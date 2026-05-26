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

function normalizeTokenizerPayload(payload) {
  if (!payload) return null;
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
    return JSON.stringify(trimmed);
  }
  return JSON.stringify(payload);
}

function parseMetadataObject(value, label) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    console.warn(`[RapidFormula] Failed to parse "${label}" metadata:`, e.message);
    return null;
  }
}

function getMetadataValue(metaMap, key) {
  return metaMap?.get?.(key) ?? metaMap?.[key];
}

function resolveTokenizerJson(metaMap = {}) {
  // FIX F3: prefer Python metadata path, but keep top-level support for older S assets.
  const characterObj = parseMetadataObject(getMetadataValue(metaMap, "character"), "character");
  const fromCharacter = normalizeTokenizerPayload(characterObj?.fast_tokenizer_file);
  if (fromCharacter) return fromCharacter;

  return normalizeTokenizerPayload(getMetadataValue(metaMap, "fast_tokenizer_file"));
}

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
    const metaMap = session.session?.customMetadataMap ?? {};
    let tokenizerJson = resolveTokenizerJson(metaMap);

    if (!tokenizerJson) {
      // Fallback (asset bundled with app)
      tokenizerJson = await fetchAssetText('/models/formula/formula_vocab.json');
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
