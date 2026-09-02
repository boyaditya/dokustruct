/**
 * OrtInferSession: ONNX Runtime Web inference session.
 * Uses static async create(cfg) factory pattern for async model loading.
 * Execution providers: ['webgpu', 'wasm'] in priority order.
 *
 * BROWSER WORKAROUND: Session loading is async (fetch + ArrayBuffer).
 * Model loaded via IndexedDB-cached fetch (download_file.js).
 * Threading controls are only effective when SharedArrayBuffer is available.
 */

import * as ort from 'onnxruntime-web';
import { InferSession, DEFAULT_ENGINE_CFG } from '../base.js';
import { ProviderConfig } from './provider_config.js';
import { EngineType } from '../../../../../utils/typings.js';
import { getLogger } from '../../../../../utils/logger.js';
import { downloadFile } from '../../../../../utils/download_file.js';
import { configureOrtWasmRuntime, acquireGlobalGpu } from '../../../../../utils/ort_runtime.js';
import { tensorDataToFloat64 } from '../../../../../utils/math_utils.js';

const logger = getLogger('OrtInferSession');

// ─── ONNXRuntimeError ─────────────────────────────────────────────────────────

export class ONNXRuntimeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ONNXRuntimeError';
  }
}

// ─── OrtInferSession ──────────────────────────────────────────────────────────

export class OrtInferSession extends InferSession {
  constructor() {
    super();
    /** @type {ort.InferenceSession|null} */
    this.session = null;
    this.logger = logger;
    this.useWebGpu = false;
  }

  // ── Factory ────────────────────────────────────────────────────────────────

  /**
   * Async factory.
   * Loads the model buffer from a URL (with IndexedDB caching), then
   * creates an ort.InferenceSession with the chosen execution providers.
   *
   * @param {import('../../../../../utils/typings.js').RapidLayoutInput} cfg
   * @returns {Promise<OrtInferSession>}
   */
  static async create(cfg) {
    const instance = new OrtInferSession();

    // ── Resolve model URL ───────────────────────────────────────────────────
    // Accept both camelCase and snake_case config keys from mixed ported paths.
    const modelUrl = cfg?.modelUrl ?? cfg?.model_dir_or_path ?? cfg?.modelDirOrPath ?? null;
    InferSession._verifyModel(modelUrl);
    logger.info(`Loading model from: ${modelUrl}`);

    const modelBuffer = await downloadFile(modelUrl);

    // ── Merge engine config ─────────────────────────────────────────────────
    // Python: self.engine_cfg[cfg.engine_type.value] (loaded from YAML at class level)
    const engineTypeKey = (cfg?.engineType ?? cfg?.engine_type ?? EngineType.ONNXRUNTIME);
    const baseCfg = DEFAULT_ENGINE_CFG[engineTypeKey] ?? DEFAULT_ENGINE_CFG[EngineType.ONNXRUNTIME];
    const engineCfg = InferSession.updateParams(baseCfg, cfg?.engineCfg ?? cfg?.engine_cfg ?? {});
    instance.engineCfg = engineCfg;

    // ── Session options ─────────────────────────────────────────────────────
    const sessOpts = OrtInferSession._initSessOpts(engineCfg);

    // ── Execution providers ─────────────────────────────────────────────────
    const providerCfg = new ProviderConfig(engineCfg);
    const epList = providerCfg.getEpList();
    instance.useWebGpu = epList.some(ep => (typeof ep === 'string' ? ep : ep?.name) === 'webgpu');

    // ── Create session ──────────────────────────────────────────────────────
    await configureOrtWasmRuntime({ numThreads: 4, useWebGpu: instance.useWebGpu });
    try {
      instance.session = await ort.InferenceSession.create(modelBuffer, {
        ...sessOpts,
        executionProviders: epList,
      });
      logger.info(`Session created. Input names: ${instance.getInputNames().join(', ')}`);
    } catch (err) {
      throw new ONNXRuntimeError(`Failed to create ONNX session: ${err.message}`);
    }

    // ── Verify providers ────────────────────────────────────────────────────
    // ort-web does not expose session.getProviders(), so we log the EP list
    logger.info(`Requested execution providers: ${JSON.stringify(epList)}`);

    return instance;
  }

  // ── _initSessOpts ──────────────────────────────────────────────────────────

  /**
   * Build ort SessionOptions from the engine config object.
   *
   * Note: intra_op/inter_op thread counts are respected by ort-web only when
   * SharedArrayBuffer is available (COOP/COEP headers). Otherwise they are
   * silently ignored.
   *
   * @param {Object} cfg
   * @returns {Partial<ort.InferenceSession.SessionOptions>}
   */
  static _initSessOpts(cfg) {
    /** @type {ort.InferenceSession.SessionOptions} */
    const opts = {
      logSeverityLevel: 4,
      graphOptimizationLevel: 'all', // ORT_ENABLE_ALL
      executionMode: 'sequential',
    };

    // Threading (only effective when SharedArrayBuffer is available)
    const intraThreads = cfg?.intra_op_num_threads ?? -1;
    if (intraThreads > 0) opts.intraOpNumThreads = intraThreads;

    const interThreads = cfg?.inter_op_num_threads ?? -1;
    if (interThreads > 0) opts.interOpNumThreads = interThreads;

    // Memory arena (not directly configurable in ort-web, noted for parity)
    // cfg.enable_cpu_mem_arena is recorded but has no ort-web equivalent
    if (cfg?.enable_cpu_mem_arena === false) {
      // ort-web does not expose this flag; logged for documentation
      logger.debug('enable_cpu_mem_arena=false is noted but has no effect in ort-web');
    }

    return opts;
  }

  // ── run ────────────────────────────────────────────────────────────────────

  /**
   * Run ONNX inference.
   *
   * @param {Float32Array} inputContent - Flat NCHW float32 tensor
   * @param {Float32Array|null} [scaleFactor] - Optional [N, 2] scale tensor
   * @param {number[]|null} [inputShape] - [N, C, H, W] — required when
   *                                            scaleFactor is provided
   * @returns {Promise<ort.Tensor[]>} Output tensors in output-name order
   */
  async run(inputContent, scaleFactor = null, inputShape = null) {
    const inputNames = this.getInputNames();
    const inputFeed = {};

    // ── Build input feed ───────────────────────────────────────────────────
    if (scaleFactor !== null) {
      // Multi-input model (e.g. PicoDet with im_shape + scale_factor)
      const shape = inputShape ?? this._inferInputShape(inputContent, inputNames[0]);
      const batch = Math.max(1, Number(shape?.[0]) || 1);
      const expectedScaleLength = batch * 2;
      if (scaleFactor.length !== expectedScaleLength) {
        throw new ONNXRuntimeError(
          `Invalid scale_factor length ${scaleFactor.length}; expected ${expectedScaleLength} for batch ${batch}.`,
        );
      }

      if (inputNames.includes('image')) {
        inputFeed['image'] = new ort.Tensor('float32', inputContent, shape);
      }
      if (inputNames.includes('scale_factor')) {
        inputFeed['scale_factor'] = new ort.Tensor('float32', scaleFactor, [batch, 2]);
      }
      if (inputNames.includes('im_shape')) {
        const h = shape[shape.length - 2];
        const w = shape[shape.length - 1];
        const imShape = new Float32Array(expectedScaleLength);
        for (let i = 0; i < batch; i++) {
          imShape[i * 2] = h;
          imShape[i * 2 + 1] = w;
        }
        // im_shape always [1, 2] (matches Python — first image H/W only)
        inputFeed['im_shape'] = new ort.Tensor('float32', imShape.slice(0, 2), [1, 2]);
      }
    } else {
      // Single-input model (standard layout detection)
      const shape = inputShape ?? this._inferInputShape(inputContent, inputNames[0]);
      inputFeed[inputNames[0]] = new ort.Tensor('float32', inputContent, shape);
    }

    // ── Execute with GPU Pipeline Optimization ─────────────────────────────
    let results;
    try {
      // GPU PIPELINE: Lock → Run → Release → Download (async overlap)
      // This pattern maximizes GPU utilization for batched layout detection
      const releaseGpu = this.useWebGpu ? await acquireGlobalGpu() : null;
      try {
        results = await this.session.run(inputFeed);
      } finally {
        // Release GPU immediately to allow next batch to start
        releaseGpu?.();
      }
      
      // ── Download WebGPU Data & Build Response ───
      // Download happens asynchronously, overlapping with next batch's inference
      const outputNames = this.getOutputNames();
      const finalOutputs = [];
      
      for (const name of outputNames) {
        const tensor = results[name];
        if (!tensor) continue;
        
        // Extract data from GPU if needed (async, overlaps with next inference)
        const rawData = typeof tensor.getData === 'function' ? await tensor.getData() : tensor.data;

        // int64 ONNX outputs arrive as BigInt64Array in onnxruntime-web; any downstream
        // arithmetic on them throws "TypeError: Cannot mix BigInt and other types".
        // tensorDataToFloat64 handles BigInt64Array safely and is a no-op for float arrays.
        const data = (rawData instanceof BigInt64Array || tensor.type === 'int64')
          ? tensorDataToFloat64(rawData)
          : rawData;

        // Store as a mock tensor object so downstream post-processors
        // can access .data and .dims without holding the WebGPU buffer open.
        finalOutputs.push({
          data: data.slice(), // clone data to ensure safe memory decoupling
          dims: tensor.dims,
          type: tensor.type === 'int64' ? 'float64' : tensor.type,
        });
      }
      return finalOutputs;
    } catch (err) {
      throw new ONNXRuntimeError(`Inference failed: ${err.message}\n${err.stack ?? ''}`);
    } finally {
      // ── Memory Cleanup (VRAM Leak Prevention) ───
      for (const t of Object.values(inputFeed)) {
        if (t?.dispose) t.dispose();
      }
      if (results) {
        for (const t of Object.values(results)) {
          if (t?.dispose) t.dispose();
        }
      }
    }
  }

  // ── Input shape inference ─────────────────────────────────────────────────

  /**
   * Attempt to infer the input tensor shape from the session metadata.
   * Falls back to [1, 3, H, W] guessing from the Float32Array length when no
   * shape metadata is available (dynamic shapes).
   *
   * @param {Float32Array} data
   * @param {string} inputName
   * @returns {number[]}
   */
  _inferInputShape(data, inputName) {
    try {
      const meta = this.session.inputNames
        ? this.session.inputs?.find(i => i.name === inputName)
        : null;

      if (meta?.dims && meta.dims.every(d => d > 0)) {
        return meta.dims;
      }
    } catch { /* ignore */ }

    // Heuristic: assume single-batch 3-channel square image
    const total = data.length;
    const channels = 3;
    const hw = Math.sqrt(total / channels);
    if (Number.isInteger(hw)) {
      return [1, channels, hw, hw];
    }

    // Non-square: try 4:3 aspect and common model sizes
    for (const h of [800, 768, 640, 512, 480, 384, 256]) {
      if (total % (channels * h) === 0) {
        const w = total / (channels * h);
        return [1, channels, h, w];
      }
    }

    logger.warning(
      `Cannot infer shape for input "${inputName}" from Float32Array length ${total}. ` +
      'Pass inputShape explicitly to run().',
    );
    return [1, channels, Math.round(Math.sqrt(total / channels)), Math.round(Math.sqrt(total / channels))];
  }

  // ── Input / output name helpers ────────────────────────────────────────────

  /**
   * @returns {string[]}
   */
  getInputNames() {
    return this.session.inputNames ? [...this.session.inputNames] : [];
  }

  /**
   * @returns {string[]}
   */
  getOutputNames() {
    return this.session.outputNames ? [...this.session.outputNames] : [];
  }

  // ── Model metadata ─────────────────────────────────────────────────────────

  /**
   * Read a character list stored in the model's custom metadata.
   *
   * @param {string} [key='character']
   * @returns {string[]}
   */
  getCharacterList(key = 'character') {
    const metadata = this.session?.getMetaData?.() ?? this.session?.metadata ?? null;
    const metaMap = this.session?.customMetadataMap
      ?? metadata?.customMetadataMap
      ?? metadata?.custom_metadata_map
      ?? {};
    const value = metaMap[key];
    if (!value) return [];
    return value.split('\n').filter(Boolean);
  }

  /**
   * Check whether a key exists in the model's custom metadata.
   *
   * @param {string} [key='character']
   * @returns {boolean}
   */
  haveKey(key = 'character') {
    const metadata = this.session?.getMetaData?.() ?? this.session?.metadata ?? null;
    const metaMap = this.session?.customMetadataMap
      ?? metadata?.customMetadataMap
      ?? metadata?.custom_metadata_map
      ?? {};
    return key in metaMap;
  }

  /** @returns {string[]} */
  get characters() {
    return this.getCharacterList();
  }
}
