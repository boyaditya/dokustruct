// Copyright (c) 2024 PaddlePaddle Authors. All Rights Reserved.
// Apache License, Version 2.0

import { BLOCK_LABEL_MAP, XYCUT_SETTINGS } from "../setting.js";
import {
  calculateOverlapRatio,
  calculateProjectionOverlapRatio,
} from "../utils.js";
import {
  calculateDiscontinuousProjection,
  euclideanInsert,
  findLocalMinimaFlatRegions,
  getBlocksByDirectionInterval,
  getCutBlocks,
  insertChildBlocks,
  manhattanInsert,
  projectionByBboxes,
  recursiveXyCut,
  recursiveYxCut,
  referenceInsert,
  shrinkOverlappingBoxes,
  sortNormalBlocks,
  updateDocTitleChildBlocks,
  updateParagraphTitleChildBlocks,
  updateRegionChildBlocks,
  updateVisionChildBlocks,
  weightedDistanceInsert,
} from "./utils.js";

export { xycut_enhanced };

// ─────────────────────────────────────────────────────────────
// sort_by_xycut
// ─────────────────────────────────────────────────────────────

function sortByXycut(blockBboxes, direction = "vertical", minGap = 1) {
  if (!blockBboxes || blockBboxes.length === 0) return [];
  const intBoxes = blockBboxes.map((b) => b.map(Math.round));
  const res = [];
  const indices = Array.from({ length: intBoxes.length }, (_, i) => i);
  if (direction === "vertical") {
    recursiveYxCut(intBoxes, indices, res, minGap);
  } else {
    recursiveXyCut(intBoxes, indices, res, minGap);
  }
  return res;
}

// ─────────────────────────────────────────────────────────────
// update_region_label
// ─────────────────────────────────────────────────────────────

function updateRegionLabel(block, region) {
  if (BLOCK_LABEL_MAP.header_labels.includes(block.label)) {
    block.order_label = "header";
  } else if (BLOCK_LABEL_MAP.doc_title_labels.includes(block.label)) {
    block.order_label = "doc_title";
  } else if (
    BLOCK_LABEL_MAP.paragraph_title_labels.includes(block.label) &&
    block.order_label === null
  ) {
    block.order_label = "paragraph_title";
  } else if (BLOCK_LABEL_MAP.vision_labels.includes(block.label)) {
    block.order_label = "vision";
    block.num_of_lines = 1;
    block.updateDirection(region.direction);
  } else if (BLOCK_LABEL_MAP.footer_labels.includes(block.label)) {
    block.order_label = "footer";
  } else if (BLOCK_LABEL_MAP.unordered_labels.includes(block.label)) {
    block.order_label = "unordered";
  } else if (block.label === "region") {
    block.order_label = "region";
  } else {
    block.order_label = "normal_text";
  }

  if (!["vision", "doc_title", "paragraph_title", "region"].includes(block.order_label)) {
    return;
  }
  if (block.order_label === "doc_title") {
    updateDocTitleChildBlocks(block, region);
  } else if (block.order_label === "paragraph_title") {
    updateParagraphTitleChildBlocks(block, region);
  } else if (block.order_label === "vision") {
    updateVisionChildBlocks(block, region);
  } else if (block.order_label === "region") {
    updateRegionChildBlocks(block, region);
  }
}

// ─────────────────────────────────────────────────────────────
// pre_process
// ─────────────────────────────────────────────────────────────

function preProcess(region) {
  if (!region || !region.block_map) return [];

  const maskLabels = [
    "header",
    "unordered",
    "footer",
    "vision_footnote",
    "sub_paragraph_title",
    "doc_title_text",
    "vision_title",
    "sub_region",
  ];

  const preCutBlockIdxes = [];
  const blockMap = region.block_map;
  const blocks = Object.values(blockMap);

  for (const block of blocks) {
    if (!maskLabels.includes(block.order_label)) {
      updateRegionLabel(block, region);
    }

    const blockDir = block.direction;
    const toleranceLen =
      blockDir === "horizontal"
        ? Math.floor(block.long_side_length / 5)
        : Math.floor(block.short_side_length / 10);

    const blockCenter =
      (block.bbox[region.direction_start_index] +
        block.bbox[region.direction_end_index]) /
      2;
    const centerOffset = Math.abs(blockCenter - region.direction_center_coordinate);
    if (centerOffset <= toleranceLen) {
      preCutBlockIdxes.push(block.index);
    }
  }

  const preCutList = [];
  const cutDirection = region.secondary_direction;
  let cutCoordinates = [];
  let discontinuous = [];

  const allBoxes = blocks
    .filter((b) => !maskLabels.includes(b.order_label))
    .map((b) => b.bbox);

  if (allBoxes.length === 0) return preCutList;

  let numList = [];
  if (preCutBlockIdxes.length > 0) {
    [discontinuous, numList] = calculateDiscontinuousProjection(
      allBoxes,
      cutDirection,
      true
    );
    for (const idx of preCutBlockIdxes) {
      const block = blockMap[idx];
      if (
        !maskLabels.includes(block.order_label) &&
        block.secondary_direction === cutDirection
      ) {
        const key = JSON.stringify([
          block.secondary_direction_start_coordinate,
          block.secondary_direction_end_coordinate,
        ]);
        const discIdx = discontinuous.findIndex(
          (d) =>
            d[0] === block.secondary_direction_start_coordinate &&
            d[1] === block.secondary_direction_end_coordinate
        );
        if (discIdx !== -1 && numList[discIdx] === 1) {
          cutCoordinates.push(block.secondary_direction_start_coordinate);
          cutCoordinates.push(block.secondary_direction_end_coordinate);
        }
      }
    }
  }

  const secondaryCheckBoxes = blocks
    .filter(
      (b) =>
        !maskLabels.includes(b.order_label) &&
        b.order_label !== "vision"
    )
    .map((b) => b.bbox);

  if (secondaryCheckBoxes.length > 0 || (blocks.length > 0 && blocks[0].label === "region")) {
    const secondaryDisc = calculateDiscontinuousProjection(
      secondaryCheckBoxes,
      region.direction
    );
    if (secondaryDisc.length === 1 || (blocks.length > 0 && blocks[0].label === "region")) {
      if (discontinuous.length === 0) {
        discontinuous = calculateDiscontinuousProjection(allBoxes, cutDirection);
      }
      const currentInterval = discontinuous[0];
      const preCutCoords = cutCoordinates.filter(
        (c) => c < currentInterval[1]
      );
      let preCutCoordinate =
        preCutCoords.length === 0 ? 0 : Math.max(...preCutCoords);
      preCutCoordinate = Math.max(currentInterval[0], preCutCoordinate);

      let prevInterval = discontinuous[0];
      for (let di = 1; di < discontinuous.length; di++) {
        const interval = discontinuous[di];
        const gapLen = interval[0] - prevInterval[1];
        if (
          gapLen >= region.text_line_height * 3 ||
          (blocks.length > 0 && blocks[0].label === "region")
        ) {
          cutCoordinates.push(prevInterval[1]);
        } else if (gapLen > region.text_line_height * 1.2) {
          const preBlocks = getBlocksByDirectionInterval(
            Object.values(blockMap),
            preCutCoordinate,
            prevInterval[1],
            cutDirection
          );
          const postBlocks = getBlocksByDirectionInterval(
            Object.values(blockMap),
            prevInterval[1],
            interval[1],
            cutDirection
          );
          const preBboxes = preBlocks.map((b) => b.bbox);
          const postBboxes = postBlocks.map((b) => b.bbox);
          const projIdx = cutDirection === "horizontal" ? 1 : 0;
          const preProj = projectionByBboxes(preBboxes, projIdx);
          const postProj = projectionByBboxes(postBboxes, projIdx);
          const preIntervals = findLocalMinimaFlatRegions(preProj);
          const postIntervals = findLocalMinimaFlatRegions(postProj);

          const preGapBoxes = (preIntervals || []).map(([s, e]) => {
            const bbox = [0, 0, 0, 0];
            bbox[projIdx] = s;
            bbox[projIdx + 2] = e;
            return bbox;
          });
          const postGapBoxes = (postIntervals || []).map(([s, e]) => {
            const bbox = [0, 0, 0, 0];
            bbox[projIdx] = s;
            bbox[projIdx + 2] = e;
            return bbox;
          });
          const maxGapNum = Math.max(preGapBoxes.length, postGapBoxes.length);
          if (maxGapNum > 0) {
            const discIntervals = calculateDiscontinuousProjection(
              [...preGapBoxes, ...postGapBoxes],
              region.direction
            );
            if (discIntervals.length !== maxGapNum) {
              preCutCoordinate = prevInterval[1];
              cutCoordinates.push(prevInterval[1]);
            }
          }
        }
        prevInterval = interval;
      }
    }
  }

  const cutList = getCutBlocks(
    Object.values(blockMap).filter(
      (b) => !maskLabels.includes(b.order_label)
    ),
    cutDirection,
    cutCoordinates,
    maskLabels
  );
  preCutList.push(...cutList);
  if (region.direction === "vertical") {
    preCutList.reverse();
  }
  return preCutList;
}

// ─────────────────────────────────────────────────────────────
// get_layout_structure
// ─────────────────────────────────────────────────────────────

function getLayoutStructure(blocks, regionDirection, regionSecondaryDirection) {
  if (!blocks || blocks.length === 0) return;

  blocks.sort((a, b) => {
    if (a.bbox[0] !== b.bbox[0]) return a.bbox[0] - b.bbox[0];
    return a.width - b.width;
  });

  const maskLabels = ["doc_title", "cross_layout", "cross_reference"];
  const crossThreshold =
    XYCUT_SETTINGS.cross_layout_ref_text_block_words_num_threshold ?? 8;

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    if (maskLabels.includes(block.order_label)) continue;

    for (let ri = 0; ri < blocks.length; ri++) {
      const ref = blocks[ri];
      if (bi === ri || maskLabels.includes(ref.order_label)) continue;

      const bboxIou = calculateOverlapRatio(block.bbox, ref.bbox);
      if (bboxIou) {
        if (ref.order_label === "vision") {
          ref.order_label = "cross_layout";
          break;
        }
        if (bboxIou > 0.1 && block.area < ref.area) {
          block.order_label = "cross_layout";
          break;
        }
      }

      const matchIou = calculateProjectionOverlapRatio(
        block.bbox, ref.bbox, regionDirection
      );
      if (matchIou > 0) {
        for (let si = 0; si < blocks.length; si++) {
          if ([bi, ri].includes(si) || maskLabels.includes(blocks[si].order_label)) continue;
          const sec = blocks[si];
          const bboxIou2 = calculateOverlapRatio(block.bbox, sec.bbox);
          if (bboxIou2 > 0.1) {
            if (sec.order_label === "vision") {
              sec.order_label = "cross_layout";
              break;
            }
            if (block.order_label === "vision" || block.area < sec.area) {
              block.order_label = "cross_layout";
              break;
            }
          }

          const secMatchIou = calculateProjectionOverlapRatio(
            block.bbox, sec.bbox, regionDirection
          );
          const refMatchIou = calculateProjectionOverlapRatio(
            ref.bbox, sec.bbox, regionDirection
          );
          const secRefMatchIou = calculateProjectionOverlapRatio(
            ref.bbox, sec.bbox, regionSecondaryDirection
          );

          if (secMatchIou > 0 && refMatchIou === 0 && secRefMatchIou > 0) {
            if (
              ["vision", "region"].includes(block.order_label) ||
              (ref.order_label === "normal_text" &&
               sec.order_label === "normal_text" &&
               ref.long_side_length > ref.text_line_height * crossThreshold &&
               sec.long_side_length > sec.text_line_height * crossThreshold)
            ) {
              block.order_label =
                block.label === "reference"
                  ? "cross_reference"
                  : "cross_layout";
            }
          }
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// match_unsorted_blocks
// ─────────────────────────────────────────────────────────────

function matchUnsortedBlocks(sortedBlocks, unsortedBlocks, region) {
  if (!unsortedBlocks || unsortedBlocks.length === 0) return sortedBlocks;
  if (!sortedBlocks) sortedBlocks = [];

  const distanceTypeMap = {
    cross_layout: weightedDistanceInsert,
    paragraph_title: weightedDistanceInsert,
    doc_title: weightedDistanceInsert,
    vision_title: weightedDistanceInsert,
    vision: weightedDistanceInsert,
    cross_reference: referenceInsert,
    unordered: manhattanInsert,
    other: manhattanInsert,
    region: euclideanInsert,
  };

  const tlh = Math.max(region.text_line_height, 1);
  const tlw = Math.max(region.text_line_width, 1);
  unsortedBlocks = sortNormalBlocks(unsortedBlocks, tlh, tlw, region.direction);

  for (let idx = 0; idx < unsortedBlocks.length; idx++) {
    const block = unsortedBlocks[idx];
    const orderLabel = block.label !== "region" ? block.order_label : "region";
    if (idx === 0 && orderLabel === "doc_title") {
      sortedBlocks.unshift(block);
      continue;
    }
    const insertFn = distanceTypeMap[orderLabel] || manhattanInsert;
    insertFn(block, sortedBlocks, region);
  }
  return sortedBlocks;
}

// ─────────────────────────────────────────────────────────────
// xycut_enhanced (main entry point)
// ─────────────────────────────────────────────────────────────

function xycut_enhanced(region) {
  if (!region || Object.keys(region.block_map || {}).length === 0) return [];

  const preCutList = preProcess(region);
  const finalOrderResList = [];

  const headerBlocks = region.header_block_idxes.map(
    (idx) => region.block_map[idx]
  );
  const unorderedBlocks = region.unordered_block_idxes.map(
    (idx) => region.block_map[idx]
  );
  const footerBlocks = region.footer_block_idxes.map(
    (idx) => region.block_map[idx]
  );

  const tlh = Math.max(region.text_line_height, 1);
  const tlw = Math.max(region.text_line_width, 1);

  const sortedHeaders = sortNormalBlocks(headerBlocks, tlh, tlw, region.direction);
  const sortedFooters = sortNormalBlocks(footerBlocks, tlh, tlw, region.direction);
  const sortedUnordered = sortNormalBlocks(unorderedBlocks, tlh, tlw, region.direction);

  finalOrderResList.push(...sortedHeaders);

  let unsortedBlocks = [];
  const sortedBlocksByPreCuts = [];

  for (const preCutBlocks of preCutList) {
    let sortedBlocks = [];
    const docTitleBlocks = [];
    const xyCutBlocks = [];

    if (preCutBlocks.length > 0 && preCutBlocks[0].label === "region") {
      const bbs = preCutBlocks.map((b) => b.bbox);
      const disc = calculateDiscontinuousProjection(bbs, region.direction);
      if (disc.length === 1) {
        getLayoutStructure(preCutBlocks, region.direction, region.secondary_direction);
      }
    } else {
      getLayoutStructure(preCutBlocks, region.direction, region.secondary_direction);
    }

    for (const block of preCutBlocks) {
      if (
        !["cross_layout", "cross_reference", "doc_title", "unordered"].includes(
          block.order_label
        )
      ) {
        xyCutBlocks.push(block);
      } else if (block.label === "doc_title") {
        docTitleBlocks.push(block);
      } else {
        unsortedBlocks.push(block);
      }
    }

    if (xyCutBlocks.length > 0) {
      const blockBboxes = xyCutBlocks.map((b) => b.bbox);
      const blockTextLines = xyCutBlocks.map((b) => b.num_of_lines);
      const disc = calculateDiscontinuousProjection(blockBboxes, region.direction);

      let blocksToSort = xyCutBlocks.map((b) => {
        // shallow clone bbox for vertical negation
        return { ...b, bbox: [...b.bbox] };
      });

      if (region.direction === "vertical") {
        for (const b of blocksToSort) {
          b.bbox = [-b.bbox[0], b.bbox[1], -b.bbox[2], b.bbox[3]];
        }
      }

      const halfTlh = Math.max(Math.floor(tlh / 2), 1);
      let sortedIndexes;

      if (disc.length === 1 || Math.max(...blockTextLines) === 1) {
        blocksToSort.sort((a, b) => {
          const ra = Math.floor(a.bbox[region.secondary_direction_start_index] / halfTlh);
          const rb = Math.floor(b.bbox[region.secondary_direction_start_index] / halfTlh);
          if (ra !== rb) return ra - rb;
          return a.bbox[region.direction_start_index] - b.bbox[region.direction_start_index];
        });
        blocksToSort = shrinkOverlappingBoxes(blocksToSort, region.secondary_direction);
        sortedIndexes = sortByXycut(
          blocksToSort.map((b) => b.bbox),
          region.secondary_direction,
          1
        );
      } else {
        blocksToSort.sort((a, b) => {
          const ra = Math.floor(a.bbox[region.secondary_direction_start_index] / halfTlh);
          const rb = Math.floor(b.bbox[region.secondary_direction_start_index] / halfTlh);
          if (ra !== rb) return ra - rb;
          return a.bbox[region.direction_start_index] - b.bbox[region.direction_start_index];
        });
        blocksToSort = shrinkOverlappingBoxes(blocksToSort, region.secondary_direction);
        sortedIndexes = sortByXycut(
          blocksToSort.map((b) => b.bbox),
          region.direction,
          1
        );
      }

      sortedBlocks = sortedIndexes.map(
        (i) => region.block_map[blocksToSort[i].index]
      );
    }

    sortedBlocks = matchUnsortedBlocks(sortedBlocks, docTitleBlocks, region);

    if (
      unsortedBlocks.length > 0 &&
      unsortedBlocks[0].label === "region"
    ) {
      sortedBlocks = matchUnsortedBlocks(sortedBlocks, unsortedBlocks, region);
      unsortedBlocks = [];
    }
    sortedBlocksByPreCuts.push(...sortedBlocks);
  }

  const finalSorted = matchUnsortedBlocks(
    sortedBlocksByPreCuts,
    unsortedBlocks,
    region
  );
  finalOrderResList.push(...finalSorted);
  finalOrderResList.push(...sortedFooters);
  finalOrderResList.push(...sortedUnordered);

  for (let bi = 0; bi < finalOrderResList.length; bi++) {
    const block = finalOrderResList[bi];
    insertChildBlocks(block, bi, finalOrderResList);
    // bi now may skip — reflect length change handled by insertChildBlocks mutating array
  }

  return finalOrderResList;
}
