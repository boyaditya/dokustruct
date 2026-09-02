/**
 * ModelHandler: routes between PPDocLayoutModelHandler and DocLayoutModelHandler
 * depending on cfg.modelType.
 */

import { PPDocLayoutModelHandler } from './pp_doclayout/index.js';
import { DocLayoutModelHandler }   from './doc_layout/index.js';
import { ModelType } from '../utils/typings.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('ModelHandler');

export class ModelHandler {
  /**
   * @param {import('../utils/typings.js').RapidLayoutInput} cfg
   * @param {import('../inference_engine/base.js').InferSession} session
   */
  constructor(cfg, session) {
    this.modelProcessors = this._initHandler(cfg, session);
  }

  /**
   * Initialise the correct sub-handler based on model type.
   * @param {import('../utils/typings.js').RapidLayoutInput} cfg
   * @param {import('../inference_engine/base.js').InferSession} session
   * @returns {import('./base/index.js').BaseModelHandler}
   */
  _initHandler(cfg, session) {
    const modelType = cfg.model_type ?? cfg.modelType;

    const characters = session.getCharacterList?.() ?? [];
    logger.info(`${modelType} contains ${characters.length} character entries`);

    if (modelType.startsWith('pp_doc') || modelType.startsWith('rt_detr')) {
      // Alias resolution order — snake_case (Python style) takes precedence over camelCase
      return new PPDocLayoutModelHandler(
        characters,
        cfg.conf_thresh ?? cfg.confThresh ?? 0.5,
        cfg.iou_thresh  ?? cfg.iouThresh  ?? 0.5,
        session,
        modelType,
        cfg.layout_shape_mode ?? cfg.layoutShapeMode ?? 'rect',
      );
    }

    if (modelType.startsWith('doclayout')) {
      // Alias resolution order — snake_case (Python style) takes precedence over camelCase
      return new DocLayoutModelHandler(
        characters,
        cfg.conf_thresh ?? cfg.confThresh ?? 0.5,
        cfg.iou_thresh  ?? cfg.iouThresh  ?? 0.5,
        session,
      );
    }

    throw new Error(`Model type "${modelType}" is not supported.`);
  }

  /**
   * @param {cv.Mat[]} imgList
   * @returns {Promise<import('../utils/typings.js').RapidLayoutOutput[]>}
   */
  async call(imgList) {
    return this.modelProcessors.call(imgList);
  }
}
