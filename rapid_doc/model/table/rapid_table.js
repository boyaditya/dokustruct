// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table/rapid_table.py → rapid_table.js
// RapidTableModel: complex entry point with wired/wireless model selection + TableCls
// W1: __init__(ocrEngine, tableConfig) → static async create(ocrEngine, tableConfig)

import { RapidTable } from "./rapid_table_self/main.js";
import { TableCls } from "./rapid_table_self/table_cls/main.js";
import { RapidTableInput, ModelType } from "./rapid_table_self/utils/typings.js";
import { LoadImage } from "./rapid_table_self/utils/load_image.js";
import { selectBestTableModel } from "./utils.js";
import { getLogger } from "./rapid_table_self/utils/logger.js";
import { getLatexDelimiterConfig } from "../../utils/config_reader.js";
import { isIn } from "../../utils/boxbase.js";
import { pointsToBbox, bboxToPoints } from "../../utils/ocr_utils.js";

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
 * PORTING NOTE: RapidTableModel(ocr_engine, table_config) → static async create(ocrEngine, tableConfig)
 */
export class RapidTableModel {
  constructor() {
    this._tableCls = null;
    this._wiredModel = null;
    this._wirelessModel = null;
    this._singleModel = null;
    this._ocrEngine = null;
    this._mode = "single"; // "single" or "dual"
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

    // UNET_SLANET_PLUS mode: dual-model (wired + wireless) with TableCls
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
   * @param {boolean} [opts.fillImageRes=true]
   * @param {any} [opts.mfdRes]
   * @param {boolean} [opts.skipTextInImage=false]
   * @param {boolean} [opts.useImg2table=false]
   * @returns {Promise<{ html: string, cellBboxes: number[][], elapse: number }>}
   */
  async predict(image, ocrResult = null, opts = {}) {
    const { fillImageRes = null, mfdRes = null, skipTextInImage = true, useImg2table = false } = opts;
    if (useImg2table && !warnedImg2tableUnsupported) {
      console.warn("[RapidTableModel] useImg2table requested, but img2table is Python-only in the browser; using RapidTable structure model.");
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
          tableMat.delete();
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
        const delimiters = getLatexDelimiterConfig() || { inline: { left: "\\(", right: "\\)" } };
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

      const finalOcrResult = [boxes, texts, scores];

      if (this._mode === "dual") {
        return await this._predictDual(tableImage, finalOcrResult, opts);
      }
      
      const result = await this._singleModel.run([tableImage], [finalOcrResult]);
      return {
        html: (result && result.predHtmls && result.predHtmls[0]) ? result.predHtmls[0] : "",
        cellBboxes: (result && result.cellBboxes && result.cellBboxes[0]) ? result.cellBboxes[0] : [],
        elapse: result ? result.elapse : 0,
      };
    } catch (err) {
      console.error("[RapidTableModel.predict] error:", err);
      throw err;
    } finally {
      if (tableMat && !tableMat.isDeleted()) tableMat.delete();
    }
  }

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
   * @param {HTMLImageElement|ImageBitmap|ImageData|Uint8Array|string} image
   * @param {object|null} ocrResult
   * @param {object} opts
   */
  async _predictDual(image, ocrResult, opts) {
    // Load image for classification
    const loader = new LoadImage();
    let mat = await loader.run(image);
    let tableType = "wired";
    try {
      const [type] = await this._tableCls.run(mat);
      tableType = type;
    } finally {
      mat.delete();
    }

    logger.info(`RapidTableModel: table type classified as '${tableType}'`);

    if (tableType === "wired") {
      const wiredResult = await this._wiredModel.run([image], ocrResult ? [ocrResult] : null);
      if (opts?.useCompareTable) {
        const wirelessResult = await this._wirelessModel.run([image], ocrResult ? [ocrResult] : null);
        const wiredHtml = wiredResult.predHtmls?.[0] ?? "";
        const wirelessHtml = wirelessResult.predHtmls?.[0] ?? "";
        const selected = selectBestTableModel(ocrResult, wiredHtml, wirelessHtml);
        logger.info(`RapidTableModel: compare-table selected '${selected.modelType}'`);
        return {
          html: selected.bestHtml ?? "",
          cellBboxes: selected.modelType === "wireless"
            ? (wirelessResult.cellBboxes?.[0] ?? [])
            : (wiredResult.cellBboxes?.[0] ?? []),
          elapse: Number(wiredResult.elapse || 0) + Number(wirelessResult.elapse || 0),
        };
      }
      return {
        html: wiredResult.predHtmls[0] ?? "",
        cellBboxes: wiredResult.cellBboxes[0] ?? [],
        elapse: wiredResult.elapse,
      };
    }

    const result = await this._wirelessModel.run([image], ocrResult ? [ocrResult] : null);
    return {
      html: result.predHtmls[0] ?? "",
      cellBboxes: result.cellBboxes[0] ?? [],
      elapse: result.elapse,
    };
  }

  /**
   * Batch prediction.
   * @param {Array<HTMLImageElement|ImageBitmap|ImageData|Uint8Array|string>} images
   * @param {object[]} [ocrResults]
   * @returns {Promise<{ htmls: string[], cellBboxes: number[][][], elapse: number }>}
   */
  async batchPredict(images, ocrResults = [], opts = {}) {
    if (!Array.isArray(ocrResults) && ocrResults && typeof ocrResults === "object") {
      opts = { ...ocrResults, ...opts };
      ocrResults = [];
    }

    const requestedConcurrency = opts.maxConcurrency ?? images.length;
    const maxConcurrency = Math.max(1, Math.trunc(Number(requestedConcurrency || images.length)));
    const results = new Array(images.length);
    let next = 0;

    const runWorker = async () => {
      while (next < images.length) {
        const i = next++;
        const perImageOpts = { ...opts };
        if (Array.isArray(opts.fillImageResList)) perImageOpts.fillImageRes = opts.fillImageResList[i] ?? null;
        if (Array.isArray(opts.mfdResList)) perImageOpts.mfdRes = opts.mfdResList[i] ?? null;
        results[i] = await this.predict(images[i], ocrResults[i] ?? null, perImageOpts);
        await new Promise(resolve => setTimeout(resolve, 0));
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
}

export default RapidTableModel;
