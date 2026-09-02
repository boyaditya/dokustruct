// Copyright (c) Opendatalab. All rights reserved.

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
 * Download a model file from URL. Returns Uint8Array (browser-only, no filesystem).
 */
export class DownloadModel {
  /**
   * @param {string} url
   * @param {string} [saveDir] - Ignored in browser
   * @param {string} [saveName] - Used as cache key suffix
   * @returns {Promise<Uint8Array>}
   */
  static async download(url, _saveDir = null, saveName = null) {
    try {
      const cacheUrl = saveName ? `${url}#${saveName}` : url;
      return await DownloadFile.run(new DownloadFileInput({ url: cacheUrl }));
    } catch (e) {
      throw new DownloadModelError(`Failed to download model from ${url}: ${e.message}`);
    }
  }
}
