// Copyright (c) 2024 PaddlePaddle Authors. All Rights Reserved.
// Apache License, Version 2.0

import { LayoutBlock, LayoutRegion } from "./layout_objects.js";
import {
  BLOCK_LABEL_MAP,
  BLOCK_SETTINGS,
  REGION_SETTINGS,
} from "./setting.js";
import {
  caculateBboxArea,
  calculateMinimumEnclosingBbox,
  calculateOverlapRatio,
  getBboxIntersection,
  getSubRegionsOcrRes,
  removeOverlapBlocks,
  shrinkSupplementRegionBbox,
  updateRegionBox,
} from "./utils.js";
import { xycut_enhanced } from "./xycut_enhanced/index.js";

export {
  getLayoutParsingRes,
  standardizedData,
  getLayoutParsingObjects,
  sortLayoutParsingBlocks,
};

// ─────────────────────────────────────────────────────────────
// sort_layout_parsing_blocks
// ─────────────────────────────────────────────────────────────

function sortLayoutParsingBlocks(layoutParsingPage) {
  if (!layoutParsingPage || Object.keys(layoutParsingPage.block_map || {}).length === 0) return [];
  const layoutParsingRegions = xycut_enhanced(layoutParsingPage);
  const parsingResList = [];
  for (const region of layoutParsingRegions) {
    const layoutParsingBlocks = xycut_enhanced(region);
    parsingResList.push(...layoutParsingBlocks);
  }
  return parsingResList;
}

// ─────────────────────────────────────────────────────────────
// standardized_data
// ─────────────────────────────────────────────────────────────

/**
 * Pre-process layout/OCR data: match boxes to regions, fix labels, handle overlaps.
 * @param {ImageData|object} image  - {width, height} or ImageBitmap-like
 * @param {object} regionDetRes   - {boxes: [{coordinate, label, score}]}
 * @param {object} layoutDetRes   - {boxes: [{coordinate, label, score}]}
 * @param {object} overallOcrRes  - {rec_boxes, rec_texts, rec_scores, rec_polys, dt_polys, rec_labels}
 * @param {number|null} textRecScoreThresh
 * @returns {[object, object, object]} [regionBlockOcrIdxMap, regionDetRes, layoutDetRes]
 */
function standardizedData(
  image,
  regionDetRes,
  layoutDetRes,
  overallOcrRes,
  textRecScoreThresh = null
) {
  if (!overallOcrRes) {
    overallOcrRes = { rec_boxes: [], rec_texts: [], rec_scores: [], rec_polys: [], dt_polys: [], rec_labels: [] };
  }
  if (!regionDetRes || !regionDetRes.boxes) {
    regionDetRes = { boxes: [] };
  }
  if (!layoutDetRes || !layoutDetRes.boxes) {
    layoutDetRes = { boxes: [] };
  }
  const matchedOcrDict = {};
  const regionToBlockMap = {};
  const blockToOcrMap = {};
  const objectBoxes = [];
  const footnoteList = [];
  const paragraphTitleList = [];
  let bottomTextYMax = 0;
  let maxBlockArea = 0;
  let docTitleNum = 0;
  let baseRegionBbox = [65535, 65535, 0, 0];

  // Mutable copy of layouts (remove overlaps)
  layoutDetRes = removeOverlapBlocks(
    { boxes: layoutDetRes.boxes.map((b) => ({ ...b })) },
    0.5,
    true
  );

  const maskLabels = [
    ...BLOCK_LABEL_MAP.unordered_labels,
    ...BLOCK_LABEL_MAP.header_labels,
    ...BLOCK_LABEL_MAP.footer_labels,
  ];

  // ── First pass: match OCR to layout boxes ──────────────────
  for (let boxIdx = 0; boxIdx < layoutDetRes.boxes.length; boxIdx++) {
    const boxInfo = layoutDetRes.boxes[boxIdx];
    const box = boxInfo.coordinate;
    const label = (boxInfo.label || "").toLowerCase();
    objectBoxes.push(box);
    const y2 = box[3];

    baseRegionBbox = updateRegionBox(box, baseRegionBbox);
    maxBlockArea = Math.max(maxBlockArea, caculateBboxArea(box));

    if (label === "footnote") footnoteList.push(boxIdx);
    else if (label === "paragraph_title") paragraphTitleList.push(boxIdx);
    if (label === "text") bottomTextYMax = Math.max(y2, bottomTextYMax);
    if (label === "doc_title") docTitleNum++;

    if (!["formula", "table", "seal"].includes(label)) {
      const [, matchedIdxes] = getSubRegionsOcrRes(
        overallOcrRes,
        [box],
        true,
        true
      );
      blockToOcrMap[boxIdx] = matchedIdxes;
      for (const mIdx of matchedIdxes) {
        if (matchedOcrDict[mIdx] == null) {
          matchedOcrDict[mIdx] = [boxIdx];
        } else {
          matchedOcrDict[mIdx].push(boxIdx);
        }
      }
    }
  }

  // Fix footnote labels
  for (const fIdx of footnoteList) {
    if (layoutDetRes.boxes[fIdx].coordinate[3] < bottomTextYMax) {
      layoutDetRes.boxes[fIdx].label = "text";
    }
  }

  // Single paragraph title → doc_title?
  if (paragraphTitleList.length === 1 && docTitleNum === 0) {
    const ptArea = caculateBboxArea(
      layoutDetRes.boxes[paragraphTitleList[0]].coordinate
    );
    const thresh =
      BLOCK_SETTINGS.title_conversion_area_ratio_threshold ?? 0.3;
    if (ptArea > maxBlockArea * thresh) {
      layoutDetRes.boxes[paragraphTitleList[0]].label = "doc_title";
    }
  }

  // ── Replace OCR boxes at block boundaries ─────────────────
  const scoreThresh = textRecScoreThresh ?? 0;
  for (const [ocrIdxStr, layoutBoxIds] of Object.entries(matchedOcrDict)) {
    const overallOcrIdx = Number(ocrIdxStr);
    if (layoutBoxIds.length <= 1) continue;
    let matchedNo = 0;
    const overallOcrBox = [...overallOcrRes.rec_boxes[overallOcrIdx]];
    const overallOcrDtPoly = overallOcrRes.dt_polys
      ? [...overallOcrRes.dt_polys[overallOcrIdx]]
      : null;

    for (const boxIdx of layoutBoxIds) {
      const layoutBox = layoutDetRes.boxes[boxIdx].coordinate;
      const cropBox = getBboxIntersection(overallOcrBox, layoutBox);

      for (const ocrIdx of blockToOcrMap[boxIdx] || []) {
        const ocBox = overallOcrRes.rec_boxes[ocrIdx];
        if (!cropBox || !ocBox) continue;
        const iou = calculateOverlapRatio(ocBox, cropBox, "small");
        if (iou > 0.8) overallOcrRes.rec_texts[ocrIdx] = "";
      }

      const cropDtPoly = overallOcrDtPoly
        ? getBboxIntersection(overallOcrDtPoly, layoutBox, "poly")
        : null;
      const recScore = 0; // no live OCR re-inference
      const recText = "-";

      if (recScore >= scoreThresh) {
        matchedNo++;
        if (matchedNo === 1) {
          if (cropDtPoly) {
            overallOcrRes.dt_polys[overallOcrIdx] = cropDtPoly;
            overallOcrRes.rec_polys[overallOcrIdx] = cropDtPoly;
          }
          if (cropBox) overallOcrRes.rec_boxes[overallOcrIdx] = cropBox;
          overallOcrRes.rec_scores[overallOcrIdx] = recScore;
          overallOcrRes.rec_texts[overallOcrIdx] = recText;
        } else {
          if (cropDtPoly) {
            overallOcrRes.dt_polys.push(cropDtPoly);
            overallOcrRes.rec_polys.push(cropDtPoly);
          }
          if (cropBox) overallOcrRes.rec_boxes.push(cropBox);
          overallOcrRes.rec_scores.push(recScore);
          overallOcrRes.rec_texts.push(recText);
          overallOcrRes.rec_labels.push("text");
          const bm = blockToOcrMap[boxIdx];
          const rmPos = bm.indexOf(overallOcrIdx);
          if (rmPos !== -1) bm.splice(rmPos, 1);
          bm.push(overallOcrRes.rec_texts.length - 1);
        }
      }
    }
  }

  // ── No layout results: fall back to OCR ───────────────────
  if (
    layoutDetRes.boxes.length === 0 &&
    overallOcrRes.rec_boxes.length > 0
  ) {
    for (let idx = 0; idx < overallOcrRes.rec_boxes.length; idx++) {
      const box = overallOcrRes.rec_boxes[idx];
      baseRegionBbox = updateRegionBox(box, baseRegionBbox);
      layoutDetRes.boxes.push({
        label: "text",
        coordinate: box,
        score: overallOcrRes.rec_scores[idx],
      });
      blockToOcrMap[idx] = [idx];
    }
  }

  // ── Match blocks to regions ────────────────────────────────
  const blockBboxes = layoutDetRes.boxes.map((b) => b.coordinate);
  regionDetRes = {
    ...regionDetRes,
    boxes: [...regionDetRes.boxes].sort(
      (a, b) => caculateBboxArea(a.coordinate) - caculateBboxArea(b.coordinate)
    ),
  };

  if (regionDetRes.boxes.length === 0) {
    regionDetRes.boxes = [
      {
        coordinate: baseRegionBbox,
        label: "SupplementaryRegion",
        score: 1,
      },
    ];
    regionToBlockMap[0] = [...Array(blockBboxes.length).keys()];
  } else {
    let blockIdxesSet = new Set(
      Array.from({ length: blockBboxes.length }, (_, i) => i)
    );
    const matchThresh =
      REGION_SETTINGS.match_block_overlap_ratio_threshold ?? 0.8;

    for (let ri = 0; ri < regionDetRes.boxes.length; ri++) {
      regionToBlockMap[ri] = [];
      const regionBbox = regionDetRes.boxes[ri].coordinate;
      let matchedIdxes = [];

      for (const bi of blockIdxesSet) {
        if (maskLabels.includes(layoutDetRes.boxes[bi].label)) continue;
        const overlapRatio = calculateOverlapRatio(
          regionBbox,
          blockBboxes[bi],
          "small"
        );
        if (overlapRatio > matchThresh) matchedIdxes.push(bi);
      }

      // Iterative region refinement
      if (matchedIdxes.length > 0) {
        let oldIdxes = [];
        while (oldIdxes.length !== matchedIdxes.length) {
          oldIdxes = [...matchedIdxes];
          matchedIdxes = [];
          const matchedBboxes = oldIdxes.map((i) => blockBboxes[i]);
          const newRegionBbox = calculateMinimumEnclosingBbox(matchedBboxes);
          for (const bi of blockIdxesSet) {
            if (maskLabels.includes(layoutDetRes.boxes[bi].label)) continue;
            const ov = calculateOverlapRatio(newRegionBbox, blockBboxes[bi], "small");
            if (ov > matchThresh) matchedIdxes.push(bi);
          }
          regionDetRes.boxes[ri].coordinate = newRegionBbox;
        }
        for (const bi of matchedIdxes) blockIdxesSet.delete(bi);
        regionToBlockMap[ri] = matchedIdxes;
      }
    }

    // Supplement unmatched blocks
    while (blockIdxesSet.size > 0) {
      const unmatched = [...blockIdxesSet].map((i) => blockBboxes[i]);
      if (unmatched.length === 0) break;
      let supplementRegionBbox = calculateMinimumEnclosingBbox(unmatched);
      let matchedIdxes = [];

      const imgW = image.width || image.shape?.[1] || 1000;
      const imgH = image.height || image.shape?.[0] || 1000;

      for (let ri = 0; ri < regionDetRes.boxes.length; ri++) {
        if ((regionToBlockMap[ri] || []).length === 0) continue;
        const regionBbox = regionDetRes.boxes[ri].coordinate;
        const ov = calculateOverlapRatio(supplementRegionBbox, regionBbox);
        if (ov > 0) {
          let inerIdxes;
          [supplementRegionBbox, inerIdxes] = shrinkSupplementRegionBbox(
            supplementRegionBbox,
            regionBbox,
            imgW,
            imgH,
            new Set(blockIdxesSet),
            blockBboxes
          );
          matchedIdxes = [...inerIdxes];
        }
      }

      matchedIdxes = matchedIdxes.filter(
        (i) => !maskLabels.includes(layoutDetRes.boxes[i].label)
      );
      if (matchedIdxes.length === 0) {
        matchedIdxes = [...blockIdxesSet].filter(
          (i) => !maskLabels.includes(layoutDetRes.boxes[i].label)
        );
        if (matchedIdxes.length === 0) break;
      }

      const matchedBboxes = matchedIdxes.map((i) => blockBboxes[i]);
      supplementRegionBbox = calculateMinimumEnclosingBbox(matchedBboxes);
      const newRegionIdx = regionDetRes.boxes.length;
      regionToBlockMap[newRegionIdx] = [...matchedIdxes];
      for (const bi of matchedIdxes) blockIdxesSet.delete(bi);
      regionDetRes.boxes.push({
        coordinate: supplementRegionBbox,
        label: "SupplementaryRegion",
        score: 1,
      });
    }

    // Append mask-label blocks as standalone regions
    const maskIdxes = Array.from(
      { length: layoutDetRes.boxes.length },
      (_, i) => i
    ).filter((i) => maskLabels.includes(layoutDetRes.boxes[i].label));

    for (const idx of maskIdxes) {
      const bbox = layoutDetRes.boxes[idx].coordinate;
      const newRegionIdx = regionDetRes.boxes.length;
      regionToBlockMap[newRegionIdx] = [idx];
      regionDetRes.boxes.push({
        coordinate: bbox,
        label: "SupplementaryRegion",
        score: 1,
      });
    }
  }

  const regionBlockOcrIdxMap = {
    region_to_block_map: regionToBlockMap,
    block_to_ocr_map: blockToOcrMap,
  };

  return [regionBlockOcrIdxMap, regionDetRes, layoutDetRes];
}

// ─────────────────────────────────────────────────────────────
// get_layout_parsing_objects
// ─────────────────────────────────────────────────────────────

/**
 * Build LayoutBlock/LayoutRegion objects from detection and OCR results.
 */
function getLayoutParsingObjects(
  image,
  regionBlockOcrIdxMap,
  regionDetRes,
  overallOcrRes,
  layoutDetRes,
  textRecScoreThresh = null
) {
  if (!layoutDetRes || !layoutDetRes.boxes || layoutDetRes.boxes.length === 0) {
    return new LayoutRegion([0, 0, 0, 0], []);
  }

  const layoutParsingBlocks = [];

  for (let boxIdx = 0; boxIdx < layoutDetRes.boxes.length; boxIdx++) {
    const boxInfo = layoutDetRes.boxes[boxIdx];
    const label = boxInfo.label;
    const blockBbox = boxInfo.coordinate;

    const recRes = { boxes: [], rec_texts: [], rec_labels: [] };
    const block = new LayoutBlock(label, blockBbox);

    let ocrIdxList;
    if (label === "formula") {
      const [, idxList] = getSubRegionsOcrRes(
        overallOcrRes,
        [blockBbox],
        true,
        true
      );
      regionBlockOcrIdxMap.block_to_ocr_map[boxIdx] = idxList;
      ocrIdxList = idxList;
    } else {
      ocrIdxList = regionBlockOcrIdxMap.block_to_ocr_map[boxIdx] ?? [];
    }

    for (const boxNo of ocrIdxList) {
      recRes.boxes.push(overallOcrRes.rec_boxes[boxNo]);
      recRes.rec_texts.push(overallOcrRes.rec_texts[boxNo]);
      recRes.rec_labels.push(overallOcrRes.rec_labels[boxNo]);
    }

    block.updateTextContent(image, recRes, null, textRecScoreThresh);

    if (
      ["seal", "table", "formula", "chart", ...BLOCK_LABEL_MAP.image_labels].includes(label)
    ) {
      block.image = { path: "img_path", img: null };
    }

    layoutParsingBlocks.push(block);
  }

  let pageRegionBbox = [65535, 65535, 0, 0];
  const layoutParsingRegions = [];

  for (let regionIdx = 0; regionIdx < regionDetRes.boxes.length; regionIdx++) {
    const regionInfo = regionDetRes.boxes[regionIdx];
    const regionBbox = regionInfo.coordinate.map(Math.round);
    const regionBlocks = (
      regionBlockOcrIdxMap.region_to_block_map[regionIdx] || []
    ).map((idx) => layoutParsingBlocks[idx]);

    if (regionBlocks.length > 0) {
      pageRegionBbox = updateRegionBox(regionBbox, pageRegionBbox);
      const region = new LayoutRegion(regionBbox, regionBlocks);
      layoutParsingRegions.push(region);
    }
  }

  const layoutParsingPage = new LayoutRegion(
    pageRegionBbox.map(Math.round),
    layoutParsingRegions
  );
  return layoutParsingPage;
}

// ─────────────────────────────────────────────────────────────
// get_layout_parsing_res  (main entry point)
// ─────────────────────────────────────────────────────────────

/**
 * Full pipeline: standardise → build objects → sort.
 * @param {object} image           {width:N, height:N} or array-like
 * @param {object} regionDetRes    {boxes:[...]}
 * @param {object} layoutDetRes    {boxes:[...]}
 * @param {object} overallOcrRes   {rec_boxes, rec_texts, rec_scores, rec_polys, dt_polys, rec_labels}
 * @returns {LayoutBlock[]}
 */
function getLayoutParsingRes(image, regionDetRes, layoutDetRes, overallOcrRes) {
  if (!image || !layoutDetRes || !overallOcrRes) return [];

  const safeRegionDetRes = regionDetRes ?? { boxes: [] };
  const safeLayoutDetRes = layoutDetRes.boxes ? layoutDetRes : { boxes: [] };

  const [regionBlockOcrIdxMap, newRegionDetRes, newLayoutDetRes] =
    standardizedData(image, safeRegionDetRes, safeLayoutDetRes, overallOcrRes, 0);

  const layoutParsingPage = getLayoutParsingObjects(
    image,
    regionBlockOcrIdxMap,
    newRegionDetRes,
    overallOcrRes,
    newLayoutDetRes,
    0
  );

  const parsingResList = sortLayoutParsingBlocks(layoutParsingPage);

  let index = 1;
  for (const block of parsingResList) {
    if (BLOCK_LABEL_MAP.visualize_index_labels.includes(block.label)) {
      block.order_index = index++;
    }
  }

  return parsingResList;
}
