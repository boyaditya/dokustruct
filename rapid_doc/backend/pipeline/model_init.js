// Copyright (c) RapidAI. All rights reserved.
/**
 * PORTING NOTE: model_init.py → model_init.js
 *
 * WORKAROUND: Python __new__ singleton with synchronous model init
 * REASON: JS constructors cannot be async; model loading requires await
 * SOLUTION: W6 singleton pattern — static #instance, async getAtomModel()
 *
 * AFFECTED METHODS:
 *   AtomModelSingleton.__new__ → getInstance()
 *   AtomModelSingleton.get_atom_model → async getAtomModel()
 *   MineruPipelineModel.__init__ → static async create()
 *   atom_model_init → async atomModelInit()
 *   table_model_init → async tableModelInit()
 *   formula_model_init → async formulaModelInit()
 *   layout_model_init → async layoutModelInit()
 *   ocr_model_init → async ocrModelInit()
 */

import { AtomicModel } from "./model_list.js";
import { RapidLayoutModel } from "../../model/layout/rapid_layout.js";
import { RapidFormulaModel } from "../../model/formula/rapid_formula_model.js";
import { LatexOCRModel } from "../../model/formula/latex_ocr_model.js";
import { RapidOcrModel } from "../../model/ocr/rapid_ocr.js";
import { RapidTableModel } from "../../model/table/rapid_table.js";
import { RapidOrientationModel } from "../../model/orientation/rapid_orientation_model.js";
import { makeHashable } from "../../utils/hash_utils.js";

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
 * Keeps traversal narrow so large runtime data structures are not walked.
 * @param {any} resource
 * @param {WeakSet<object>} [seen]
 */
export async function disposeModelResource(resource, seen = new WeakSet()) {
  if (!resource || (typeof resource !== "object" && typeof resource !== "function")) return;
  if (seen.has(resource)) return;
  seen.add(resource);

  if (resource[DISPOSED_MARK]) return;
  try { resource[DISPOSED_MARK] = true; } catch { /* ignore non-extensible objects */ }

  for (const key of DISPOSABLE_KEYS) {
    if (resource[key] && resource[key] !== resource) {
      await disposeModelResource(resource[key], seen);
    }
  }

  for (const method of ["release", "dispose", "close"]) {
    if (typeof resource[method] === "function") {
      try {
        await resource[method]();
      } catch (err) {
        console.warn(`[disposeModelResource] ${method} failed:`, err?.message ?? err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Individual model init functions
// ---------------------------------------------------------------------------

/**
 * Initialize a table recognition model.
 * PORTING NOTE: table_model_init(lang, ocr_config, table_config) → async
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
  const modelType = formulaConfig?.modelType || 'pp_formulanet_plus_s';
  
  // Check if LaTeX-OCR is selected
  if (modelType === 'latex_ocr') {
    console.info('[formulaModelInit] Loading LaTeX-OCR (WebGPU-compatible)...');
    try {
      const useWebGpu = formulaConfig?.execution_provider !== "wasm";
      return await LatexOCRModel.create({
        useWebGpu,
        maxLen: formulaConfig?.maxLen ?? 512,
      });
    } catch (err) {
      console.error('[formulaModelInit] LaTeX-OCR failed to load:', err.message);
      console.warn('[formulaModelInit] Falling back to PP-FormulaNet Plus S...');
      // Fallback to PP-FormulaNet
      return RapidFormulaModel.create({
        ...formulaConfig,
        modelType: 'pp_formulanet_plus_s',
      });
    }
  }
  
  // Default: PP-FormulaNet
  console.info(`[formulaModelInit] Loading PP-FormulaNet (${modelType})...`);
  return RapidFormulaModel.create(formulaConfig);
}

/**
 * Initialize a layout detection model.
 * @param {object|null} layoutConfig
 * @returns {Promise<RapidLayoutModel>}
 */
export async function layoutModelInit(layoutConfig = null) {
  return RapidLayoutModel.create(layoutConfig);
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

export async function orientationModelInit(orientationConfig = null) {
  return RapidOrientationModel.create(orientationConfig ?? {});
}

/**
 * Dispatch atom model init by name.
 * PORTING NOTE: atom_model_init(model_name, **kwargs) → async atomModelInit(modelName, kwargs)
 * @param {string} modelName
 * @param {object} kwargs
 * @returns {Promise<any>}
 */
export async function atomModelInit(modelName, kwargs = {}) {
  let atomModel = null;

  if (modelName === AtomicModel.Layout) {
    atomModel = await layoutModelInit(kwargs.layout_config ?? null);

  } else if (modelName === AtomicModel.FORMULA) {
    const custom = (kwargs.formula_config ?? {}). custom_model;
    if (custom && typeof custom.predict === "function") {
      atomModel = custom;
    } else {
      atomModel = await formulaModelInit(kwargs.formula_config ?? null);
    }

  } else if (modelName === AtomicModel.OCR) {
    const custom = (kwargs.ocr_config ?? {}).custom_model;
    if (custom && typeof custom.predict === "function") {
      atomModel = custom;
    } else {
      atomModel = await ocrModelInit(
        kwargs.det_db_box_thresh ?? 0.3,
        kwargs.lang ?? null,
        kwargs.ocr_config ?? null,
        kwargs.det_db_unclip_ratio ?? 1.8,
        kwargs.enable_merge_det_boxes ?? true,
        kwargs.is_seal ?? false,
        kwargs.det_db_thresh ?? null
      );
    }

  } else if (modelName === AtomicModel.Table) {
    const custom = (kwargs.table_config ?? {}).custom_model;
    if (custom && typeof custom.predict === "function") {
      atomModel = custom;
    } else {
      atomModel = await tableModelInit(
        kwargs.lang ?? null,
        kwargs.ocr_config ?? null,
        kwargs.table_config ?? null
      );
    }

  } else if (modelName === AtomicModel.ImgOrientationCls) {
    atomModel = await orientationModelInit(kwargs.orientation_config ?? null);

  } else {
    throw new Error(`[atomModelInit] model name not allowed: ${modelName}`);
  }

  if (atomModel === null) {
    throw new Error(`[atomModelInit] model init failed for: ${modelName}`);
  }
  return atomModel;
}

// ---------------------------------------------------------------------------
// AtomModelSingleton — W6 pattern
// ---------------------------------------------------------------------------

/**
 * Singleton manager for all atomic models.
 * PORTING NOTE: AtomModelSingleton.__new__ (Python singleton) → JS static #instance W6 pattern.
 */
export class AtomModelSingleton {
  static #instance = null;
  #models = new Map();

  /**
   * @returns {AtomModelSingleton}
   */
  static getInstance() {
    if (!AtomModelSingleton.#instance) {
      AtomModelSingleton.#instance = new AtomModelSingleton();
    }
    return AtomModelSingleton.#instance;
  }

  /**
   * Get or lazily initialize an atom model by name + config key.
   * PORTING NOTE: get_atom_model(atom_model_name, **kwargs) → async getAtomModel(name, kwargs)
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

  static buildKey(atomModelName, kwargs = {}) {
    if (atomModelName === AtomicModel.Layout) {
      return JSON.stringify([atomModelName, makeHashable(kwargs.layout_config ?? null)]);
    } else if (atomModelName === AtomicModel.OCR) {
      const ocrLang = kwargs.lang ?? 'ch';
      return JSON.stringify([
        atomModelName,
        makeHashable(kwargs.ocr_config ?? null),
        kwargs.det_db_thresh ?? 0.3,
        kwargs.det_db_box_thresh ?? 0.3,
        ocrLang,
        kwargs.det_db_unclip_ratio ?? 1.8,
        kwargs.enable_merge_det_boxes ?? true,
        kwargs.is_seal ?? false,
      ]);
    } else if (atomModelName === AtomicModel.Table) {
      let ocrConfigClean = null;
      if (kwargs.ocr_config !== null && kwargs.ocr_config !== undefined) {
        ocrConfigClean = { ...kwargs.ocr_config };
        delete ocrConfigClean.custom_model;
      }
      return JSON.stringify([
        atomModelName,
        makeHashable(kwargs.table_config ?? null),
        kwargs.lang ?? null,
        makeHashable(ocrConfigClean),
      ]);
    } else if (atomModelName === AtomicModel.FORMULA) {
      return JSON.stringify([atomModelName, makeHashable(kwargs.formula_config ?? null)]);
    } else if (atomModelName === AtomicModel.ImgOrientationCls) {
      return JSON.stringify([atomModelName, makeHashable(kwargs.orientation_config ?? null)]);
    }
    return atomModelName;
  }

  /**
   * Dispose and remove cached atomic models.
   * @param {string|null} [keepKey]
   */
  async clear(keepKey = null) {
    for (const [key, value] of this.#models.entries()) {
      if (keepKey !== null && key === keepKey) continue;
      this.#models.delete(key);
      try {
        await disposeModelResource(await value);
      } catch (err) {
        console.warn("[AtomModelSingleton] failed to dispose model:", err?.message ?? err);
      }
    }
  }

  async clearByConfig(keepKey = null) {
    await this.clear(keepKey);
  }

  /**
   * Keep only the atomic model keys required by the active config.
   * @param {Set<string>} keepKeys
   */
  async retainKeys(keepKeys) {
    for (const [key, value] of this.#models.entries()) {
      if (keepKeys.has(key)) continue;
      this.#models.delete(key);
      try {
        await disposeModelResource(await value);
      } catch (err) {
        console.warn("[AtomModelSingleton] failed to dispose stale model:", err?.message ?? err);
      }
    }
  }

  async dispose() {
    await this.clear();
  }
}

// ---------------------------------------------------------------------------
// MineruPipelineModel
// ---------------------------------------------------------------------------

/**
 * Combined pipeline model holding layout, OCR, formula and table models.
 * PORTING NOTE: MineruPipelineModel.__init__(**kwargs) → static async create(kwargs)
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
    inst.applyTable = inst.tableConfig.enable ?? true;
    inst.lang = kwargs.lang ?? null;
    inst.device = kwargs.device ?? "cpu";

    console.info("[MineruPipelineModel] init started…");

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
        console.warn('[MineruPipelineModel] Formula model failed to load — formula recognition disabled.', err.message);
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
        console.warn('[MineruPipelineModel] Table model failed to load — table recognition disabled.', err.message);
        inst.applyTable = false;
      }
    }

    console.info("[MineruPipelineModel] init done!");
    return inst;
  }

  async dispose() {
    this.layoutModel = null;
    this.formulaModel = null;
    this.ocrModel = null;
    this.tableModel = null;
  }
}
