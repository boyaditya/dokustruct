// Copyright (c) Opendatalab. All rights reserved.

import { RapidTableInput, RapidTableOutput, ModelType } from "./utils/typings.js";
import { LoadImage } from "./utils/load_image.js";
import { formatOcrResults } from "./utils/utils.js";
import { PPTableStructurer } from "./table_structure/pp_structure/main.js";
import { UnetTableRecognition } from "./table_structure/unet/unet_table_rec.js";
import { UniTableStructure } from "./table_structure/unitable/main.js";
import { TableMatch } from "./table_matcher/main.js";
import { wrapWithHtmlStruct } from "./table_structure/utils.js";
import { getLogger } from "./utils/logger.js";
import { deleteMat, deleteMatList } from "../../../utils/resource_utils.js";
import { formatPipelineError } from "../../../utils/browser_utils.js";
import { AbortException } from "../../../utils/exceptions.js";

const logger = getLogger("RapidTable");

export class RapidTable {
  constructor() {
    this._structurer = null;
    this._matcher = new TableMatch();
    this._loadImage = new LoadImage();
    this._modelType = null;
  }

  static async create(cfg = null) {
    const inst = new RapidTable();
    const config = cfg instanceof RapidTableInput ? cfg : new RapidTableInput(cfg ?? {});
    inst._modelType = config.modelType;
    logger.info(`RapidTable: using model type ${inst._modelType}`);

    if (inst._modelType === ModelType.UNITABLE || inst._modelType === ModelType.UNET_UNITABLE) {
      inst._structurer = await UniTableStructure.create({ ...config, model_type: inst._modelType });
    } else if (inst._modelType === ModelType.UNET || inst._modelType === ModelType.UNET_SLANET_PLUS) {
      inst._structurer = await UnetTableRecognition.create({ ...config, model_type: ModelType.UNET });
    } else {
      inst._structurer = await PPTableStructurer.create({
        model_type: inst._modelType,
        model_dir_or_path: config.modelDirOrPath,
        engine_cfg: config.engineCfg,
      });
    }
    return inst;
  }

  /**
   * Run table structure recognition on a batch of images.
   * Element-level errors are caught and skipped; AbortException always propagates.
   * @param {Array} oriImgs
   * @param {Array|null} [ocrResults]
   * @returns {Promise<RapidTableOutput>}
   */
  async run(oriImgs, ocrResults = null) {
    const t0 = performance.now();
    const mats = await Promise.all(oriImgs.map(img => this._loadImage.run(img)));

    try {
      const { predHtmls, cellBboxes, logicPointsList, scores } = await this._runStructurer(mats, ocrResults);
      const elapse = (performance.now() - t0) / 1000;
      return new RapidTableOutput({
        imgs: oriImgs,
        predHtmls,
        cellBboxes,
        logicPoints: logicPointsList,
        // FIX T11b: include per-image mean decode scores
        scores,
        elapse,
      });
    } finally {
      deleteMatList(mats);
    }
  }

  /**
   * Dispatch to the appropriate structurer based on model type.
   * @private
   */
  async _runStructurer(mats, ocrResults) {
    if (this._modelType === ModelType.UNET || this._modelType === ModelType.UNET_SLANET_PLUS) {
      const result = await this._structurer.run(mats, ocrResults || []);
      return {
        predHtmls: result.predHtmls,
        cellBboxes: result.cellBboxes,
        logicPointsList: result.logicPointsList,
        // FIX T11b: UNET path does not produce decode scores; use empty array for shape consistency
        scores: result.scores ?? [],
      };
    }

    const { structures, cellBboxes, scores } = await this._structurer.run(mats);
    const predHtmls = [];
    const allCellBboxes = [];
    const logicPointsList = [];
    // FIX T11b: collect per-image mean scores from decode output
    const allScores = [];

    for (let i = 0; i < structures.length; i++) {
      try {
        const html = this._processGenericTable(structures[i], cellBboxes[i] ?? [], ocrResults, mats[i], i);
        predHtmls.push(html);
        allCellBboxes.push(cellBboxes[i] ?? []);
        logicPointsList.push([]);
        allScores.push(scores ? (scores[i] ?? 0) : 0);
      } catch (err) {
        if (err instanceof AbortException) throw err;
        console.warn(formatPipelineError({
          stage: 'table',
          module: 'RapidTable',
          message: `Failed to process table ${i}: ${err?.message ?? err}`,
          pageIndex: i,
          recoverable: true,
        }));
        predHtmls.push("");
        allCellBboxes.push([]);
        logicPointsList.push([]);
        allScores.push(0);
      }
    }

    return { predHtmls, cellBboxes: allCellBboxes, logicPointsList, scores: allScores };
  }

  /**
   * Process a single table with generic (SLANET/PP-Structure) flow.
   * @private
   */
  _processGenericTable(structureTokens, cells, ocrResults, mat, index) {
    if (ocrResults && ocrResults[index] && ocrResults[index].length >= 3) {
      const { dtBoxes, recRes } = formatOcrResults(
        ocrResults[index][0].map((box, idx) => ({
          bbox: box,
          text: ocrResults[index][1]?.[idx] || "",
          score: ocrResults[index][2]?.[idx] || 1.0,
        })),
        mat.rows,
        mat.cols
      );

      const htmlList = this._matcher.run([structureTokens], [cells], dtBoxes, recRes);
      return wrapWithHtmlStruct([htmlList[0] ?? ""]);
    }

    logger.warn(`[RapidTable] No OCR results for image ${index} - cells will be empty`);
    return wrapWithHtmlStruct(structureTokens);
  }

  /**
   * Dispose the underlying structurer and release resources.
   */
  async dispose() {
    if (this._structurer && typeof this._structurer.dispose === 'function') {
      try {
        await this._structurer.dispose();
      } catch (err) {
        console.warn(formatPipelineError({
          stage: 'dispose',
          module: 'RapidTable',
          message: `Failed to dispose structurer: ${err?.message ?? err}`,
          recoverable: true,
        }));
      }
    }
    this._structurer = null;
  }
}
