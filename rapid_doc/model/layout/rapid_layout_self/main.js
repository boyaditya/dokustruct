/**
 * RapidLayout: the public-facing layout detection class.
 * Wraps inference engine and model handler for layout detection.
 * Session loading is async — uses static create factory instead of constructor.
 */

import { getEngine } from './inference_engine/base.js';
import { ModelHandler, ModelProcessor } from './model_handler/index.js';
import { LoadImage } from './utils/load_image.js';
import {
  ModelType,
  EngineType,
  RapidLayoutInput,
  PP_DOCLAYOUT_PLUS_L_Threshold,
  PP_DOCLAYOUTV2_Threshold,
  PP_DOCLAYOUT_L_Threshold,
} from './utils/typings.js';
import { getLogger } from './utils/logger.js';

const logger = getLogger('RapidLayout');

function isBatchInferenceFallbackError(err) {
  const message = String(err?.message ?? err ?? '').toLowerCase();
  return (
    message.includes('scale_factor') ||
    message.includes('tensor') ||
    message.includes('shape') ||
    message.includes('dimension') ||
    message.includes('data length') ||
    message.includes('inference failed')
  );
}

export class RapidLayout {
  /** @private — use static create */
  constructor() {
    /** @type {import('./inference_engine/base.js').InferSession} */
    this.session      = null;
    /** @type {ModelHandler} */
    this.modelHandler = null;
    /** @type {LoadImage} */
    this.loadImg      = new LoadImage();
  }

  /**
   * Create and initialise a RapidLayout instance.
   * @param {RapidLayoutInput|null} [cfg]
   * @returns {Promise<RapidLayout>}
   */
  static async create(cfg = null) {
    const instance = new RapidLayout();

    const resolvedCfg = cfg instanceof RapidLayoutInput ? cfg : new RapidLayoutInput(cfg ?? {});

    if (!resolvedCfg.conf_thresh) {
      const mt = resolvedCfg.model_type;
      if (mt === ModelType.PP_DOCLAYOUT_PLUS_L) {
        resolvedCfg.conf_thresh = PP_DOCLAYOUT_PLUS_L_Threshold;
      } else if (mt === ModelType.PP_DOCLAYOUTV2) {
        resolvedCfg.conf_thresh = PP_DOCLAYOUTV2_Threshold;
      } else if (mt === ModelType.PP_DOCLAYOUTV3) {
        resolvedCfg.conf_thresh = 0.3;
      } else if (mt === ModelType.PP_DOCLAYOUT_L) {
        resolvedCfg.conf_thresh = PP_DOCLAYOUT_L_Threshold;
      } else {
        resolvedCfg.conf_thresh = 0.5;
      }
    }

    if (!resolvedCfg.model_dir_or_path) {
      resolvedCfg.model_dir_or_path = ModelProcessor.getModelUrl(resolvedCfg.model_type);
    }

    const engineType = resolvedCfg.engine_type ?? EngineType.ONNXRUNTIME;
    const EngineClass = await getEngine(engineType);
    instance.session = await EngineClass.create(resolvedCfg);

    instance.modelHandler = new ModelHandler(resolvedCfg, instance.session);

    logger.info('RapidLayout ready.');
    return instance;
  }

  /**
   * Run layout detection on a list of image inputs.
   * @param {Array<string|ArrayBuffer|Uint8Array|cv.Mat>} imgContents
   * @param {number} [batchSize=1]
   * @param {Function} [onProgress] - (processed: number, total: number) => void
   * @returns {Promise<import('./utils/typings.js').RapidLayoutOutput[]>}
   */
  async call(imgContents, batchSize = 1, onProgress = null) {
    const imgs = [];
    for (const content of imgContents) {
      imgs.push(await this.loadImg.call(content));
    }

    const total = imgs.length;
    const batchResults = [];

    for (let i = 0; i < total; i += batchSize) {
      const batch = imgs.slice(i, i + batchSize);
      let results;
      try {
        results = await this.modelHandler.call(batch);
      } catch (err) {
        if (batch.length <= 1 || !isBatchInferenceFallbackError(err)) throw err;
        logger.warn(`Batch layout inference failed for ${batch.length} pages; retrying one page at a time: ${err.message}`);
        results = [];
        for (const image of batch) {
          const singleResult = await this.modelHandler.call([image]);
          results.push(...singleResult);
        }
      }
      batchResults.push(...results);

      if (onProgress) onProgress(Math.min(i + batchSize, total), total);
    }

    return batchResults;
  }
}
