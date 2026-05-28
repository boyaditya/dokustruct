// Copyright (c) RapidAI. All rights reserved.

import { AtomicModel } from "./model_list.js";
import { RapidLayoutModel } from "../../model/layout/rapid_layout.js";
import { RapidFormulaModel } from "../../model/formula/rapid_formula_model.js";
import { LatexOCRModel } from "../../model/formula/latex_ocr_model.js";
import { RapidOcrModel } from "../../model/ocr/rapid_ocr.js";
import { RapidTableModel } from "../../model/table/rapid_table.js";
import { RapidOrientationModel } from "../../model/orientation/rapid_orientation_model.js";
import { makeHashable } from "../../utils/hash_utils.js";
import { formatPipelineError, detectProfile } from "../../utils/browser_utils.js";
import { AbortException } from "../../utils/exceptions.js";

const DISPOSED_MARK = Symbol.for("rapiddoc.disposed");
const DISPOSABLE_KEYS = [
  "session",
  "detSession",
  "recSession",
  "resizerSession",
  "encoderSession",
  "decoderSession",
  "textDetector",
  "textRecognizer",
  "layoutModel",
  "formulaModel",
  "ocrModel",
  "tableModel",
  "orientationEngine",
  "model",
  "_model",
  "_tableCls",
  "_wiredModel",
  "_wirelessModel",
  "_singleModel",
  "_structurer",
  "_cls",
];

/**
 * Best-effort cleanup for model wrappers and ORT sessions.
 * Traverses known disposable keys to release resources.
 * Uses a seen-set to prevent circular reference loops.
 * @param {any} resource
 * @param {WeakSet<object>} [seen]
 */
export async function disposeModelResource(resource, seen = new WeakSet()) {
  if (!resource || (typeof resource !== "object" && typeof resource !== "function")) return;
  if (seen.has(resource)) return;
  seen.add(resource);

  if (resource[DISPOSED_MARK]) return;
  try { resource[DISPOSED_MARK] = true; } catch { /* non-extensible objects */ }

  // If the WebGPU device is already lost, every ORT session referencing it
  // is invalid. Calling release() throws "invalid session id" which is just
  // noise. Skip release calls; JS GC will clean up the wrappers.
  let deviceLost = false;
  try {
    const mod = await import("../../utils/ort_runtime.js");
    deviceLost = mod.isGpuDeviceLost?.() === true;
  } catch { /* ignore */ }

  for (const key of DISPOSABLE_KEYS) {
    if (resource[key] && resource[key] !== resource) {
      await disposeModelResource(resource[key], seen);
    }
  }

  if (deviceLost) {
    // Skip method calls. Only null out fields so JS heap is released.
    return;
  }

  for (const method of ["release", "dispose", "close"]) {
    if (typeof resource[method] === "function") {
      try {
        await resource[method]();
      } catch (err) {
        const msg = String(err?.message ?? err);
        // Suppress known invalid-session noise; surface everything else.
        if (msg.includes("invalid session id")) continue;
        console.warn(formatPipelineError({
          stage: "dispose",
          module: "disposeModelResource",
          message: `${method}() failed: ${msg}`,
          recoverable: true,
        }));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Execution provider normalization helpers
// ---------------------------------------------------------------------------

function normalizeExecutionProvider(config = null) {
  return config?.execution_provider ?? config?.executionProvider ?? null;
}

function normalizeExecutionProviders(config = null) {
  const explicit = config?.executionProviders ?? config?.execution_providers ?? null;
  if (Array.isArray(explicit) && explicit.length) return explicit;
  return normalizeExecutionProvider(config) === "wasm" ? ["wasm"] : ["webgpu", "wasm"];
}

function withEngineProviderConfig(config = null) {
  const cfg = config ? { ...config } : {};
  const provider = normalizeExecutionProvider(cfg);
  if (provider) {
    cfg.engine_cfg = {
      ...(cfg.engine_cfg ?? cfg.engineCfg ?? {}),
      use_webgpu: provider !== "wasm",
    };
    cfg.engineCfg = cfg.engine_cfg;
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Individual model init functions
// ---------------------------------------------------------------------------

/**
 * Initialize a table recognition model.
 * @param {string|null} lang
 * @param {object|null} ocrConfig
 * @param {object|null} tableConfig
 * @returns {Promise<RapidTableModel>}
 */
export async function tableModelInit(lang = null, ocrConfig = null, tableConfig = null) {
  let ocrConfigClean = null;
  if (ocrConfig !== null) {
    ocrConfigClean = { ...ocrConfig };
    delete ocrConfigClean.custom_model;
  }
  const atomModelManager = AtomModelSingleton.getInstance();
  const ocrEngine = await atomModelManager.getAtomModel(AtomicModel.OCR, {
    det_db_thresh: ocrConfigClean?.["Det.det_db_thresh"] ?? ocrConfigClean?.det_db_thresh ?? 0.3,
    det_db_box_thresh: 0.5,
    det_db_unclip_ratio: 1.6,
    lang,
    ocr_config: ocrConfigClean,
    enable_merge_det_boxes: false,
  });
  return RapidTableModel.create(ocrEngine, tableConfig);
}

/**
 * Initialize a formula recognition model.
 * @param {object|null} formulaConfig
 * @returns {Promise<RapidFormulaModel|LatexOCRModel>}
 */
export async function formulaModelInit(formulaConfig = null) {
  // Browser default uses S model for cleaner/faster UI output.
  // Python parity callers should pass M explicitly.
  const modelType = formulaConfig?.modelType || "pp_formulanet_plus_s";

  if (modelType === "latex_ocr") {
    try {
      const useWebGpu = formulaConfig?.execution_provider !== "wasm";
      const latexConfig = { useWebGpu };
      if (formulaConfig?.maxLen != null) latexConfig.maxLen = formulaConfig.maxLen;
      return await LatexOCRModel.create(latexConfig);
    } catch (err) {
      if (err instanceof AbortException) throw err;
      console.warn(formatPipelineError({
        stage: "model-load",
        module: "formulaModelInit",
        message: `LaTeX-OCR failed: ${err.message}. Falling back to PP-FormulaNet.`,
        recoverable: true,
      }));
      return RapidFormulaModel.create({
        ...formulaConfig,
        modelType: "pp_formulanet_plus_s",
      });
    }
  }

  return RapidFormulaModel.create(formulaConfig);
}

/**
 * Initialize a layout detection model.
 * @param {object|null} layoutConfig
 * @returns {Promise<RapidLayoutModel>}
 */
export async function layoutModelInit(layoutConfig = null) {
  return RapidLayoutModel.create(withEngineProviderConfig(layoutConfig));
}

/**
 * Initialize an OCR model.
 * @param {number} [detDbBoxThresh=0.3]
 * @param {string|null} [lang]
 * @param {object|null} [ocrConfig]
 * @param {number} [detDbUnclipRatio=1.8]
 * @param {boolean} [enableMergeDetBoxes=true]
 * @param {boolean} [isSeal=false]
 * @param {number|null} [detDbThresh=null]
 * @returns {Promise<RapidOcrModel>}
 */
export async function ocrModelInit(
  detDbBoxThresh = 0.3,
  lang = null,
  ocrConfig = null,
  detDbUnclipRatio = 1.8,
  enableMergeDetBoxes = true,
  isSeal = false,
  detDbThresh = null
) {
  const preferredEp = ocrConfig?.execution_provider ?? null;
  const executionProviders = Array.isArray(ocrConfig?.executionProviders)
    ? ocrConfig.executionProviders
    : (preferredEp === "wasm" ? ["wasm"] : ["webgpu", "wasm"]);
  const resolvedDetDbThresh =
    detDbThresh ?? ocrConfig?.["Det.det_db_thresh"] ?? ocrConfig?.det_db_thresh ?? 0.3;

  return RapidOcrModel.create({
    detDbThresh: resolvedDetDbThresh,
    detDbBoxThresh,
    lang,
    ocrConfig,
    useDilation: true,
    detDbUnclipRatio,
    enableMergeDetBoxes,
    isSeal,
    detModelUrl: isSeal ? "/models/ocr/pp-ocrv4_mobile_seal_det.onnx" : undefined,
    executionProvider: preferredEp,
    executionProviders,
  });
}

/**
 * Initialize an orientation classification model.
 * @param {object|null} orientationConfig
 * @returns {Promise<RapidOrientationModel>}
 */
export async function orientationModelInit(orientationConfig = null) {
  return RapidOrientationModel.create({
    ...(orientationConfig ?? {}),
    executionProviders: normalizeExecutionProviders(orientationConfig),
  });
}

/**
 * Dispatch atom model init by name.
 * @param {string} modelName
 * @param {object} kwargs
 * @returns {Promise<any>}
 */
export async function atomModelInit(modelName, kwargs = {}) {
  if (modelName === AtomicModel.Layout) {
    return layoutModelInit(kwargs.layout_config ?? null);
  }

  if (modelName === AtomicModel.FORMULA) {
    const custom = (kwargs.formula_config ?? {}).custom_model;
    if (custom && typeof custom.predict === "function") return custom;
    return formulaModelInit(kwargs.formula_config ?? null);
  }

  if (modelName === AtomicModel.OCR) {
    const custom = (kwargs.ocr_config ?? {}).custom_model;
    if (custom && typeof custom.predict === "function") return custom;
    return ocrModelInit(
      kwargs.det_db_box_thresh ?? 0.3,
      kwargs.lang ?? null,
      kwargs.ocr_config ?? null,
      kwargs.det_db_unclip_ratio ?? 1.8,
      kwargs.enable_merge_det_boxes ?? true,
      kwargs.is_seal ?? false,
      kwargs.det_db_thresh ?? null
    );
  }

  if (modelName === AtomicModel.Table) {
    const custom = (kwargs.table_config ?? {}).custom_model;
    if (custom && typeof custom.predict === "function") return custom;
    return tableModelInit(
      kwargs.lang ?? null,
      kwargs.ocr_config ?? null,
      kwargs.table_config ?? null
    );
  }

  if (modelName === AtomicModel.ImgOrientationCls) {
    return orientationModelInit(kwargs.orientation_config ?? null);
  }

  throw new Error(`[atomModelInit] model name not allowed: ${modelName}`);
}

// ---------------------------------------------------------------------------
// AtomModelSingleton — W6 singleton pattern
// ---------------------------------------------------------------------------

/**
 * Singleton manager for all atomic models.
 * Caches model instances by a deterministic key derived from model name + config.
 */
export class AtomModelSingleton {
  static #instance = null;
  #models = new Map();

  /** @returns {AtomModelSingleton} */
  static getInstance() {
    if (!AtomModelSingleton.#instance) {
      AtomModelSingleton.#instance = new AtomModelSingleton();
    }
    return AtomModelSingleton.#instance;
  }

  /**
   * Get or lazily initialize an atom model by name + config key.
   * @param {string} atomModelName
   * @param {object} [kwargs]
   * @returns {Promise<any>}
   */
  async getAtomModel(atomModelName, kwargs = {}) {
    const key = AtomModelSingleton.buildKey(atomModelName, kwargs);

    if (!this.#models.has(key)) {
      const initPromise = atomModelInit(atomModelName, kwargs);
      this.#models.set(key, initPromise);
    }
    return await this.#models.get(key);
  }

  /**
   * Build a deterministic cache key for a model name + config combination.
   * @param {string} atomModelName
   * @param {object} kwargs
   * @returns {string}
   */
  static buildKey(atomModelName, kwargs = {}) {
    if (atomModelName === AtomicModel.Layout) {
      return JSON.stringify([atomModelName, makeHashable(kwargs.layout_config ?? null)]);
    }

    if (atomModelName === AtomicModel.OCR) {
      return JSON.stringify([
        atomModelName,
        makeHashable(kwargs.ocr_config ?? null),
        kwargs.det_db_thresh ?? 0.3,
        kwargs.det_db_box_thresh ?? 0.3,
        kwargs.lang ?? "ch",
        kwargs.det_db_unclip_ratio ?? 1.8,
        kwargs.enable_merge_det_boxes ?? true,
        kwargs.is_seal ?? false,
      ]);
    }

    if (atomModelName === AtomicModel.Table) {
      let ocrConfigClean = null;
      if (kwargs.ocr_config != null) {
        ocrConfigClean = { ...kwargs.ocr_config };
        delete ocrConfigClean.custom_model;
      }
      return JSON.stringify([
        atomModelName,
        makeHashable(kwargs.table_config ?? null),
        kwargs.lang ?? null,
        makeHashable(ocrConfigClean),
      ]);
    }

    if (atomModelName === AtomicModel.FORMULA) {
      return JSON.stringify([atomModelName, makeHashable(kwargs.formula_config ?? null)]);
    }

    if (atomModelName === AtomicModel.ImgOrientationCls) {
      return JSON.stringify([atomModelName, makeHashable(kwargs.orientation_config ?? null)]);
    }

    return atomModelName;
  }

  /**
   * Dispose and remove cached atomic models.
   * @param {string|null} [keepKey] - Optional key to retain (not disposed)
   */
  async clear(keepKey = null) {
    const seen = new WeakSet();
    for (const [key, value] of this.#models.entries()) {
      if (keepKey !== null && key === keepKey) continue;
      this.#models.delete(key);
      try {
        await disposeModelResource(await value, seen);
      } catch (err) {
        console.warn(formatPipelineError({
          stage: "dispose",
          module: "AtomModelSingleton",
          message: `Failed to dispose model [${key}]: ${err?.message ?? err}`,
          recoverable: true,
        }));
      }
    }
  }

  /**
   * Keep only the atomic model keys required by the active config.
   * @param {Set<string>} keepKeys
   */
  async retainKeys(keepKeys) {
    const seen = new WeakSet();
    for (const [key, value] of this.#models.entries()) {
      if (keepKeys.has(key)) continue;
      this.#models.delete(key);
      try {
        await disposeModelResource(await value, seen);
      } catch (err) {
        console.warn(formatPipelineError({
          stage: "dispose",
          module: "AtomModelSingleton",
          message: `Failed to dispose stale model [${key}]: ${err?.message ?? err}`,
          recoverable: true,
        }));
      }
    }
  }

  /** Dispose all cached models. */
  async dispose() {
    await this.clear();
  }
}

// ---------------------------------------------------------------------------
// MineruPipelineModel
// ---------------------------------------------------------------------------

/**
 * Combined pipeline model holding layout, OCR, formula and table models.
 * Manages the full set of models needed for one pipeline run.
 */
export class MineruPipelineModel {
  constructor() {
    this.layoutModel = null;
    this.formulaModel = null;
    this.ocrModel = null;
    this.tableModel = null;
    this.applyFormula = true;
    this.applyTable = true;
    this.lang = null;
    this.device = "cpu";
    this.performanceProfile = detectProfile();
  }

  /**
   * @param {object} [kwargs]
   * @returns {Promise<MineruPipelineModel>}
   */
  static async create(kwargs = {}) {
    const inst = new MineruPipelineModel();
    inst.layoutConfig = kwargs.layout_config ?? null;
    inst.ocrConfig = kwargs.ocr_config ?? null;
    inst.formulaConfig = kwargs.formula_config ?? {};
    inst.applyFormula = inst.formulaConfig.enable ?? true;
    inst.tableConfig = kwargs.table_config ?? {};
    inst.orientationConfig = kwargs.orientation_config ?? {};
    inst.applyTable = inst.tableConfig.enable ?? true;
    inst.lang = kwargs.lang ?? null;
    inst.device = kwargs.device ?? "cpu";

    const atomModelManager = AtomModelSingleton.getInstance();

    inst.layoutModel = await atomModelManager.getAtomModel(AtomicModel.Layout, {
      device: inst.device,
      layout_config: inst.layoutConfig,
    });

    if (inst.applyFormula) {
      try {
        inst.formulaModel = await atomModelManager.getAtomModel(AtomicModel.FORMULA, {
          device: inst.device,
          formula_config: inst.formulaConfig,
        });
      } catch (err) {
        if (err instanceof AbortException) throw err;
        console.warn(formatPipelineError({
          stage: "model-load",
          module: "MineruPipelineModel",
          message: `Formula model failed to load — formula recognition disabled. ${err.message}`,
          recoverable: true,
        }));
        inst.applyFormula = false;
      }
    }

    inst.ocrModel = await atomModelManager.getAtomModel(AtomicModel.OCR, {
      det_db_thresh: inst.ocrConfig?.["Det.det_db_thresh"] ?? inst.ocrConfig?.det_db_thresh ?? 0.3,
      det_db_box_thresh: 0.3,
      lang: inst.lang,
      ocr_config: inst.ocrConfig,
    });

    if (inst.applyTable) {
      try {
        inst.tableModel = await atomModelManager.getAtomModel(AtomicModel.Table, {
          lang: inst.lang,
          ocr_config: inst.ocrConfig,
          table_config: inst.tableConfig,
        });
      } catch (err) {
        if (err instanceof AbortException) throw err;
        console.warn(formatPipelineError({
          stage: "model-load",
          module: "MineruPipelineModel",
          message: `Table model failed to load — table recognition disabled. ${err.message}`,
          recoverable: true,
        }));
        inst.applyTable = false;
      }
    }

    return inst;
  }

  /**
   * Release references held by this pipeline model.
   * Does NOT deeply dispose the underlying model instances — those are owned
   * by AtomModelSingleton and disposed via retainKeys()/clear().
   */
  async dispose() {
    this.layoutModel = null;
    this.formulaModel = null;
    this.ocrModel = null;
    this.tableModel = null;
  }
}
