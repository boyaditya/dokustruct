// Copyright (c) Opendatalab. All rights reserved.
// Copyright (c) Opendatalab. All rights reserved.
// PPTableStructurer: session + preprocess + postprocess pipeline
// __init__(cfg) → static async create(cfg)

import * as ort from "onnxruntime-web";
import { OrtInferSession } from "../../inference_engine/onnxruntime/main.js";
import { ModelProcessor } from "../../model_processor/main.js";
import { ModelType } from "../../utils/typings.js";
import { TablePreprocess } from "./pre_process.js";
import { TableLabelDecode } from "./post_process.js";
import { fetchAssetText } from "../../../../../utils/download_file.js";
import { disposeOutputMap } from "../../../../../utils/resource_utils.js";

/**
 * PP-Structure table structure recognizer.
 * PP-Structure table structure recognizer.
 */
export class PPTableStructurer {
  constructor() {
    this.session = null;
    this.preProcessor = null;
    this.postProcessor = null;
  }

  /**
   * @param {object} cfg
   * @param {string|Uint8Array|null} [cfg.model_dir_or_path]
   * @param {string} [cfg.model_type]
   * @param {number} [cfg.max_len=488]
   * @param {object} [cfg.engine_cfg]
   * @returns {Promise<PPTableStructurer>}
   */
  static async create(cfg = {}) {
    const inst = new PPTableStructurer();
    const modelType = cfg.model_type ?? ModelType.SLANETPLUS;
    const maxLen = cfg.max_len ?? 488;

    const modelBytes = await ModelProcessor.getModelPath(modelType, cfg.model_dir_or_path ?? null);
    inst.session = await OrtInferSession.create({
      model_dir_or_path: modelBytes,
      engine_cfg: cfg.engine_cfg ?? {},
    });

    inst.preProcessor = new TablePreprocess(maxLen);
    
    // Try get character list from model metadata
    let charList = inst.session.getCharacterList("character");
    
    // If empty, load from external dict file
    if (!charList || charList.length === 0) {
      const { HF_ASSET_BASE } = await import("../../../../../utils/model_url_map.js");
      const dictUrl = modelType === ModelType.PPSTRUCTURE_EN
        ? `${HF_ASSET_BASE}/table/table_structure_dict_en.txt`
        : `${HF_ASSET_BASE}/table/table_structure_dict_ch.txt`;
      
      try {
        const text = await fetchAssetText(dictUrl);
        charList = text.split('\n').filter(s => s.length > 0);
      } catch (err) {
        console.error('[PPTableStructurer] Failed to load dict file:', err);
        charList = [];
      }
    }
    
    inst.postProcessor = new TableLabelDecode(charList, { ...cfg, model_type: modelType });

    return inst;
  }

  /**
   * Run structure recognition on a batch of images.
   * Parity: return shape now includes per-image mean confidence scores
   * @param {cv.Mat[]} oriImgs
   * @returns {Promise<{ structures: string[][], cellBboxes: number[][][], scores: number[] }>}
   */
  async run(oriImgs) {
    // Preprocess
    const { data, dims, shapes } = this.preProcessor.runBatch(oriImgs);

    // Build tensors
    const inputNames = this.session.getInputNames();
    const inputTensor = new ort.Tensor("float32", data, dims);

    let inputFeed;
    if (inputNames.length === 1) {
      inputFeed = { [inputNames[0]]: inputTensor };
    } else {
      // Some models also take shape tensor
      const shapeTensor = new ort.Tensor(
        "float32",
        new Float32Array(shapes.flat()),
        [shapes.length, shapes[0].length]
      );
      inputFeed = { [inputNames[0]]: inputTensor, [inputNames[1]]: shapeTensor };
    }

    let outputMap = null;
    try {
      // Inference
      outputMap = await this.session.run(inputFeed);
      const outputNames = this.session.getOutputNames();

      // Python: bbox_preds, struct_probs = self.session(imgs)
      // Order: bbox_preds FIRST, struct_probs SECOND
      let structureProbs, bboxPreds = null;
      if (outputNames.length >= 2) {
        const out0 = outputMap[outputNames[0]];
        const out1 = outputMap[outputNames[1]];

        // Python order: bbox_preds, struct_probs
        bboxPreds = out0;
        structureProbs = out1;
      } else {
        structureProbs = outputMap[outputNames[0]];
      }

      // Postprocess
      return this.postProcessor.decode(bboxPreds, structureProbs, shapes, oriImgs);
    } finally {
      for (const t of Object.values(inputFeed)) {
        if (t?.dispose) t.dispose();
      }
      disposeOutputMap(outputMap);
    }
  }

  /**
   * Release the underlying ORT session.
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this.session && typeof this.session.dispose === 'function') {
      await this.session.dispose();
    }
    this.session = null;
  }
}

export default PPTableStructurer;
