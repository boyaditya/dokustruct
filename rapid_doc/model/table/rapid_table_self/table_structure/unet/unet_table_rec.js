// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: unet_table_rec.py → unet_table_rec.js
// UnetTableRecognition: Full pipeline for UNet table recognition with OCR matching

import { TSRUnetStructurer } from "./main.js";
import { TableRecover } from "./table_recover.js";
import {
  matchOcrCell,
  plotHtmlTable,
  box42PolyToBox41,
  sortedOcrBoxes,
  gatherOcrListByRow,
} from "./utils/utils_table_recover.js";

export class UnetTableRecognition {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.tableStructure = null;
    this.tableRecover = new TableRecover();
  }

  static async create(cfg = {}) {
    const inst = new UnetTableRecognition(cfg);
    inst.tableStructure = await TSRUnetStructurer.create(cfg);
    return inst;
  }

  async run(oriImgs, ocrResults, opts = {}) {
    const needOcr = opts.needOcr !== false;
    const colThreshold = opts.colThreshold ?? 15;
    const rowThreshold = opts.rowThreshold ?? 10;

    const predHtmls = [];
    const cellBboxes = [];
    const logicPointsList = [];

    for (let i = 0; i < oriImgs.length; i++) {
      try {
        // Format OCR result: [(box, text, score), ...]
        let ocrResult = [];
        if (ocrResults && ocrResults[i] && ocrResults[i].length >= 3) {
          ocrResult = ocrResults[i][0].map((box, idx) => [
            box,
            ocrResults[i][1]?.[idx] || "",
            ocrResults[i][2]?.[idx] || 1.0
          ]);
        }

        // Get polygons from structure detection
        const structResult = await this.tableStructure.run([oriImgs[i]]);
        let { polygons, rotatedPolygons } = structResult[0];

        if (!polygons || polygons.length === 0) {
          predHtmls.push("");
          cellBboxes.push([]);
          logicPointsList.push([]);
          continue;
        }

        // Table recovery to get logic points
        const { logicPoints: logiPoints } = this.tableRecover.run(
          rotatedPolygons,
          rowThreshold,
          colThreshold
        );

        // Swap indices 1 and 3 (counterclockwise → clockwise)
        for (const poly of polygons) {
          const p1 = poly[1], p3 = poly[3];
          poly[1] = p3;
          poly[3] = p1;
        }

        if (!needOcr) {
          const [sortedPolygons, idxList] = sortedOcrBoxes(
            polygons.map(p => box42PolyToBox41(p)),
            0.3
          );
          predHtmls.push("");
          cellBboxes.push(sortedPolygons);
          logicPointsList.push(idxList.map(idx => logiPoints[idx]));
          continue;
        }

        // Match OCR to cells
        const [cellBoxDetMap] = matchOcrCell(ocrResult, polygons);

        // Fill blank cells
        this.fillBlankRec(polygons, cellBoxDetMap);

        // Transform to intermediate format
        let tRecOcrList = this.transformRes(cellBoxDetMap, polygons, logiPoints);

        // Sort and gather OCR results per cell
        tRecOcrList = this.sortAndGatherOcrRes(tRecOcrList);

        // Extract logic points and text map
        const finalLogiPoints = tRecOcrList.map(t => t.t_logic_box);
        const finalCellBoxMap = {};
        for (let j = 0; j < tRecOcrList.length; j++) {
          finalCellBoxMap[j] = tRecOcrList[j].t_ocr_res.map(x => x[1]);
        }

        // Generate HTML
        const predHtml = plotHtmlTable(finalLogiPoints, finalCellBoxMap);

        // Flatten polygons to 8-element arrays
        const flatPolygons = polygons.map(p => p.flat());

        predHtmls.push(predHtml);
        cellBboxes.push(flatPolygons);
        logicPointsList.push(finalLogiPoints);

      } catch (err) {
        console.warn("UnetTableRecognition error:", err);
        predHtmls.push("");
        cellBboxes.push([]);
        logicPointsList.push([]);
      }
    }

    return { predHtmls, cellBboxes, logicPointsList };
  }

  transformRes(cellBoxDetMap, polygons, logiPoints) {
    const res = [];
    for (let i = 0; i < polygons.length; i++) {
      const ocrResList = cellBoxDetMap[i];
      if (!ocrResList) {
        continue; // Skip cells without OCR matches
      }

      // Calculate bounding box of all OCR boxes in this cell
      const xmin = Math.min(...ocrResList.map(ocr => ocr[0][0][0]));
      const ymin = Math.min(...ocrResList.map(ocr => ocr[0][0][1]));
      const xmax = Math.max(...ocrResList.map(ocr => ocr[0][2][0]));
      const ymax = Math.max(...ocrResList.map(ocr => ocr[0][2][1]));

      const dictRes = {
        t_box: [xmin, ymin, xmax, ymax],
        t_logic_box: logiPoints[i],
        t_ocr_res: ocrResList.map(ocrDet => [
          box42PolyToBox41(ocrDet[0]),
          ocrDet[1]
        ])
      };
      res.push(dictRes);
    }
    return res;
  }

  sortAndGatherOcrRes(res) {
    for (const dictRes of res) {
      // Sort OCR boxes within cell
      const [, sortedIdx] = sortedOcrBoxes(
        dictRes.t_ocr_res.map(x => x[0]),
        0.3
      );
      dictRes.t_ocr_res = sortedIdx.map(idx => dictRes.t_ocr_res[idx]);

      // Gather OCR boxes on same row
      dictRes.t_ocr_res = gatherOcrListByRow(dictRes.t_ocr_res, 0.3);
    }
    return res;
  }

  fillBlankRec(sortedPolygons, cellBoxMap) {
    for (let i = 0; i < sortedPolygons.length; i++) {
      if (cellBoxMap[i]) {
        continue;
      }
      const box = sortedPolygons[i];
      cellBoxMap[i] = [[box, "", 1]];
    }
    return cellBoxMap;
  }
}

export default UnetTableRecognition;
