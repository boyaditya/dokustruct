// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table/rapid_table.py → rapid_table.js
// RapidTableModel: complex entry point with wired/wireless model selection + TableCls
// W1: __init__(ocrEngine, tableConfig) → static async create(ocrEngine, tableConfig)

import { RapidTable } from "./rapid_table_self/main.js";
import { TableCls } from "./rapid_table_self/table_cls/main.js";
import { RapidTableInput, ModelType } from "./rapid_table_self/utils/typings.js";
import { selectBestTableModel } from "./utils.js";
import { getLogger } from "./rapid_table_self/utils/logger.js";
import { getLatexDelimiterConfig } from "../../utils/config_reader.js";
import { isIn } from "../../utils/boxbase.js";
import { pointsToBbox, bboxToPoints } from "../../utils/ocr_utils.js";

const logger = getLogger("RapidTableModel");

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

    const config = tableConfig instanceof RapidTableInput
      ? tableConfig
      : new RapidTableInput(tableConfig ?? {});

    const modelType = config.modelType ?? ModelType.UNET_SLANET_PLUS;

    // UNET_SLANET_PLUS mode: dual-model (wired + wireless) with TableCls
    if (modelType === ModelType.UNET_SLANET_PLUS) {
      inst._mode = "dual";
      inst._tableCls = await TableCls.create({ model_type: ModelType.Q_CLS });
      inst._wiredModel = await RapidTable.create(
        new RapidTableInput({ ...config, modelType: ModelType.UNET })
      );
      inst._wirelessModel = await RapidTable.create(
        new RapidTableInput({ ...config, modelType: ModelType.SLANETPLUS })
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
    const { fillImageRes = null, mfdRes = null, skipTextInImage = true } = opts;

    try {
      if (!ocrResult || !Array.isArray(ocrResult) || ocrResult.length < 3) {
        if (!fillImageRes && !mfdRes) {
          return { html: "", cellBboxes: [], elapse: 0 };
        }
        ocrResult = [[], [], []];
      }

      const boxes = Array.isArray(ocrResult[0]) ? [...ocrResult[0]] : [];
      const texts = Array.isArray(ocrResult[1]) ? [...ocrResult[1]] : [];
      const scores = Array.isArray(ocrResult[2]) ? [...ocrResult[2]] : [];

      if (Array.isArray(fillImageRes)) {
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
        return await this._predictDual(image, finalOcrResult, opts);
      }
      
      const result = await this._singleModel.run([image], [finalOcrResult]);
      return {
        html: (result && result.predHtmls && result.predHtmls[0]) ? result.predHtmls[0] : "",
        cellBboxes: (result && result.cellBboxes && result.cellBboxes[0]) ? result.cellBboxes[0] : [],
        elapse: result ? result.elapse : 0,
      };
    } catch (err) {
      console.error("[RapidTableModel.predict] error:", err);
      throw err;
    }
  }

  /**
   * Dual-model prediction with TableCls for wired/wireless selection.
   * @param {HTMLImageElement|ImageBitmap|ImageData|Uint8Array|string} image
   * @param {object|null} ocrResult
   * @param {object} opts
   */
  async _predictDual(image, ocrResult, opts) {
    if (opts?.useCompareTable) {
      const [wiredResult, wirelessResult] = await Promise.all([
        this._wiredModel.run([image], ocrResult ? [ocrResult] : null),
        this._wirelessModel.run([image], ocrResult ? [ocrResult] : null),
      ]);
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

    // Load image for classification
    const { LoadImage } = await import("./rapid_table_self/utils/load_image.js");
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

    const model = tableType === "wireless" ? this._wirelessModel : this._wiredModel;
    const result = await model.run([image], ocrResult ? [ocrResult] : null);
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
  async batchPredict(images, ocrResults = []) {
    const results = await Promise.all(
      images.map((img, i) => this.predict(img, ocrResults[i] ?? null))
    );
    return {
      htmls: results.map(r => r.html),
      cellBboxes: results.map(r => r.cellBboxes),
      elapse: results.reduce((sum, r) => sum + r.elapse, 0),
    };
  }
}

export default RapidTableModel;
