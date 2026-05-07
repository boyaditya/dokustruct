// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: inference_engine/onnxruntime/main.py → main.js
// W1: Python synchronous __init__ → static async create()
//     Python __call__ → async run()

import { InferSession } from "../base.js";
import { ProviderConfig } from "./provider_config.js";
import * as ort from "onnxruntime-web";

/**
 * ONNX Runtime inference session wrapper.
 * PORTING NOTE: OrtInferSession(cfg) → static async create(cfg)
 * W1 pattern: all I/O is async; session created in factory method.
 */
export class OrtInferSession extends InferSession {
  constructor() {
    super();
    /** @type {import('onnxruntime-web').InferenceSession|null} */
    this.session = null;
  }

  /**
   * Create and initialize an OrtInferSession.
   * @param {import('../../utils/typings.js').RapidFormulaInput|object} cfg
   * @returns {Promise<OrtInferSession>}
   */
  static async create(cfg) {
    const inst = new OrtInferSession();
    const sessionOptions = await ProviderConfig.buildSessionOptions(cfg.engineCfg ?? {});

    let modelData;
    if (cfg.modelDirOrPath instanceof Uint8Array || cfg.modelDirOrPath instanceof ArrayBuffer) {
      modelData = cfg.modelDirOrPath;
    } else if (typeof cfg.modelDirOrPath === "string") {
      const resp = await fetch(cfg.modelDirOrPath);
      if (!resp.ok) throw new Error(`Failed to load model: ${resp.status} ${resp.statusText}`);
      modelData = await resp.arrayBuffer();
    } else {
      throw new Error("OrtInferSession: modelDirOrPath must be a URL string or ArrayBuffer/Uint8Array");
    }

    try {
      inst.session = await ort.InferenceSession.create(modelData, sessionOptions);
    } catch (err) {
      const detail = (err instanceof Error) ? err.message : String(err);
      throw new Error(`ONNX session creation failed (formula): ${detail}`);
    }
    return inst;
  }

  /**
   * Run inference.
   * @param {Object<string, import('onnxruntime-web').Tensor>} inputContent
   * @returns {Promise<Object<string, import('onnxruntime-web').Tensor>>}
   */
  async run(inputContent) {
    if (!this.session) throw new Error("OrtInferSession: session not initialized");
    return await this.session.run(inputContent);
  }

  /**
   * Get all input tensor names.
   * @returns {readonly string[]}
   */
  getInputNames() {
    return this.session.inputNames;
  }

  /**
   * Get all output tensor names.
   * @returns {readonly string[]}
   */
  getOutputNames() {
    return this.session.outputNames;
  }

  /**
   * Get character list from model metadata.
   * PORTING NOTE: Python reads meta_dict[key] as JSON string → JSON.parse.
   * @param {string} [key="character"]
   * @returns {string[]}
   */
  getCharacterList(key = "character") {
    const meta = this.session.customMetadataMap ?? {};
    const val = meta[key];
    if (!val) return [];
    try {
      return JSON.parse(val);
    } catch {
      return val.split("\n").filter(s => s.length > 0);
    }
  }

  /**
   * Check if a metadata key exists.
   * @param {string} key
   * @returns {boolean}
   */
  haveKey(key) {
    const meta = this.session.customMetadataMap ?? {};
    return Object.prototype.hasOwnProperty.call(meta, key);
  }
}

export default OrtInferSession;
