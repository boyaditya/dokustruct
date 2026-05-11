// Copyright (c) RapidAI. All rights reserved.
/**
 * PORTING NOTE: rapid_doc/backend/utils/utils.py → backend/utils/utils.js
 *
 * WORKAROUND: os.getenv('MINERU_TABLE_MERGE_ENABLE')
 * REASON: No OS environment in browser
 * SOLUTION: Always enable table merge (browser default = enabled)
 *
 * WORKAROUND: deepcopy (Python stdlib)
 * SOLUTION: structuredClone()
 */

import { mergeTable } from "../../utils/table_merge.js";
import { calculatePolygonOverlapRatio, calculateBboxArea } from "../../model/layout/rapid_layout_self/model_handler/pp_doclayout/post_process.js";
import { calculateOverlapRatio } from "../../model/reading_order/utils.js";
import { isIn } from "../../utils/boxbase.js";
import { txtInOriImage } from "../../utils/span_pre_proc.js";

// ---------------------------------------------------------------------------
// cross_page_table_merge
// ---------------------------------------------------------------------------

/**
 * Merge tables that span across multiple pages.
 * PORTING NOTE: os.getenv('MINERU_TABLE_MERGE_ENABLE') → always enabled in browser
 *
 * @param {object[]} pdfInfo
 */
export function crossPageTableMerge(pdfInfo) {
  // PORTING NOTE: env var not available in browser — default to always-enabled
  mergeTable(pdfInfo);
}

// ---------------------------------------------------------------------------
// remove_layout_in_ori_images
// ---------------------------------------------------------------------------

/**
 * Remove layout results that fall inside original image regions.
 * For image regions that caused replacements, inject a new 'image' detection entry.
 * PORTING NOTE: remove_layout_in_ori_images(...)
 *
 * @param {object[][]} imagesLayoutRes
 * @param {object[]} pdfDictList
 * @param {number[]} scaleList
 * @returns {object[][]}
 */
export function removeLayoutInOriImages(imagesLayoutRes, pdfDictList, scaleList) {
  for (let index = 0; index < imagesLayoutRes.length; index++) {
    const layoutRes = imagesLayoutRes[index];
    const oriImageList = pdfDictList[index]?.ori_image_list;
    const scale = scaleList[index];

    if (!oriImageList?.length) continue;

    // Filter out "background images" that contain text
    const validOriImages = oriImageList.filter(
      ori => !txtInOriImage(pdfDictList[index], ori.bbox)
    );

    if (!validOriImages.length) {
      imagesLayoutRes[index] = layoutRes;
      continue;
    }

    // Scale original image bboxes
    const scaledOriBboxes = validOriImages.map(ori => [
      ori.bbox[0] * scale,
      ori.bbox[1] * scale,
      ori.bbox[2] * scale,
      ori.bbox[3] * scale,
    ]);

    const filteredLayoutRes = [];
    const replacedOriBboxes = new Set();

    for (const res of layoutRes) {
      // Keep category_id === 2 (image in original) as-is
      if (res.category_id === 2) {
        filteredLayoutRes.push(res);
        continue;
      }

      const [x1, y1, x2, y2] = [res.poly[0], res.poly[1], res.poly[4], res.poly[5]];
      const resBbox = [Math.trunc(x1), Math.trunc(y1), Math.trunc(x2), Math.trunc(y2)];

      let matchedIdx = null;
      for (let idx = 0; idx < scaledOriBboxes.length; idx++) {
        if (isIn(resBbox, scaledOriBboxes[idx])) {
          matchedIdx = idx;
          break;
        }
      }

      if (matchedIdx !== null) {
        replacedOriBboxes.add(matchedIdx);
        continue; // drop this layout result
      }
      filteredLayoutRes.push(res);
    }

    // Add replaced image regions back as 'image' (category_id=3)
    for (const idx of replacedOriBboxes) {
      const [xmin, ymin, xmax, ymax] = scaledOriBboxes[idx].map(Math.trunc);
      filteredLayoutRes.push({
        category_id: 3,
        original_label: "image",
        poly: [xmin, ymin, xmax, ymin, xmax, ymax, xmin, ymax],
        score: 1.0,
      });
    }

    imagesLayoutRes[index] = filteredLayoutRes;
  }

  return imagesLayoutRes;
}

// ---------------------------------------------------------------------------
// filter_overlap_boxes
// ---------------------------------------------------------------------------

/**
 * Remove overlapping boxes from layout detection results.
 * PORTING NOTE: deepcopy → structuredClone; logic identical
 *
 * @param {object[]} layoutDetRes
 * @param {boolean} useCustomOcr
 * @returns {object[]}
 */
export function filterOverlapBoxes(layoutDetRes, useCustomOcr) {
  const layoutDetResFiltered = structuredClone(layoutDetRes);
  const boxes = layoutDetResFiltered.filter(box => box.original_label !== "reference");
  const droppedIndexes = new Set();

  for (let i = 0; i < boxes.length; i++) {
    const coordI = [boxes[i].poly[0], boxes[i].poly[1], boxes[i].poly[4], boxes[i].poly[5]];
    const [x1, y1, x2, y2] = coordI;
    const w = x2 - x1;
    const h = y2 - y1;
    if (w < 6 || h < 6) {
      droppedIndexes.add(i);
    }
    for (let j = i + 1; j < boxes.length; j++) {
      if (droppedIndexes.has(i) || droppedIndexes.has(j)) continue;

      const coordJ = [boxes[j].poly[0], boxes[j].poly[1], boxes[j].poly[4], boxes[j].poly[5]];
      const overlapRatio = calculateOverlapRatio(coordI, coordJ, "small");

      const iIsInline = boxes[i].original_label === "inline_formula";
      const jIsInline = boxes[j].original_label === "inline_formula";

      if (iIsInline || jIsInline) {
        if (!useCustomOcr) continue;
        if (overlapRatio > 0.5) {
          if (iIsInline) droppedIndexes.add(i);
          if (jIsInline) droppedIndexes.add(j);
        }
        continue;
      }

      if (overlapRatio > 0.7) {
        if (boxes[i].polygon_points) {
          const polyOverlap = calculatePolygonOverlapRatio(
            boxes[i].polygon_points, boxes[j].polygon_points, "small"
          );
          if (polyOverlap < 0.7) continue;
        }

        const specialLabels = new Set(["image", "seal", "chart"]);
        if (
          (specialLabels.has(boxes[i].original_label) || specialLabels.has(boxes[j].original_label)) &&
          boxes[i].original_label !== boxes[j].original_label
        ) {
          continue;
        }

        const areaI = calculateBboxArea(coordI);
        const areaJ = calculateBboxArea(coordJ);
        if (areaI >= areaJ) {
          droppedIndexes.add(j);
        } else {
          droppedIndexes.add(i);
        }
      }
    }
  }

  return boxes.filter((_, idx) => !droppedIndexes.has(idx));
}
