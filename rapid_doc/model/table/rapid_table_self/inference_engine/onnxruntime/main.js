// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: rapid_table_self/inference_engine/onnxruntime/main.py → main.js
// Key difference from formula: cfg is a plain dict (not dataclass); getCharacterList uses splitlines().
// Also supports cfg.session = custom pre-built session injection.
// W1: __init__(cfg) → static async create(cfg)

import { InferSession } from "../base.js";
import { ProviderConfig } from "./provider_config.js";
import * as ort from "onnxruntime-web";
import { fetchAssetBuffer } from "../../../../../utils/download_file.js";

/**
 * ONNX Runtime inference session for table models.
 * PORTING NOTE: OrtInferSession takes a plain object cfg with fields:
 *   - cfg.model_dir_or_path: URL/bytes for model
 *   - cfg.session: optional pre-built session to reuse
 *   - cfg.engine_cfg: optional additional ort session options
 */
export class OrtInferSession extends InferSession {
  constructor() {
    super();
    this.session = null;
  }

  /**
   * @param {object} cfg
   * @param {string|Uint8Array|ArrayBuffer|null} [cfg.model_dir_or_path]
   * @param {import('onnxruntime-web').InferenceSession|null} [cfg.session]
   * @param {object} [cfg.engine_cfg]
   * @returns {Promise<OrtInferSession>}
   */
  static async create(cfg) {
    const inst = new OrtInferSession();

    // Support injecting a pre-built session
    if (cfg.session) {
      inst.session = cfg.session;
      return inst;
    }

    const sessionOptions = await ProviderConfig.buildSessionOptions(cfg.engine_cfg ?? {});
    let modelData = cfg.model_dir_or_path;
    if (typeof modelData === "string") {
      modelData = await fetchAssetBuffer(modelData);
    }
    try {
      inst.session = await ort.InferenceSession.create(modelData, sessionOptions);
    } catch (err) {
      const detail = (err instanceof Error) ? err.message : String(err);
      throw new Error(`ONNX session creation failed (table): ${detail}`);
    }
    return inst;
  }

  async run(inputContent) {
    if (!this.session) throw new Error("OrtInferSession: not initialized");
    return await this.session.run(inputContent);
  }

  getInputNames() { return this.session.inputNames; }
  getOutputNames() { return this.session.outputNames; }

  /**
   * Get character list from model metadata.
   * PORTING NOTE: Table model stores char list as newline-separated string (not JSON).
   * @param {string} [key="character"]
   * @returns {string[]}
   */
  getCharacterList(key = "character") {
    const meta = this.session.customMetadataMap ?? {};
    const val = meta[key];
    if (!val) return [];
    // Try JSON first (formula compat), fall back to newline-split
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return val.split("\n").filter(s => s.length > 0);
  }

  haveKey(key) {
    return Object.prototype.hasOwnProperty.call(this.session.customMetadataMap ?? {}, key);
  }
}

export default OrtInferSession;
