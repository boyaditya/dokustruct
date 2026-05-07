// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: rapid_table_self/utils/typings.py → typings.js
// Python Enum + dataclass → JS Object.freeze + classes

/** @enum {string} */
export const EngineType = Object.freeze({
  ONNXRUNTIME: "onnxruntime",
  TORCH: "torch",
  OPENVINO: "openvino",
});

/** @enum {string} */
export const ModelType = Object.freeze({
  SLANETPLUS: "slanetplus",
  UNITABLE: "unitable",
  UNET: "unet",
  UNET_SLANET_PLUS: "unet_slanet_plus",
  UNET_UNITABLE: "unet_unitable",
  PADDLE_CLS: "paddle_cls",
  Q_CLS: "q_cls",
  PPSTRUCTURE_CH: "ppstructure_zh",
  PPSTRUCTURE_EN: "ppstructure_en",
});

/**
 * Input configuration for RapidTable.
 */
export class RapidTableInput {
  /**
   * @param {object} [params]
   * @param {string} [params.modelType]
   * @param {string|null} [params.modelDirOrPath]
   * @param {string} [params.engineType]
   * @param {object|null} [params.engineCfg]
   * @param {boolean} [params.useOcr]
   * @param {object|null} [params.ocrParams]
   */
  constructor({
    modelType = ModelType.PPSTRUCTURE_CH,
    modelDirOrPath = null,
    engineType = EngineType.ONNXRUNTIME,
    engineCfg = null,
    useOcr = false,
    ocrParams = null,
  } = {}) {
    this.modelType = modelType;
    this.modelDirOrPath = modelDirOrPath;
    this.engineType = engineType;
    this.engineCfg = engineCfg;
    this.useOcr = useOcr;
    this.ocrParams = ocrParams;
  }
}

/**
 * Output from RapidTable inference.
 */
export class RapidTableOutput {
  /**
   * @param {object} [params]
   * @param {ImageData[]} [params.imgs]
   * @param {string[]} [params.predHtmls]
   * @param {number[][]} [params.cellBboxes]
   * @param {number[][]} [params.logicPoints]
   * @param {number} [params.elapse]
   */
  constructor({
    imgs = [],
    predHtmls = [],
    cellBboxes = [],
    logicPoints = [],
    elapse = 0,
  } = {}) {
    this.imgs = imgs;
    this.predHtmls = predHtmls;
    this.cellBboxes = cellBboxes;
    this.logicPoints = logicPoints;
    this.elapse = elapse;
  }

  /**
   * Render visualization HTML string.
   * @returns {string}
   */
  vis() {
    if (!this.predHtmls.length) return "";
    return this.predHtmls[0];
  }
}
