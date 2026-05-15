// Copyright (c) Opendatalab. All rights reserved.

/** @enum {string} */
export const EngineType = Object.freeze({
  ONNXRUNTIME: "onnxruntime",
  TORCH: "torch",
  OPENVINO: "openvino",
});

/** @enum {string} */
export const ModelType = Object.freeze({
  SLANETPLUS: "slanet_plus",
  SLANETPLUS_LEGACY: "slanetplus",
  UNITABLE: "unitable",
  UNET: "unet",
  UNET_SLANET_PLUS: "unet_slanet_plus",
  UNET_UNITABLE: "unet_unitable",
  PADDLE_CLS: "paddle_cls",
  Q_CLS: "q_cls",
  PADDLE_Q_CLS: "paddle_q_cls",
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
    model_type = null,
    modelType = null,
    model_dir_or_path = null,
    modelDirOrPath = null,
    engine_type = null,
    engineType = null,
    engine_cfg = null,
    engineCfg = null,
    useOcr = false,
    ocrParams = null,
  } = {}) {
    this.modelType = normalizeTableModelType(modelType ?? model_type ?? ModelType.UNET_SLANET_PLUS);
    this.model_type = this.modelType;
    this.modelDirOrPath = modelDirOrPath ?? model_dir_or_path;
    this.model_dir_or_path = this.modelDirOrPath;
    this.engineType = engineType ?? engine_type ?? EngineType.ONNXRUNTIME;
    this.engine_type = this.engineType;
    this.engineCfg = engineCfg ?? engine_cfg;
    this.engine_cfg = this.engineCfg;
    this.useOcr = useOcr;
    this.ocrParams = ocrParams;
  }
}

export function normalizeTableModelType(modelType) {
  if (modelType === ModelType.SLANETPLUS_LEGACY) return ModelType.SLANETPLUS;
  if (modelType === "slanetplus") return ModelType.SLANETPLUS;
  if (modelType === "slanet_plus") return ModelType.SLANETPLUS;
  return modelType;
}

/**
 * Output from RapidTable inference.
 */
export class RapidTableOutput {
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
