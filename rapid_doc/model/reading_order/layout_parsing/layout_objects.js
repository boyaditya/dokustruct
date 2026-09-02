// Copyright (c) 2024 PaddlePaddle Authors. All Rights Reserved.
// Apache License, Version 2.0

import { intTrunc } from '../../../utils/math_utils.js';
import { BLOCK_LABEL_MAP, LINE_SETTINGS } from "./setting.js";
import {
  caculateEuclideanDist,
  calculateProjectionOverlapRatio,
  isEnglishLetter,
  isNonBreakingPunctuation,
  isNumeric,
} from "./utils.js";

export { TextSpan, TextLine, LayoutBlock, LayoutRegion };

// ─────────────────────────────────────────────────────────────
// TextSpan
// ─────────────────────────────────────────────────────────────

class TextSpan {
  /**
   * @param {number[]} box [x1,y1,x2,y2]
   * @param {string} text
   * @param {string} label
   */
  constructor(box, text, label) {
    this.box = box;
    this.text = text;
    this.label = label;
  }

  toString() {
    return this.text;
  }
}

// ─────────────────────────────────────────────────────────────
// TextLine
// ─────────────────────────────────────────────────────────────

class TextLine {
  /**
   * @param {TextSpan[]} spans
   * @param {"horizontal"|"vertical"} direction
   */
  constructor(spans = [], direction = "horizontal") {
    this.spans = [...spans];
    this.direction = direction;
    this.region_box = this.getRegionBox();
    this.need_new_line = false;
  }

  get labels() {
    return this.spans.map((s) => s.label);
  }

  get boxes() {
    return this.spans.map((s) => s.box);
  }

  get height() {
    const si = this.direction === "horizontal" ? 1 : 0;
    const ei = this.direction === "horizontal" ? 3 : 2;
    return Math.abs((this.region_box[ei] ?? 0) - (this.region_box[si] ?? 0));
  }

  get width() {
    const si = this.direction === "horizontal" ? 0 : 1;
    const ei = this.direction === "horizontal" ? 2 : 3;
    return Math.abs((this.region_box[ei] ?? 0) - (this.region_box[si] ?? 0));
  }

  toString() {
    return this.spans.map((s) => String(s.text)).join(" ") + "\n";
  }

  /** @param {TextSpan|TextSpan[]} span */
  addSpan(span) {
    if (Array.isArray(span)) {
      this.spans.push(...span);
    } else {
      this.spans.push(span);
    }
    this.region_box = this.getRegionBox();
  }

  getRegionBox() {
    if (this.spans.length === 0) return null;
    let xMin = this.spans[0].box[0];
    let yMin = this.spans[0].box[1];
    let xMax = this.spans[0].box[2];
    let yMax = this.spans[0].box[3];
    for (const span of this.spans) {
      if (span.box[0] < xMin) xMin = span.box[0];
      if (span.box[1] < yMin) yMin = span.box[1];
      if (span.box[2] > xMax) xMax = span.box[2];
      if (span.box[3] > yMax) yMax = span.box[3];
    }
    return [xMin, yMin, xMax, yMax];
  }

  /**
   * Get text for this line (simplified: no live OCR re-inference).
   */
  getTexts(
    blockLabel,
    blockTextWidth,
    blockStartCoordinate,
    blockStopCoordinate,
    oriImage = null,
    textRecModel = null,
    textRecScoreThresh = null
  ) {
    const spanBoxStartIndex = this.direction === "horizontal" ? 0 : 1;
    const linesStartIndex = this.direction === "horizontal" ? 1 : 3;
    this.spans.sort((a, b) => {
      const ai = Math.floor(a.box[spanBoxStartIndex] / 2);
      const bi = Math.floor(b.box[spanBoxStartIndex] / 2);
      if (ai !== bi) return ai - bi;
      const av = a.box[linesStartIndex];
      const bv = b.box[linesStartIndex];
      return this.direction === "horizontal" ? av - bv : bv - av;
    });

    if (this.labels.includes("formula")) {
      const sortIndex = this.direction === "horizontal" ? 0 : 1;
      const splitedSpans = this.splitBoxesByProjection();
      if (this.spans.length !== splitedSpans.length) {
        splitedSpans.sort((a, b) => a.box[sortIndex] - b.box[sortIndex]);
        const newSpans = [];
        for (const span of splitedSpans) {
          if (span.label === "text") {
            // no live re-inference available — matches Python: crop_img_rec_score = 0
            const recScore = 0;
            span.text = "-"; // preserve text="-" assignment for parity
            // Porting fix: skip low-score spans in formula path
            if (recScore < textRecScoreThresh) continue;
          }
          newSpans.push(span);
        }
        this.spans = newSpans;
      }
    }

    const lineText = this.formatLine(
      blockTextWidth,
      blockStartCoordinate,
      blockStopCoordinate,
      this.height * 1.5,
      blockLabel
    );
    return lineText;
  }

  isProjectionContained(boxA, boxB, startIdx, endIdx) {
    return boxA[startIdx] <= boxB[startIdx] && boxA[endIdx] >= boxB[endIdx];
  }

  splitBoxesByProjection(offset = 1e-5) {
    const newSpans = [];
    const [projStart, projEnd] =
      this.direction === "horizontal" ? [0, 2] : [1, 3];

    for (let i = 0; i < this.spans.length; i++) {
      let span = this.spans[i];
      let isSplit = false;
      for (let j = i; j < this.spans.length; j++) {
        const boxB = this.spans[j].box;
        let boxA = span.box.slice();
        const { text, label } = span;
        if (this.isProjectionContained(boxA, boxB, projStart, projEnd)) {
          isSplit = true;
          if (boxA[projStart] < boxB[projStart]) {
            const w = boxB[projStart] - offset - boxA[projStart];
            if (w > 1) {
              const newBbox = boxA.slice();
              newBbox[projEnd] = boxB[projStart] - offset;
              newSpans.push(new TextSpan(newBbox, text, label));
            }
          }
          if (boxA[projEnd] > boxB[projEnd]) {
            const w = boxA[projEnd] - boxB[projEnd] + offset;
            if (w > 1) {
              boxA[projStart] = boxB[projEnd] + offset;
              span = new TextSpan(boxA.slice(), text, label);
            }
          }
        }
        if (j === this.spans.length - 1 && isSplit) {
          newSpans.push(span);
        }
      }
      if (!isSplit) newSpans.push(span);
    }
    return newSpans;
  }

  formatLine(
    blockTextWidth,
    blockStartCoordinate,
    blockStopCoordinate,
    lineGapLimit = 10,
    blockLabel = "text"
  ) {
    const firstBox = this.spans[0].box;
    const lastBox = this.spans[this.spans.length - 1].box;

    let lineText = "";
    for (const span of this.spans) {
      if (span.label === "formula" && blockLabel !== "formula") {
        const fr = span.text;
        if (!fr.startsWith("$") || !fr.endsWith("$")) {
          if (this.spans.length > 1) {
            span.text = `$${span.text}$`;
          } else {
            span.text = `\n$${span.text}$`;
          }
        }
      }
      lineText += span.text;
      if (
        (lineText.length > 0 &&
          isEnglishLetter(lineText[lineText.length - 1])) ||
        span.label === "formula"
      ) {
        lineText += " ";
      }
    }

    const textStopIndex = this.direction === "horizontal" ? 2 : 3;

    if (lineText.endsWith(" ")) lineText = lineText.slice(0, -1);
    if (lineText.length === 0) return "";

    const lastChar = lineText[lineText.length - 1];

    if (
      (!isEnglishLetter(lastChar) &&
        !isNonBreakingPunctuation(lastChar) &&
        !isNumeric(lastChar)) ||
      blockStopCoordinate - lastBox[textStopIndex] > blockTextWidth * 0.3
    ) {
      if (
        (this.direction === "horizontal" &&
          blockStopCoordinate - lastBox[textStopIndex] > lineGapLimit) ||
        (this.direction === "vertical" &&
          (blockStopCoordinate - lastBox[textStopIndex] > lineGapLimit ||
            firstBox[1] - blockStartCoordinate > lineGapLimit))
      ) {
        this.need_new_line = true;
      }
    }

    if (lineText.endsWith("-")) {
      return lineText.slice(0, -1);
    }

    const lastChar2 = lineText[lineText.length - 1] ?? "";
    if ((lineText.length > 0 && isEnglishLetter(lastChar2)) || lineText.endsWith("$")) {
      lineText += " ";
    }
    if (
      (lineText.length > 0 &&
        !isEnglishLetter(lastChar2) &&
        !isNumeric(lastChar2)) ||
      this.direction === "vertical"
    ) {
      if (
        blockStopCoordinate - lastBox[textStopIndex] > blockTextWidth * 0.3 &&
        lineText.length > 0 &&
        !isNonBreakingPunctuation(lastChar2)
      ) {
        lineText += "\n";
        this.need_new_line = true;
      }
    } else if (
      blockStopCoordinate - lastBox[textStopIndex] >
      (blockStopCoordinate - blockStartCoordinate) * 0.5
    ) {
      lineText += "\n";
      this.need_new_line = true;
    }

    return lineText;
  }
}

// ─────────────────────────────────────────────────────────────
// LayoutBlock
// ─────────────────────────────────────────────────────────────

class LayoutBlock {
  /**
   * @param {string} label
   * @param {number[]} bbox [x1,y1,x2,y2]
   * @param {string} content
   */
  constructor(label, bbox, content = "") {
    this.label = label;
    this.order_label = null;
    // Porting fix: intTrunc matches Python int truncation
    this.bbox = bbox.map(intTrunc);
    this.content = content;
    this.seg_start_coordinate = Infinity;
    this.seg_end_coordinate = -Infinity;
    this.width = bbox[2] - bbox[0];
    this.height = bbox[3] - bbox[1];
    this.area = this.width * this.height;
    this.num_of_lines = 1;
    this.image = null;
    this.index = null;
    this.order_index = null;
    this.text_line_width = 1;
    this.text_line_height = 1;
    this.child_blocks = [];
    this.ori_bbox = null;
    this.updateDirection();
  }

  toString() {
    return `\n\n#################\nindex:\t${this.index}\nlabel:\t${this.label}\nregion_label:\t${this.order_label}\nbbox:\t${this.bbox}\ncontent:\t${this.content}\n#################`;
  }

  /**
   * Generator that yields own serializable [key, value] pairs lazily.
   * Callers that need only a subset of properties can iterate and break early
   * without materialising the full object — reducing peak memory on dense pages.
   * Porting fix: streaming property serializer.
   * @yields {[string, *]}
   */
  *entries() {
    for (const key of Object.keys(this)) {
      yield [key, this[key]];
    }
  }

  /**
   * Serialize to a plain object (backward-compatible).
   * Internally driven by the lazy entries generator.
   * Porting fix: replaces eager spread `{ ...this }`.
   * @returns {Object}
   */
  toDict() {
    return Object.fromEntries(this.entries());
  }

  updateDirection(direction = null) {
    if (!direction) direction = this.getBboxDirection();
    this.direction = direction;
    this.updateDirectionInfo();
  }

  updateDirectionInfo() {
    if (this.direction === "horizontal") {
      this.secondary_direction = "vertical";
      this.short_side_length = this.height;
      this.long_side_length = this.width;
      this.start_coordinate = this.bbox[0];
      this.end_coordinate = this.bbox[2];
      this.secondary_direction_start_coordinate = this.bbox[1];
      this.secondary_direction_end_coordinate = this.bbox[3];
    } else {
      this.secondary_direction = "horizontal";
      this.short_side_length = this.width;
      this.long_side_length = this.height;
      this.start_coordinate = this.bbox[1];
      this.end_coordinate = this.bbox[3];
      this.secondary_direction_start_coordinate = this.bbox[0];
      this.secondary_direction_end_coordinate = this.bbox[2];
    }
  }

  appendChildBlock(childBlock) {
    if (this.child_blocks.length === 0) {
      this.ori_bbox = [...this.bbox];
    }
    const [x1, y1, x2, y2] = this.bbox;
    const [cx1, cy1, cx2, cy2] = childBlock.bbox;
    this.bbox = [
      Math.min(x1, cx1),
      Math.min(y1, cy1),
      Math.max(x2, cx2),
      Math.max(y2, cy2),
    ];
    this.updateDirectionInfo();
    const childBlocks = [childBlock];
    if (childBlock.child_blocks && childBlock.child_blocks.length > 0) {
      childBlocks.push(...childBlock.getChildBlocks());
    }
    this.child_blocks.push(...childBlocks);
  }

  getChildBlocks() {
    this.bbox = [...(this.ori_bbox || this.bbox)];
    const blocks = [...this.child_blocks];
    this.child_blocks = [];
    return blocks;
  }

  getCentroid() {
    const [x1, y1, x2, y2] = this.bbox;
    return [(x1 + x2) / 2, (y1 + y2) / 2];
  }

  getBboxDirection(directionRatio = 1.0) {
    return this.width * directionRatio >= this.height ? "horizontal" : "vertical";
  }

  calculateTextLineDirection(bboxes, directionRatio = 1.5) {
    let horizontalNum = 0;
    for (const bbox of bboxes) {
      const w = bbox[2] - bbox[0];
      const h = bbox[3] - bbox[1];
      if (w * directionRatio >= h) horizontalNum++;
    }
    return horizontalNum >= bboxes.length * 0.5 ? "horizontal" : "vertical";
  }

  /**
   * Group OCR spans into TextLine objects.
   * @param {{boxes:number[][], rec_texts:string[], rec_labels:string[]}} ocrRecRes
   * @param {number} lineHeightIouThreshold
   * @returns {TextLine[]}
   */
  groupBoxesIntoLines(ocrRecRes, lineHeightIouThreshold) {
    const recBoxes = ocrRecRes.boxes || [];
    const recTexts = ocrRecRes.rec_texts || [];
    const recLabels = ocrRecRes.rec_labels || [];

    const textBoxes = recBoxes.filter((_, i) => recLabels[i] === "text");
    const direction = this.calculateTextLineDirection(textBoxes);
    this.updateDirection(direction);

    const spans = recBoxes.map(
      (box, i) => new TextSpan(box, recTexts[i], recLabels[i])
    );
    if (spans.length === 0) return [];

    const matchDirection =
      this.direction === "vertical" ? "horizontal" : "vertical";

    if (this.direction === "vertical") {
      spans.sort((a, b) => b.box[0] - a.box[0]);
    } else {
      spans.sort((a, b) => a.box[1] - b.box[1]);
    }

    const lines = [];
    let currentLine = new TextLine([spans[0]], this.direction);

    for (let i = 1; i < spans.length; i++) {
      const span = spans[i];
      const overlapRatio = calculateProjectionOverlapRatio(
        currentLine.region_box,
        span.box,
        matchDirection,
        "small"
      );
      if (overlapRatio >= lineHeightIouThreshold) {
        currentLine.addSpan(span);
      } else {
        lines.push(currentLine);
        currentLine = new TextLine([span], this.direction);
      }
    }
    lines.push(currentLine);

    // Filter out abnormally tall lines for vertical direction
    if (lines.length > 0 && this.direction === "vertical") {
      const lineHeights = lines.map((l) => l.height);
      const minHeight = Math.min(...lineHeights);
      const maxHeight = Math.max(...lineHeights);
      if (maxHeight > minHeight * 2) {
        const normalThreshold = minHeight * 1.1;
        const normalCount = lineHeights.filter((h) => h < normalThreshold).length;
        if (normalCount < lines.length * 0.4) {
          const filtered = [];
          for (let i = 0; i < lines.length; i++) {
            if (lineHeights[i] <= normalThreshold) filtered.push(lines[i]);
          }
          lines.length = 0;
          lines.push(...filtered);
        }
      }
    }

    if (lines.length > 0) {
      const lh = lines.map((l) => l.height);
      const lw = lines.map((l) => l.width);
      this.text_line_height = lh.reduce((a, b) => a + b, 0) / lh.length;
      this.text_line_width = lw.reduce((a, b) => a + b, 0) / lw.length;
    } else {
      this.text_line_height = 0;
      this.text_line_width = 0;
    }

    return lines;
  }

  /**
   * Update content from OCR results.
   */
  updateTextContent(image, ocrRecRes, textRecModel = null, textRecScoreThresh = null) {
    if (!ocrRecRes.rec_texts || ocrRecRes.rec_texts.length === 0) {
      this.content = "";
      return;
    }

    const iouThreshold = LINE_SETTINGS.line_height_iou_threshold ?? 0.8;
    const lines = this.groupBoxesIntoLines(ocrRecRes, iouThreshold);

    const coordStartIdx = this.direction === "horizontal" ? 0 : 1;
    const coordEndIdx = coordStartIdx + 2;

    let blockStart, blockStop;
    if (this.label === "reference") {
      const boxes = ocrRecRes.boxes || [];
      blockStart = Math.min(...boxes.map((b) => b[coordStartIdx]));
      blockStop = Math.max(...boxes.map((b) => b[coordEndIdx]));
    } else {
      blockStart = this.bbox[coordStartIdx];
      blockStop = this.bbox[coordEndIdx];
    }

    const textLines = [];
    const textWidthList = [];
    let needNewLineNum = 0;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      textWidthList.push(line.width);
      const lineText = line.getTexts(
        this.label,
        Math.max(...textWidthList),
        blockStart,
        blockStop,
        image,
        textRecModel,
        textRecScoreThresh
      );
      if (line.need_new_line) needNewLineNum++;

      if (lineIdx === 0) {
        this.seg_start_coordinate = line.spans[0].box[0];
      } else if (lineIdx === lines.length - 1) {
        this.seg_end_coordinate = line.spans[line.spans.length - 1].box[2];
      }
      textLines.push(lineText);
    }

    const delimMap = LINE_SETTINGS.delimiter_map ?? {};
    const delim = delimMap[this.label] ?? undefined;

    let content;
    if (delim === undefined) {
      content = "";
      let preLineEnd = false;
      let lastChar = "";
      for (let idx = 0; idx < textLines.length; idx++) {
        let lineText = textLines[idx];
        if (lineText.length === 0) continue;
        const line = lines[idx];
        if (preLineEnd) {
          const startGapLen =
            (line.region_box ? line.region_box[coordStartIdx] : blockStart) -
            blockStart;
          if (
            ((startGapLen > line.height * 1.5 &&
              !isEnglishLetter(lastChar) &&
              !isNumeric(lastChar)) ||
              startGapLen > (blockStop - blockStart) * 0.4) &&
            !content.endsWith("\n")
          ) {
            lineText = "\n" + lineText;
          }
        }
        content += lineText;
        if (lineText.length > 2 && lineText.endsWith(" ")) {
          lastChar = lineText[lineText.length - 2];
        } else {
          lastChar = lineText[lineText.length - 1] ?? "";
        }
        const coordEnd = line.region_box ? line.region_box[coordEndIdx] : blockStop;
        if (
          (lineText.length > 0 &&
            !lineText.endsWith("\n") &&
            !isEnglishLetter(lastChar) &&
            !isNonBreakingPunctuation(lastChar) &&
            !isNumeric(lastChar) &&
            needNewLineNum > textLines.length * 0.5) ||
          needNewLineNum > textLines.length * 0.6
        ) {
          content += "\n";
        }
        if (blockStop - coordEnd > (blockStop - blockStart) * 0.3) {
          preLineEnd = true;
        }
      }
    } else {
      content = textLines.join(delim);
    }

    this.content = content;
    this.num_of_lines = textLines.length;
  }
}

// ─────────────────────────────────────────────────────────────
// LayoutRegion extends LayoutBlock
// ─────────────────────────────────────────────────────────────

class LayoutRegion extends LayoutBlock {
  /**
   * @param {number[]} bbox [x1,y1,x2,y2]
   * @param {LayoutBlock[]} blocks
   */
  constructor(bbox, blocks = []) {
    super("region", bbox, "");
    this.bbox = bbox.slice();
    this.block_map = {};
    this.direction = "horizontal";
    this.doc_title_block_idxes = [];
    this.paragraph_title_block_idxes = [];
    this.vision_block_idxes = [];
    this.unordered_block_idxes = [];
    this.vision_title_block_idxes = [];
    this.normal_text_block_idxes = [];
    this.euclidean_distance = Infinity;
    this.header_block_idxes = [];
    this.footer_block_idxes = [];
    this.text_line_width = 20;
    this.text_line_height = 10;
    this.num_of_lines = 10;
    this.initRegionInfoFromLayout(blocks);
    this.updateEuclideanDistance();
  }

  initRegionInfoFromLayout(blocks) {
    let horizontalNormalTextNum = 0;
    const textLineHeights = [];
    const textLineWidths = [];

    for (let idx = 0; idx < blocks.length; idx++) {
      const block = blocks[idx];
      this.block_map[idx] = block;
      block.index = idx;

      if (BLOCK_LABEL_MAP.header_labels.includes(block.label)) {
        this.header_block_idxes.push(idx);
      } else if (BLOCK_LABEL_MAP.doc_title_labels.includes(block.label)) {
        this.doc_title_block_idxes.push(idx);
      } else if (BLOCK_LABEL_MAP.paragraph_title_labels.includes(block.label)) {
        this.paragraph_title_block_idxes.push(idx);
      } else if (BLOCK_LABEL_MAP.vision_labels.includes(block.label)) {
        this.vision_block_idxes.push(idx);
      } else if (BLOCK_LABEL_MAP.vision_title_labels.includes(block.label)) {
        this.vision_title_block_idxes.push(idx);
      } else if (BLOCK_LABEL_MAP.footer_labels.includes(block.label)) {
        this.footer_block_idxes.push(idx);
      } else if (BLOCK_LABEL_MAP.unordered_labels.includes(block.label)) {
        this.unordered_block_idxes.push(idx);
      } else {
        this.normal_text_block_idxes.push(idx);
        textLineHeights.push(block.text_line_height);
        textLineWidths.push(block.text_line_width);
        if (block.direction === "horizontal") horizontalNormalTextNum++;
      }
    }

    const direction =
      horizontalNormalTextNum >= this.normal_text_block_idxes.length * 0.5
        ? "horizontal"
        : "vertical";
    this.updateDirection(direction);

    this.text_line_width =
      textLineWidths.length > 0
        ? textLineWidths.reduce((a, b) => a + b, 0) / textLineWidths.length
        : 20;
    this.text_line_height =
      textLineHeights.length > 0
        ? textLineHeights.reduce((a, b) => a + b, 0) / textLineHeights.length
        : 10;
  }

  updateEuclideanDistance() {
    const blocks = Object.values(this.block_map);
    let distances;
    if (this.direction === "horizontal") {
      const refPoint = [0, 0];
      distances = blocks.map((b) =>
        caculateEuclideanDist([b.bbox[0], b.bbox[1]], refPoint)
      );
    } else {
      const refPoint = [this.bbox[2], 0];
      distances = blocks.map((b) =>
        caculateEuclideanDist([b.bbox[2], b.bbox[1]], refPoint)
      );
    }
    this.euclidean_distance =
      distances.length > 0 ? Math.min(...distances) : 0;
  }

  updateDirection(direction = null) {
    super.updateDirection(direction);
    if (this.direction === "horizontal") {
      this.direction_start_index = 0;
      this.direction_end_index = 2;
      this.secondary_direction_start_index = 1;
      this.secondary_direction_end_index = 3;
      this.secondary_direction = "vertical";
    } else {
      this.direction_start_index = 1;
      this.direction_end_index = 3;
      this.secondary_direction_start_index = 0;
      this.secondary_direction_end_index = 2;
      this.secondary_direction = "horizontal";
    }
    this.direction_center_coordinate =
      (this.bbox[this.direction_start_index] +
        this.bbox[this.direction_end_index]) /
      2;
    this.secondary_direction_center_coordinate =
      (this.bbox[this.secondary_direction_start_index] +
        this.bbox[this.secondary_direction_end_index]) /
      2;
  }
}
