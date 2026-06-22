// Copyright (c) Opendatalab. All rights reserved.

import { RapidTable } from "./rapid_table_self/main.js";
import { TableCls } from "./rapid_table_self/table_cls/main.js";
import { RapidTableInput, ModelType } from "./rapid_table_self/utils/typings.js";
import { LoadImage } from "./rapid_table_self/utils/load_image.js";
import { selectBestTableModel } from "./utils.js";
import { getLogger } from "./rapid_table_self/utils/logger.js";
import { getLatexDelimiterConfig } from "../../utils/config_reader.js";
import { isIn } from "../../utils/boxbase.js";
import { pointsToBbox, bboxToPoints } from "../../utils/ocr_utils.js";
import { deleteMat } from "../../utils/resource_utils.js";
import { formatPipelineError, yieldToBrowser } from "../../utils/browser_utils.js";
import { AbortException } from "../../utils/exceptions.js";

const logger = getLogger("RapidTableModel");
let warnedImg2tableUnsupported = false;

function getConfigValue(config, key, fallback = null) {
  if (!config || typeof config !== "object") return fallback;
  return Object.prototype.hasOwnProperty.call(config, key) ? config[key] : fallback;
}

function getInputSize(image) {
  if (isCvMat(image)) {
    return { width: image.cols, height: image.rows };
  }
  if (typeof ImageData !== "undefined" && image instanceof ImageData) {
    return { width: image.width, height: image.height };
  }
  if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
    return { width: image.width, height: image.height };
  }
  if (typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement) {
    return { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
  }
  return null;
}

function isCvMat(value) {
  return typeof cv !== "undefined" && value instanceof cv.Mat;
}

function toOcrResult(rawOcrResult) {
  const rows = rawOcrResult?.[0];
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const boxes = [];
  const texts = [];
  const scores = [];
  for (const item of rows) {
    if (!item || !Array.isArray(item)) continue;
    const box = item[0];
    const rec = item[1];
    if (!box || !Array.isArray(rec)) continue;
    boxes.push(box);
    texts.push(rec[0] ?? "");
    scores.push(rec[1] ?? 1);
  }
  return boxes.length ? [boxes, texts, scores] : null;
}

function whiteFillImageRegions(mat, fillImageRes) {
  if (!Array.isArray(fillImageRes) || fillImageRes.length === 0) return;
  for (const fillImage of fillImageRes) {
    if (!fillImage || !fillImage.ocr_bbox) continue;
    const [x0, y0, x1, y1] = pointsToBbox(fillImage.ocr_bbox);
    const left = Math.max(0, Math.min(mat.cols - 1, Math.floor(x0)));
    const top = Math.max(0, Math.min(mat.rows - 1, Math.floor(y0)));
    const right = Math.max(0, Math.min(mat.cols, Math.ceil(x1)));
    const bottom = Math.max(0, Math.min(mat.rows, Math.ceil(y1)));
    if (right <= left || bottom <= top) continue;
    cv.rectangle(
      mat,
      new cv.Point(left, top),
      new cv.Point(right, bottom),
      new cv.Scalar(255, 255, 255, 255),
      -1
    );
  }
}

/**
 * Top-level table recognition model with automatic wired/wireless classification.
 */
export class RapidTableModel {
  constructor() {
    this._tableCls = null;
    this._wiredModel = null;
    this._wirelessModel = null;
    this._singleModel = null;
    this._ocrEngine = null;
    this._mode = "single";
  }

  /**
   * Create and initialize RapidTableModel.
   * @param {object|null} [ocrEngine] - OCR engine for OCR-enabled inference
   * @param {RapidTableInput|object|null} [tableConfig]
   * @returns {Promise<RapidTableModel>}
   */
  static async create(ocrEngine = null, tableConfig = null) {
    const inst = new RapidTableModel();
    inst._ocrEngine = ocrEngine;
    const rawConfig = tableConfig && typeof tableConfig === "object" ? tableConfig : {};

    const config = tableConfig instanceof RapidTableInput
      ? tableConfig
      : new RapidTableInput(tableConfig ?? {});

    const modelType = config.modelType ?? ModelType.UNET_SLANET_PLUS;

    if (modelType === ModelType.UNET_SLANET_PLUS) {
      inst._mode = "dual";
      const wiredModelPath = getConfigValue(rawConfig, "unet.model_dir_or_path", config.modelDirOrPath ?? null);
      const wirelessModelPath = getConfigValue(rawConfig, "slanet_plus.model_dir_or_path", config.modelDirOrPath ?? null);
      inst._tableCls = await TableCls.create({
        model_type: getConfigValue(rawConfig, "cls.model_type", ModelType.PADDLE_Q_CLS),
        model_dir_or_path: getConfigValue(rawConfig, "cls.model_dir_or_path", null),
        engine_type: config.engineType,
        engine_cfg: config.engineCfg,
      });
      inst._wiredModel = await RapidTable.create(
        new RapidTableInput({
          ...config,
          modelType: ModelType.UNET,
          modelDirOrPath: wiredModelPath,
          model_dir_or_path: wiredModelPath,
        })
      );
      inst._wirelessModel = await RapidTable.create(
        new RapidTableInput({
          ...config,
          modelType: ModelType.SLANETPLUS,
          modelDirOrPath: wirelessModelPath,
          model_dir_or_path: wirelessModelPath,
        })
      );
    } else {
      inst._mode = "single";
      inst._singleModel = await RapidTable.create(config);
    }

    logger.info(`RapidTableModel: initialized in '${inst._mode}' mode`);
    return inst;
  }

  /**
   * Predict table structure for a single image.
   * @param {HTMLImageElement|ImageBitmap|ImageData|Uint8Array|string} image
   * @param {object|null} [ocrResult]
   * @param {object} [opts]
   * @returns {Promise<{ html: string, cellBboxes: number[][], elapse: number }>}
   */
  async predict(image, ocrResult = null, opts = {}) {
    const { fillImageRes = null, mfdRes = null, skipTextInImage = true, useImg2table = false } = opts;
    if (useImg2table && !warnedImg2tableUnsupported) {
      logger.warn("useImg2table requested, but img2table is Python-only in the browser; using RapidTable structure model.");
      warnedImg2tableUnsupported = true;
    }

    const hasFillImages = Array.isArray(fillImageRes) && fillImageRes.length > 0;
    const inputSize = getInputSize(image);
    const mayNeedPortraitCheck = !!this._ocrEngine &&
      (!inputSize || (inputSize.width > 0 && inputSize.height / inputSize.width > 1.2));
    const needsOcrFallback = !ocrResult || !Array.isArray(ocrResult) || ocrResult.length < 3;
    const needsTableMat = hasFillImages || mayNeedPortraitCheck || (needsOcrFallback && !!this._ocrEngine);

    let tableImage = image;
    let tableMat = null;

    try {
      if (needsTableMat) {
        const loader = new LoadImage();
        tableMat = await loader.run(image);
        tableImage = tableMat;

        const rotatedMat = await this._maybeRotatePortraitTable(tableMat);
        if (rotatedMat !== tableMat) {
          deleteMat(tableMat);
          tableMat = rotatedMat;
          tableImage = tableMat;
          if (this._ocrEngine) ocrResult = null;
        }
      }

      if (!ocrResult || !Array.isArray(ocrResult) || ocrResult.length < 3) {
        if (this._ocrEngine && isCvMat(tableImage)) {
          ocrResult = toOcrResult(await this._ocrEngine.ocr(tableImage, { mfdRes }));
        }
        if (!fillImageRes && !mfdRes) {
          if (!ocrResult) return { html: "", cellBboxes: [], elapse: 0 };
        }
        if (!ocrResult) ocrResult = [[], [], []];
      }

      const finalOcrResult = this._buildFinalOcrResult(ocrResult, fillImageRes, mfdRes, tableImage, skipTextInImage);

      if (this._mode === "dual") {
        return await this._predictDual(tableImage, finalOcrResult, opts);
      }

      const result = await this._singleModel.run([tableImage], [finalOcrResult]);
      return {
        html: result?.predHtmls?.[0] ?? "",
        cellBboxes: result?.cellBboxes?.[0] ?? [],
        elapse: result?.elapse ?? 0,
      };
    } catch (err) {
      if (err instanceof AbortException) throw err;
      console.warn(formatPipelineError({
        stage: 'table',
        module: 'RapidTableModel',
        message: `predict failed: ${err?.message ?? err}`,
        recoverable: true,
      }));
      throw err;
    } finally {
      deleteMat(tableMat);
    }
  }

  /**
   * Build the final OCR result by merging fill images and formula detections.
   * @private
   */
  _buildFinalOcrResult(ocrResult, fillImageRes, mfdRes, tableImage, skipTextInImage) {
    const boxes = Array.isArray(ocrResult[0]) ? [...ocrResult[0]] : [];
    const texts = Array.isArray(ocrResult[1]) ? [...ocrResult[1]] : [];
    const scores = Array.isArray(ocrResult[2]) ? [...ocrResult[2]] : [];

    if (Array.isArray(fillImageRes)) {
      if (isCvMat(tableImage)) {
        whiteFillImageRegions(tableImage, fillImageRes);
      }
      for (const fillImage of fillImageRes) {
        if (!fillImage || !fillImage.ocr_bbox) continue;
        boxes.push(fillImage.ocr_bbox);
        texts.push(fillImage.uuid || "");
        scores.push(1);

        if (skipTextInImage) {
          const fillBbox = pointsToBbox(fillImage.ocr_bbox);
          const deleteIndices = [];
          for (let i = 0; i < boxes.length - 1; i++) {
            const box = boxes[i];
            if (Array.isArray(box) && box.length >= 2) {
              if (isIn(pointsToBbox(box), fillBbox)) {
                deleteIndices.push(i);
              }
            }
          }
          for (let i = deleteIndices.length - 1; i >= 0; i--) {
            const idx = deleteIndices[i];
            boxes.splice(idx, 1);
            texts.splice(idx, 1);
            scores.splice(idx, 1);
          }
        }
      }
    }

    if (Array.isArray(mfdRes)) {
      // Default to `$`/`$` to match the Python baseline (mkcontent
      // default_delimiters) and the JS mkcontent inline default. The previous
      // `\(`/`\)` fallback diverged from Python and from non-table inline math.
      const delimiters = getLatexDelimiterConfig() || { inline: { left: "$", right: "$" } };
      const inlineLeftDelimiter = delimiters.inline.left;
      const inlineRightDelimiter = delimiters.inline.right;

      for (const mfd of mfdRes) {
        if (!mfd) continue;
        if (mfd.latex) {
          texts.push(`${inlineLeftDelimiter}${mfd.latex}${inlineRightDelimiter}`);
        } else if (mfd.checkbox) {
          texts.push(mfd.checkbox);
        } else {
          continue;
        }
        boxes.push(bboxToPoints(mfd.bbox));
        scores.push(1);
      }
    }

    return [boxes, texts, scores];
  }

  /** @private */
  async _maybeRotatePortraitTable(mat) {
    if (!this._ocrEngine || !mat || mat.cols <= 0 || mat.rows / mat.cols <= 1.2) {
      return mat;
    }

    const detResult = await this._ocrEngine.ocr(mat, { det: true, rec: false });
    const detBoxes = detResult?.[0];
    if (!Array.isArray(detBoxes) || detBoxes.length === 0) return mat;

    let verticalCount = 0;
    for (const box of detBoxes) {
      if (!Array.isArray(box) || box.length < 3) continue;
      const width = box[2][0] - box[0][0];
      const height = box[2][1] - box[0][1];
      const aspectRatio = height > 0 ? width / height : 1.0;
      if (aspectRatio < 0.8) verticalCount++;
    }
    if (verticalCount < detBoxes.length * 0.3) return mat;

    const rotated = new cv.Mat();
    cv.rotate(mat, rotated, cv.ROTATE_90_CLOCKWISE);
    return rotated;
  }

  /**
   * Dual-model prediction with TableCls for wired/wireless selection.
   * @private
   */
  async _predictDual(image, ocrResult, opts) {
    const loader = new LoadImage();
    let mat = null;
    try {
      mat = await loader.run(image);
      const [tableType] = await this._tableCls.run(mat);

      logger.info(`table type classified as '${tableType}'`);

      if (tableType === "wired") {
        return await this._predictWired(image, ocrResult, opts);
      }

      const result = await this._wirelessModel.run([image], ocrResult ? [ocrResult] : null);
      return {
        html: result.predHtmls[0] ?? "",
        cellBboxes: result.cellBboxes[0] ?? [],
        elapse: result.elapse,
      };
    } finally {
      deleteMat(mat);
    }
  }

  /**
   * Wired model prediction with optional compare-table fallback.
   * When the wired model produces no HTML (e.g. image-only table where UNet
   * finds no line segments), automatically falls back to the wireless model
   * so the table is still recognised rather than silently dropped.
   * @private
   */
  async _predictWired(image, ocrResult, opts) {
    const wiredResult = await this._wiredModel.run([image], ocrResult ? [ocrResult] : null);
    const wiredHtml = wiredResult.predHtmls?.[0] ?? "";

    if (opts?.useCompareTable) {
      const wirelessResult = await this._wirelessModel.run([image], ocrResult ? [ocrResult] : null);
      const wirelessHtml = wirelessResult.predHtmls?.[0] ?? "";
      const selected = selectBestTableModel(ocrResult, wiredHtml, wirelessHtml);
      logger.info(`compare-table selected '${selected.modelType}'`);
      return {
        html: selected.bestHtml ?? "",
        cellBboxes: selected.modelType === "wireless"
          ? (wirelessResult.cellBboxes?.[0] ?? [])
          : (wiredResult.cellBboxes?.[0] ?? []),
        elapse: Number(wiredResult.elapse || 0) + Number(wirelessResult.elapse || 0),
      };
    }

    // Wired model returned no HTML (UNet found no line segments — common for
    // image-only or low-contrast tables). Fall back to wireless model so the
    // table is still processed instead of producing an empty result.
    if (!wiredHtml && this._wirelessModel) {
      logger.info("wired model produced no HTML — falling back to wireless model");
      const wirelessResult = await this._wirelessModel.run([image], ocrResult ? [ocrResult] : null);
      return {
        html: wirelessResult.predHtmls?.[0] ?? "",
        cellBboxes: wirelessResult.cellBboxes?.[0] ?? [],
        elapse: Number(wiredResult.elapse || 0) + Number(wirelessResult.elapse || 0),
      };
    }

    return {
      html: wiredHtml,
      cellBboxes: wiredResult.cellBboxes[0] ?? [],
      elapse: wiredResult.elapse,
    };
  }

  /**
   * Batch prediction with element-level error handling.
   * Failed individual tables are skipped with a warning; pipeline continues.
   * @param {Array<HTMLImageElement|ImageBitmap|ImageData|Uint8Array|string>} images
   * @param {object[]} [ocrResults]
   * @param {object} [opts]
   * @returns {Promise<{ htmls: string[], cellBboxes: number[][][], elapse: number }>}
   */
  async batchPredict(images, ocrResults = [], opts = {}) {
    if (!Array.isArray(ocrResults) && ocrResults && typeof ocrResults === "object") {
      opts = { ...ocrResults, ...opts };
      ocrResults = [];
    }

    // WASM: ORT session.run is not thread-safe for concurrent calls on the
    // same session. The table model's ProviderConfig forces WASM, so default
    // to serial execution. Callers that know they are safe can opt in via
    // opts.maxConcurrency.
    const requestedConcurrency = opts.maxConcurrency ?? 1;
    const maxConcurrency = Math.max(1, Math.trunc(Number(requestedConcurrency)));
    const results = new Array(images.length);
    let next = 0;

    const runWorker = async () => {
      while (next < images.length) {
        const i = next++;
        const perImageOpts = { ...opts };
        if (Array.isArray(opts.fillImageResList)) perImageOpts.fillImageRes = opts.fillImageResList[i] ?? null;
        if (Array.isArray(opts.mfdResList)) perImageOpts.mfdRes = opts.mfdResList[i] ?? null;

        try {
          results[i] = await this.predict(images[i], ocrResults[i] ?? null, perImageOpts);
        } catch (err) {
          if (err instanceof AbortException) throw err;
          console.warn(formatPipelineError({
            stage: 'table',
            module: 'RapidTableModel',
            message: `batchPredict failed for element ${i}: ${err?.message ?? err}`,
            pageIndex: i,
            recoverable: true,
          }));
          results[i] = { html: "", cellBboxes: [], elapse: 0 };
        }

        // Yield between table predictions without being throttled in
        // background tabs (MessageChannel-based; setTimeout(0) would be clamped
        // to ~1s when the tab is hidden, stalling the benchmark).
        await yieldToBrowser();
      }
    };

    const workers = Array.from(
      { length: Math.min(maxConcurrency, images.length) },
      () => runWorker()
    );
    await Promise.all(workers);

    return {
      htmls: results.map(r => r.html),
      cellBboxes: results.map(r => r.cellBboxes),
      elapse: results.reduce((sum, r) => sum + r.elapse, 0),
    };
  }

  /**
   * Dispose all model resources.
   */
  async dispose() {
    const models = [this._singleModel, this._wiredModel, this._wirelessModel, this._tableCls];
    for (const model of models) {
      if (!model) continue;
      try {
        if (typeof model.dispose === 'function') {
          await model.dispose();
        }
      } catch (err) {
        console.warn(formatPipelineError({
          stage: 'dispose',
          module: 'RapidTableModel',
          message: `Failed to dispose table sub-model: ${err?.message ?? err}`,
          recoverable: true,
        }));
      }
    }
    this._singleModel = null;
    this._wiredModel = null;
    this._wirelessModel = null;
    this._tableCls = null;
    this._ocrEngine = null;
  }
}
