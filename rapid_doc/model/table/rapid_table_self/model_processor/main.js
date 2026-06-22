// Copyright (c) Opendatalab. All rights reserved.

import { DownloadFile, DownloadFileInput } from "../utils/download_file.js";
import { ModelType, normalizeTableModelType } from "../utils/typings.js";

// Models are served locally from public/models/ (Vite static assets).
// Run `python scripts/copy-models-to-public.py` to populate public/models/.
// SHA-256 hashes computed from local public/models/ files (Audit 1.2: FIX — fill sha256 fields).
//
// FIX T5: UNITABLE is intentionally excluded from production MODEL_URLS.
// UniTable requires a two-stage autoregressive ONNX encoder+decoder with kv-cache
// that is not yet implemented in JS. The UniTableStructure class throws a clear error
// on construction. See documentation/KNOWN_ISSUES.md (T5/T23) for full context.
const MODEL_URLS = {
  [ModelType.SLANETPLUS]: {
    modelUrl: '/models/table/slanet-plus.onnx?v=ort-shape-fix-1',
    sha256: 'f9ce699522678406dbab901f4f663346dd8f04f7c752dd3c1bb70554871e49b7',
  },
  [ModelType.UNET]: {
    modelUrl: '/models/table/unet.onnx',
    sha256: '0ea48d3a17e35ef5c2e498a5e799566073234d39b1079ca21d9f4fafe73c6d20',
  },
  // [ModelType.UNITABLE] is intentionally omitted — see FIX T5 comment above.
  [ModelType.PADDLE_CLS]: {
    modelUrl: '/models/table/table_cls/paddle_cls.onnx',
    sha256: '21c801f0c403cf960f9f1ccaecf506585b3b98421208033755b9e67cd2371492',
  },
  [ModelType.Q_CLS]: {
    modelUrl: '/models/table/table_cls/q_cls.onnx',
    sha256: 'ef940037471c49f5d35ba2b1d9df9a19eabddf03f1689026d2a5bcab5efe577b',
  },
  [ModelType.PPSTRUCTURE_CH]: {
    modelUrl: '/models/table/ch_ppstructure_mobile_v2_SLANet.onnx',
    sha256: 'ddfc6c97ee4db2a5e9de4de8b6a14508a39d42d228503219fdfebfac364885e3',
  },
  [ModelType.PPSTRUCTURE_EN]: {
    modelUrl: '/models/table/en_ppstructure_mobile_v2_SLANet.onnx',
    sha256: '2cae17d16a16f9df7229e21665fe3fbe06f3ca85b2024772ee3e3142e955aa60',
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
