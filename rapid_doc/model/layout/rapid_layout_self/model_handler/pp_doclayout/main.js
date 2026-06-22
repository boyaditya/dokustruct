/**
 * PPDocLayoutModelHandler: pipeline for PaddlePaddle-family layout detection models
 * (PP-DocLayout, PP-DocLayoutV2, PP-DocLayoutV3, RT-DETR).
 */

import { BaseModelHandler } from '../base/index.js';
import { PPPreProcess }  from './pre_process.js';
import { PPPostProcess } from './post_process.js';
import {
  RapidLayoutOutput,
  ModelType,
  PP_DOCLAYOUT_PLUS_L_layout_merge_bboxes_mode,
  PP_DOCLAYOUTV2_layout_merge_bboxes_mode,
} from '../../utils/typings.js';
import { tensorToNumber } from '../../../../../utils/math_utils.js';

export class PPDocLayoutModelHandler extends BaseModelHandler {
  /**
   * @param {string[]}   labels
   * @param {number|Object} confThres
   * @param {number}     iouThres
   * @param {import('../../inference_engine/base.js').InferSession} session
   * @param {string}     modelType
   * @param {string}     layoutShapeMode
   */
  constructor(labels, confThres, iouThres, session, modelType, layoutShapeMode) {
    super();

    // ── Model-type–specific config ─────────────────────────────────────────
    let targetSize, layoutUnclipRatio = null, layoutMergeBboxesMode = null;

    if (modelType === ModelType.PP_DOCLAYOUT_PLUS_L) {
      targetSize            = [800, 800];
      layoutUnclipRatio     = [1.0, 1.0];
      layoutMergeBboxesMode = PP_DOCLAYOUT_PLUS_L_layout_merge_bboxes_mode;
    } else if ([ModelType.PP_DOCLAYOUTV2, ModelType.PP_DOCLAYOUTV3].includes(modelType)) {
      targetSize            = [800, 800];
      layoutUnclipRatio     = [1.0, 1.0];
      layoutMergeBboxesMode = PP_DOCLAYOUTV2_layout_merge_bboxes_mode;
    } else if (modelType === ModelType.PP_DOCLAYOUT_S) {
      targetSize = [480, 480];
    } else {
      // PP_DOCLAYOUT_L, PP_DOCLAYOUT_M, RT_DETR_L_*
      targetSize = [640, 640];
    }

    this.modelType        = modelType;
    this.imgSize           = targetSize;       // [H, W]
    this.layoutShapeMode   = layoutShapeMode;

    // ── Labels & Post-processor ──────────────────────────────────────────
    let finalLabels = labels;
    if (!finalLabels || finalLabels.length === 0) {
      if ([ModelType.PP_DOCLAYOUTV2, ModelType.PP_DOCLAYOUTV3].includes(modelType)) {
        // Standard 25 classes for V2/V3
        finalLabels = [
          'abstract', 'algorithm', 'aside_text', 'chart', 'content',
          'display_formula', 'doc_title', 'figure_title', 'footer', 'footer_image',
          'footnote', 'formula_number', 'header', 'header_image', 'image',
          'inline_formula', 'number', 'paragraph_title', 'reference', 'reference_content',
          'seal', 'table', 'text', 'vertical_text', 'vision_footnote'
        ];
      } else if (modelType === ModelType.PP_DOCLAYOUT_PLUS_L) {
        // Standard 20 classes for Plus
        finalLabels = [
          'paragraph_title', 'image', 'text', 'number', 'abstract',
          'content', 'figure_table_chart_title', 'formula', 'table', 'reference',
          'doc_title', 'footnote', 'header', 'algorithm', 'footer',
          'seal', 'chart', 'formula_number', 'aside_text', 'reference_content'
        ];
      } else {
        // Standard 23 classes for S/M/L
        finalLabels = [
          'paragraph_title', 'image', 'text', 'number', 'abstract',
          'content', 'figure_title', 'formula', 'table', 'table_title',
          'reference', 'doc_title', 'footnote', 'header', 'algorithm',
          'footer', 'seal', 'chart_title', 'chart', 'formula_number',
          'header_image', 'footer_image', 'aside_text'
        ];
      }
    }

    this.ppPreprocess  = new PPPreProcess(this.imgSize, modelType);
    this.ppPostprocess = new PPPostProcess(
      finalLabels,
      confThres,
      iouThres,
      {
        layoutMergeBboxesMode,
        layoutUnclipRatio,
        scaleSize: targetSize,
      },
    );

    this.session = session;
  }

  // ── call ───────────────────────────────────────────────────────────────────

  /**
   * Run the full pipeline on a batch of images.
   * @param {cv.Mat[]} oriImgList
   * @returns {Promise<import('../../utils/typings.js').RapidLayoutOutput[]>}
   */
  async call(oriImgList) {
    const t0 = performance.now();

    // 1. Preprocess — build batched inputs
    const imgInputList      = [];
    const scaleFactorList   = [];
    let [batchH, batchW]    = [0, 0];

    for (const oriImg of oriImgList) {
      const oriH = oriImg.rows;
      const oriW = oriImg.cols;

      const { data, shape } = this.ppPreprocess.call(oriImg);
      // shape: [1, 3, H, W]
      [, , batchH, batchW] = shape;
      imgInputList.push(data);

      scaleFactorList.push(
        this.imgSize[0] / oriH,  // h_scale
        this.imgSize[1] / oriW,  // w_scale
      );
    }

    // Concatenate batch: N images → [N, 3, H, W]
    const N = oriImgList.length;
    const singleLen = imgInputList[0].length;  // 3 * H * W
    const batchData = new Float32Array(N * singleLen);
    imgInputList.forEach((d, i) => batchData.set(d, i * singleLen));
    const batchShape = [N, 3, batchH, batchW];

    const scaleFactor = new Float32Array(scaleFactorList);

    // 2. Inference
    const batchPreds = await this.session.run(batchData, scaleFactor, batchShape);

    // 3. Format output → per-image dicts
    const batchOutputs = this._formatOutput(batchPreds);

    // 4. Post-process
    const resultList = [];
    let layoutShapeMode = this.layoutShapeMode;

    for (let i = 0; i < batchOutputs.length; i++) {
      const output = batchOutputs[i];
      const oriImg = oriImgList[i];
      const oriImgShape = [oriImg.rows, oriImg.cols];

      let masks = null;
      if ('masks' in output) {
        masks = output.masks;
      } else {
        layoutShapeMode = 'rect';
      }

      const datas = this.ppPostprocess.call(
        output.boxes,
        [oriImgShape[1], oriImgShape[0]],  // [W, H]
        masks,
        layoutShapeMode,
        output.maskH ?? 0,
        output.maskW ?? 0,
      );

      let boxes = [], polygonPoints = [], scores = [], classNames = [], orders = null;

      if (datas && datas.length > 0) {
        boxes         = datas.map(d => d.coordinate);
        polygonPoints = datas.map(d => d.polygon_points ?? null);
        scores        = datas.map(d => d.score);
        classNames    = datas.map(d => d.label);

        // S/M/L models have no native reading order and fall back to XY-Cut;
        // V2/V3/Plus-L emit model-native sequential order (matches Python baseline)

        // const isNativeOrderModel = [
        //   ModelType.PP_DOCLAYOUTV2,
        //   ModelType.PP_DOCLAYOUTV3,
        //   ModelType.PP_DOCLAYOUT_PLUS_L,
        // ].includes(this.modelType);
        // orders = isNativeOrderModel
        //   ? Array.from({ length: datas.length }, (_, i) => i)
        //   : null; // S/M/L: no native reading order — fallback to XY-Cut

        // INTENTIONAL - set orders = null for non-native-order models to trigger XY-Cut in post-processing;
  
        orders = null;

        // Drop polygon_points if any p is null (matches Python)
        if (polygonPoints.some(p => p === null)) polygonPoints = null;
      } else {
        orders = [];
      }

      const elapse = (performance.now() - t0) / 1000;

      resultList.push(new RapidLayoutOutput({
        img: oriImg,
        boxes,
        polygon_points: polygonPoints,
        class_names: classNames,
        scores,
        orders,
        elapse,
      }));
    }

    return resultList;
  }

  // ── _formatOutput ──────────────────────────────────────────────────────────

  /**
   * Convert raw ONNX output tensors to per-image dicts.
   * @param {import('onnxruntime-web').Tensor[]} pred
   * @returns {Array<{boxes?: Float32Array, masks?: any, class_id?: any}>}
   */
  _formatOutput(pred) {
    // ── SOLOv2 path: 4 outputs [boxes, class_ids, scores, masks] ────────────
    if (pred.length === 4) {
      // Single-image assumption; returns a 1-element array
      return [
        {
          class_id: [
            this._tensorData(pred[1]),
            this._tensorData(pred[2]),
          ],
          masks: this._tensorData(pred[3]),
        },
      ];
    }

    // ── Instance Segmentation: 3 outputs [boxes, box_nums, masks] ──────────
    // ── Standard detection:    2 outputs [boxes, box_nums]        ──────────
    const hasMasks = pred.length === 3;

    // Dynamically resolve tensors by their dimension length to prevent name sorting bugs
    let boxesTensor = pred[0];
    let boxNumsTensor = pred[1];
    let masksTensor = hasMasks ? pred[2] : null;

    if (pred[0] && pred[1]) {
      const dim0 = pred[0].dims ? pred[0].dims.length : (pred[0].length === 1 ? 1 : 2);
      const dim1 = pred[1].dims ? pred[1].dims.length : (pred[1].length === 1 ? 1 : 2);

      if (dim0 === 1 && dim1 >= 2) {
        // Swapped! e.g., ['box_nums', 'boxes']
        boxesTensor = pred[1];
        boxNumsTensor = pred[0];
      }
    }

    const allBoxesData  = this._tensorData(boxesTensor);   // [totalBoxes, 6]
    const boxNumsData   = this._tensorData(boxNumsTensor);    // [batchSize]
    const allMasksData  = hasMasks ? this._tensorData(masksTensor) : null;

    // Byte-offset slicing — determine mask H/W from tensor dims
    let maskH = 0, maskW = 0;
    if (hasMasks && masksTensor) {
      if (masksTensor.dims && masksTensor.dims.length >= 2) {
        maskH = masksTensor.dims[masksTensor.dims.length - 2];
        maskW = masksTensor.dims[masksTensor.dims.length - 1];
      } else {
        // Fallback: infer assuming square masks from total data length
        const totalBoxesFallback = Array.from(boxNumsData).reduce((a, b) => a + tensorToNumber(b), 0) || 1;
        maskH = Math.round(Math.sqrt(allMasksData.length / totalBoxesFallback));
        maskW = maskH;
      }
    }

    // Pre-compute totalBoxes and boxCols outside the loop (constant across batch)
    const totalBoxes = Array.from(boxNumsData).reduce((a, b) => a + tensorToNumber(b), 0) || 1;
    const boxCols  = Math.floor(allBoxesData.length / totalBoxes);

    const results = [];
    let boxIdxStart = 0;

    for (let idx = 0; idx < boxNumsData.length; idx++) {
      // Coerce BigInt to Number for arithmetic
      const np_boxes_num  = tensorToNumber(boxNumsData[idx]);
      const boxIdxEnd     = boxIdxStart + np_boxes_num;

      // Slice rows into 2D array to preserve columns
      const npBoxes2D = [];
      for (let i = 0; i < np_boxes_num; i++) {
        const start = (boxIdxStart + i) * boxCols;
        const end = start + boxCols;
        npBoxes2D.push(Array.from(allBoxesData.subarray ? allBoxesData.subarray(start, end) : allBoxesData.slice(start, end)));
      }

      if (hasMasks) {
        // Byte-offset slicing, not box-count slicing.
        // allMasksData is flat [totalBoxes * H * W]; each mask occupies H*W elements
        const maskStride = maskH * maskW; // byte-offset, not box-count
        const npMasks = [];
        for (let i = 0; i < np_boxes_num; i++) {
          const maskOffset = (boxIdxStart + i) * maskStride; // byte-offset
          npMasks.push(allMasksData.slice(maskOffset, maskOffset + maskStride));
        }
        results.push({ boxes: npBoxes2D, masks: npMasks, maskH, maskW });
      } else {
        results.push({ boxes: npBoxes2D });
      }

      boxIdxStart = boxIdxEnd;
    }

    return results;
  }

  /**
   * Safely extract data array from an ort.Tensor or return as-is.
   * @param {import('onnxruntime-web').Tensor|Float32Array} tensor
   * @returns {Float32Array|Int32Array|Uint8Array}
   */
  _tensorData(tensor) {
    return tensor?.data ?? tensor;
  }

  // ── BaseModelHandler overrides ─────────────────────────────────────────────

  preprocess(image) { return this.ppPreprocess.call(image); }

  postprocess(oriImgShape, image, preds) {
    return this.ppPostprocess.call(oriImgShape, image, preds);
  }
}
