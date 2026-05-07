// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: rapid_table_self/table_cls/utils/download_model.py → download_model.js
// DownloadModel.download(url, saveDir, saveName) → W4 fetch + IndexedDB

import { DownloadFile, DownloadFileInput } from "../../utils/download_file.js";

/**
 * Error class for model download failures.
 */
export class DownloadModelError extends Error {
  constructor(message) {
    super(message);
    this.name = "DownloadModelError";
  }
}

/**
 * Download a model file from URL.
 * PORTING NOTE: DownloadModel.download(url, save_dir, save_name) → returns Uint8Array
 */
export class DownloadModel {
  /**
   * @param {string} url
   * @param {string} [saveDir] - Ignored in browser (no filesystem)
   * @param {string} [saveName] - Used as cache key suffix
   * @returns {Promise<Uint8Array>}
   */
  static async download(url, saveDir = null, saveName = null) {
    try {
      const cacheUrl = saveName ? `${url}#${saveName}` : url;
      return await DownloadFile.run(new DownloadFileInput({ url: cacheUrl }));
    } catch (e) {
      throw new DownloadModelError(`Failed to download model from ${url}: ${e.message}`);
    }
  }
}
