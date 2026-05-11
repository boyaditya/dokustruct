// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table_structure/pp_structure/post_process.py → post_process.js
// TableLabelDecode: decode character probabilities → HTML structure tokens + cell bboxes

/**
 * Decode table structure predictions from an ONNX model.
 * PORTING NOTE: TableLabelDecode(dict_character, cfg)
 * - decode(bbox_preds, structure_probs, shape_list, ori_imgs)
 * - Handles SLANETPLUS_RESCALE and general bbox decode
 */
export class TableLabelDecode {
  /**
   * @param {string[]} dictCharacter - Character list from model metadata
   * @param {object} [cfg] - Optional config (ignored in basic mode)
   */
  constructor(dictCharacter, cfg = {}) {
    // Python: merge_no_span_structure logic
    const mergeNoSpan = cfg.merge_no_span_structure !== false;
    let charList = [...dictCharacter];
    
    if (mergeNoSpan) {
      if (!charList.includes('<td></td>')) {
        charList.push('<td></td>');
      }
      // Remove standalone <td> if exists
      charList = charList.filter(c => c !== '<td>');
    }
    
    // Add special start/end tokens
    this.character = ["sos", ...charList, "eos"];
    this.charToIdx = new Map(this.character.map((c, i) => [c, i]));
    this.cfg = cfg;
    this.td_token = ["<td>", "<td", "<td></td>"];  // Python parity
  }

  /**
   * Full decode: probs → structure tokens + cell bboxes.
   * @param {import('onnxruntime-web').Tensor|null} bboxPreds - [N, SeqLen, 4] or null
   * @param {import('onnxruntime-web').Tensor} structureProbs - [N, SeqLen, VocabSize]
   * @param {number[][]} shapeList - [[origH,origW,ratioH,ratioW,padH,padW],...]
   * @param {cv.Mat[]} [oriImgs]
   * @returns {{ structures: string[][], cellBboxes: number[][][] }}
   */
  decode(bboxPreds, structureProbs, shapeList, oriImgs = []) {
    const N = structureProbs.dims[0];
    const SeqLen = structureProbs.dims[1];
    const VocabSize = structureProbs.dims[2];
    const structData = Array.from(structureProbs.cpuData ?? structureProbs.data);
    const bboxData = bboxPreds ? Array.from(bboxPreds.cpuData ?? bboxPreds.data) : null;
    const bboxDims = bboxPreds ? bboxPreds.dims[2] : 4; // Support 4 or 8 dims

    const allStructures = [];
    const allCellBboxes = [];

    for (let n = 0; n < N; n++) {
      const shape = shapeList[n];
      const tokens = [];
      const bboxes = [];

      for (let s = 0; s < SeqLen; s++) {
        // Argmax over vocab
        let maxIdx = 0, maxVal = -Infinity;
        const offset = (n * SeqLen + s) * VocabSize;
        for (let v = 0; v < VocabSize; v++) {
          if (structData[offset + v] > maxVal) {
            maxVal = structData[offset + v];
            maxIdx = v;
          }
        }

        const char = this.character[maxIdx];
        
        // Skip sos/eos tokens (Python parity)
        if (char === "eos") break;
        if (char === "sos") continue;
        
        // Safety check: skip undefined tokens
        if (char === undefined || char === null) continue;
        
        tokens.push(char);

        // Decode bounding box for <td> tokens only (Python parity)
        // Python: if text in self.td_token (checks ["<td>", "<td", "<td></td>"])
        const isTdToken = this.td_token.some(t => char === t || char.startsWith(t));
        if (bboxData && isTdToken) {
          const bboxOffset = (n * SeqLen + s) * bboxDims;
          const rawBox = [];
          for (let d = 0; d < bboxDims; d++) {
            rawBox.push(bboxData[bboxOffset + d]);
          }
          bboxes.push(this._bboxDecode(rawBox, shape));
        }
      }

      allStructures.push(tokens);

      // Python: normalize_bboxes → rescale_cell_bboxes (SLANETPLUS only) + filter_blank_bbox
      let finalBboxes = bboxes.filter(b => b.some(v => v !== 0));
      const modelType = this.cfg.model_type ?? this.cfg.modelType ?? '';
      if (modelType === 'slanet_plus' || modelType === 'slanetplus') {
        const oriImg = oriImgs[n];
        if (oriImg && finalBboxes.length > 0) {
          const h = oriImg.rows, w = oriImg.cols;
          const resized = 488;
          const ratio = Math.min(resized / h, resized / w);
          const wRatio = resized / (w * ratio);
          const hRatio = resized / (h * ratio);
          finalBboxes = finalBboxes.map(bbox => {
            const r = [...bbox];
            for (let i = 0; i < r.length; i++) {
              if (i % 2 === 0) r[i] *= wRatio;
              else r[i] *= hRatio;
            }
            return r;
          });
        }
      }
      allCellBboxes.push(finalBboxes);
    }

    return { structures: allStructures, cellBboxes: allCellBboxes };
  }

  /**
   * Decode normalized bbox coords to pixel coords.
   * Python: bbox[0::2] *= w, bbox[1::2] *= h
   * @param {number[]} bbox - Normalized coords (8 values for quad or 4 for rect)
   * @param {number[]} shape [origH, origW, ratioH, ratioW, padH, padW]
   * @returns {number[]} Pixel coords (same length as input)
   */
  _bboxDecode(bbox, shape) {
    const [origH, origW] = shape;
    const result = [...bbox];
    
    // Python logic: bbox[0::2] *= w, bbox[1::2] *= h
    for (let i = 0; i < result.length; i++) {
      if (i % 2 === 0) {
        result[i] *= origW;  // x coords
      } else {
        result[i] *= origH;  // y coords
      }
    }
    
    return result;
  }

  /**
   * Filter out all-zero bounding boxes.
   * @param {number[][]} bboxes
   * @returns {number[][]}
   */
  filterBlankBbox(bboxes) {
    return bboxes.filter(b => b.some(v => v !== 0));
  }
}

export default TableLabelDecode;
