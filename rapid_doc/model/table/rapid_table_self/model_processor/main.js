// Copyright (c) Opendatalab. All rights reserved.

import { DownloadFile, DownloadFileInput } from "../utils/download_file.js";
import { ModelType, normalizeTableModelType } from "../utils/typings.js";

// Models are served locally from public/models/ (Vite static assets).
// Run `python scripts/copy-models-to-public.py` to populate public/models/.
// SHA-256 disabled (null) to avoid cache mismatch issues during development
const MODEL_URLS = {
  [ModelType.SLANETPLUS]: {
    modelUrl: '/models/table/slanet-plus.onnx?v=ort-shape-fix-1',
    sha256: null, // Disabled for development
  },
  [ModelType.UNET]: {
    modelUrl: '/models/table/unet.onnx',
    sha256: null, // Disabled for development
  },
  [ModelType.UNITABLE]: {
    // UNITABLE needs multiple files: encoder + decoder + vocab
    modelUrls: [
      '/models/table/unitable/encoder.pth',
      '/models/table/unitable/decoder.pth',
      '/models/table/unitable/vocab.json',
    ],
    sha256: null,
  },
  [ModelType.PADDLE_CLS]: {
    modelUrl: '/models/table/table_cls/paddle_cls.onnx',
    sha256: null, // Disabled for development
  },
  [ModelType.Q_CLS]: {
    modelUrl: '/models/table/table_cls/q_cls.onnx',
    sha256: null, // Disabled for development
  },
  [ModelType.PPSTRUCTURE_CH]: {
    modelUrl: '/models/table/ch_ppstructure_mobile_v2_SLANet.onnx',
    sha256: null, // Disabled for development
  },
  [ModelType.PPSTRUCTURE_EN]: {
    modelUrl: '/models/table/en_ppstructure_mobile_v2_SLANet.onnx',
    sha256: null, // Disabled for development
  },
};

/**
 * Model downloader and path resolver for table models.
 * Returns Uint8Array for single-file models, or Uint8Array[] for multi-file models.
 */
export class ModelProcessor {
  /**
   * Get model bytes. Returns Uint8Array for single-file models,
   * or Uint8Array[] for multi-file models (like UNITABLE).
   *
   * @param {string} modelType
   * @param {string|Uint8Array|null} [modelDirOrPath]
   * @param {(progress: number) => void} [onProgress]
   * @returns {Promise<Uint8Array|Uint8Array[]>}
   */
  static async getModelPath(modelType, modelDirOrPath = null, onProgress = null) {
    if (modelDirOrPath instanceof Uint8Array || modelDirOrPath instanceof ArrayBuffer) {
      return modelDirOrPath instanceof ArrayBuffer ? new Uint8Array(modelDirOrPath) : modelDirOrPath;
    }

    const normalizedModelType = normalizeTableModelType(modelType);
    const modelDef = MODEL_URLS[normalizedModelType];
    if (!modelDef) throw new Error(`ModelProcessor: no URL config for model type '${modelType}'`);

    // Multi-file model (e.g., UNITABLE)
    if (modelDef.modelUrls) {
      const urls = modelDirOrPath ? JSON.parse(modelDirOrPath) : modelDef.modelUrls;
      return Promise.all(urls.map(url =>
        DownloadFile.run(new DownloadFileInput({ url }), onProgress)
      ));
    }

    // Single file model
    const candidates = modelDirOrPath ? [modelDirOrPath] : [modelDef.modelUrl, ...(modelDef.fallbackUrls ?? [])];
    let lastErr = null;
    for (const url of candidates) {
      try {
        return await DownloadFile.run(new DownloadFileInput({ url, sha256: modelDef.sha256 }), onProgress);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`ModelProcessor: failed to load model type '${modelType}'`);
  }
}

export default ModelProcessor;
