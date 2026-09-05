// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: model_handler/utils.py → utils.js
// ModelProcessor downloads model files from URLs using DownloadFile (W4 pattern)

import { DownloadFile, DownloadFileInput } from "../utils/download_file.js";
import { ModelType } from "../utils/typings.js";
import { HF_ASSET_BASE } from "../../../../utils/model_url_map.js";

function hfFormula(path) {
  return `${HF_ASSET_BASE}/${String(path).replace(/^\/?(models\/)?/, '')}`;
}

const MODEL_URLS = {
  [ModelType.PP_FORMULANET_PLUS_S]: {
    modelUrl: hfFormula('formula/PP-FormulaNet_plus-S/pp_formulanet_plus_s.onnx'),
    sha256: '30998d10c94ccff1ad8981df0c71048cb1f3eec7b1e515b809767f1f72aebe3b',
  },
  [ModelType.PP_FORMULANET_PLUS_M]: {
    modelUrl: hfFormula('formula/PP-FormulaNet_plus-M/pp_formulanet_plus_m.onnx'),
    sha256: '71b6d389cf7b857e45252a4b98cfced1a3ffca7bf24d9497d02d052a41d9493b',
  },
  [ModelType.PP_FORMULANET_PLUS_L]: {
    modelUrl: hfFormula('formula/PP-FormulaNet_plus-L/pp_formulanet_plus_l.onnx'),
    sha256: '5ef81a0b197ea2c8c1463b31c3eb2ad0ae1eb655fb1ff3b550858c7d85bc84e8',
  },
};

/**
 * Model downloader and path resolver.
 * PORTING NOTE: ModelProcessor.get_model_path → downloads model bytes via fetch
 */
export class ModelProcessor {
  /**
   * Get model bytes for given model type.
   * If modelDirOrPath is already Uint8Array/ArrayBuffer, returns it directly.
   * If it is a URL string or null (use default), fetches from network with IndexedDB cache.
   *
   * @param {string} modelType - One of ModelType values
   * @param {string|Uint8Array|null} modelDirOrPath - Override path/URL or null for default
   * @param {(progress: number) => void} [onProgress]
   * @returns {Promise<Uint8Array>}
   */
  static async getModelPath(modelType, modelDirOrPath = null, onProgress = null) {
    if (modelDirOrPath instanceof Uint8Array || modelDirOrPath instanceof ArrayBuffer) {
      return modelDirOrPath instanceof ArrayBuffer ? new Uint8Array(modelDirOrPath) : modelDirOrPath;
    }

    const url = modelDirOrPath ?? MODEL_URLS[modelType]?.modelUrl;
    if (!url) throw new Error(`ModelProcessor: no URL for model type '${modelType}'`);

    const sha256 = MODEL_URLS[modelType]?.sha256 ?? null;
    const input = new DownloadFileInput({ url, sha256 });
    return DownloadFile.run(input, onProgress);
  }
}

export default ModelProcessor;
