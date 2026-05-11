// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: rapid_table_self/main.py → main.js
// RapidTable: batched table recognition (structure + OCR matching)

import { RapidTableInput, RapidTableOutput, ModelType, EngineType } from "./utils/typings.js";
import { LoadImage } from "./utils/load_image.js";
import { formatOcrResults } from "./utils/utils.js";
import { PPTableStructurer } from "./table_structure/pp_structure/main.js";
import { UnetTableRecognition } from "./table_structure/unet/unet_table_rec.js";
import { UniTableStructure } from "./table_structure/unitable/main.js";
import { TableMatch } from "./table_matcher/main.js";
import { wrapWithHtmlStruct } from "./table_structure/utils.js";
import { getLogger } from "./utils/logger.js";

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

  async run(oriImgs, ocrResults = null) {
    const t0 = performance.now();
    logger.info(`[RapidTable.run] Input:`, {
      imgCount: oriImgs.length,
      hasOcrResults: !!ocrResults,
      ocrResultsLen: ocrResults?.length,
      ocrResultsSample: ocrResults?.[0] ? {
        boxes: ocrResults[0][0]?.length,
        texts: ocrResults[0][1]?.length,
        scores: ocrResults[0][2]?.length,
      } : null,
    });
    const mats = await Promise.all(oriImgs.map(img => this._loadImage.run(img)));
    let allPredHtmls = [];
    let allCellBboxes = [];
    let allLogicPoints = [];

    try {
      if (this._modelType === ModelType.UNET || this._modelType === ModelType.UNET_SLANET_PLUS) {
        // Use UnetTableRecognition (full pipeline)
        const result = await this._structurer.run(mats, ocrResults || []);
        allPredHtmls = result.predHtmls;
        allCellBboxes = result.cellBboxes;
        allLogicPoints = result.logicPointsList;
      } else {
        // Generic flow (SLANET/PP-Structure)
        const { structures, cellBboxes } = await this._structurer.run(mats);
        for (let i = 0; i < structures.length; i++) {
          const structureTokens = structures[i];
          const cells = cellBboxes[i] ?? [];
          let html;
          
          logger.info(`[RapidTable] Processing table ${i}:`, {
            hasOcrResults: !!ocrResults,
            ocrResultsLen: ocrResults?.length,
            hasOcrForThisImage: !!(ocrResults && ocrResults[i]),
            ocrResultType: ocrResults?.[i] ? typeof ocrResults[i] : 'undefined',
            ocrResultIsArray: Array.isArray(ocrResults?.[i]),
            ocrResultLength: ocrResults?.[i]?.length,
            structLen: structureTokens.length,
            cellsLen: cells.length,
          });
          
          if (ocrResults && ocrResults[i] && ocrResults[i].length >= 3) {
            logger.info(`[RapidTable] OCR result structure for image ${i}:`, {
              boxes: ocrResults[i][0]?.length,
              texts: ocrResults[i][1]?.length,
              scores: ocrResults[i][2]?.length,
              boxesSample: ocrResults[i][0]?.slice(0, 2),
              textsSample: ocrResults[i][1]?.slice(0, 5),
            });
            
            const { dtBoxes, recRes } = formatOcrResults(
              ocrResults[i][0].map((box, idx) => ({
                bbox: box, text: ocrResults[i][1]?.[idx] || "", score: ocrResults[i][2]?.[idx] || 1.0
              })),
              mats[i].rows, mats[i].cols
            );
            
            logger.info(`[RapidTable] After formatOcrResults:`, {
              dtBoxesLen: dtBoxes.length,
              recResLen: recRes.length,
              dtBoxSample: dtBoxes.slice(0, 2),
              recResSample: recRes.slice(0, 3),
            });
            
            const htmlList = this._matcher.run([structureTokens], [cells], dtBoxes, recRes);
            logger.info(`[RapidTable] Matcher output:`, {
              htmlLen: htmlList[0]?.length,
              htmlSample: htmlList[0]?.substring(0, 200),
            });
            
            html = wrapWithHtmlStruct([htmlList[0] ?? ""]);
          } else {
            logger.warn(`[RapidTable] NO OCR RESULTS for image ${i} - cells will be empty!`);
            html = wrapWithHtmlStruct(structureTokens);
          }
          allPredHtmls.push(html);
          allCellBboxes.push(cells);
          allLogicPoints.push([]);
        }
      }
    } finally {
      for (const mat of mats) if (mat && !mat.isDeleted()) mat.delete();
    }
    const elapse = (performance.now() - t0) / 1000;
    return new RapidTableOutput({ imgs: oriImgs, predHtmls: allPredHtmls, cellBboxes: allCellBboxes, logicPoints: allLogicPoints, elapse });
  }
}

export default RapidTable;
