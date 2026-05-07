/**
 * PORTING NOTE: model_handler/main.py → main.js
 *
 * ModelHandler: routes between PPDocLayoutModelHandler and DocLayoutModelHandler
 * depending on cfg.modelType.
 *
 * CHANGE: Constructor is synchronous; session is already created before being
 * passed in. session.characters is now session.getCharacterList() (method call).
 *
 * CHANGE: __call__ → async call()
 *
 * CHANGE: model_type.value (Python Enum .value) → the JS string value directly
 * since our ModelType is Object.freeze({...}) and values are already strings.
 */

import { PPDocLayoutModelHandler } from './pp_doclayout/index.js';
import { DocLayoutModelHandler }   from './doc_layout/index.js';
import { ModelType } from '../utils/typings.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('ModelHandler');

export class ModelHandler {
  /**
   * @param {import('../utils/typings.js').RapidLayoutInput} cfg
   * @param {import('../inference_engine/base.js').InferSession}   session
   */
  constructor(cfg, session) {
    this.modelProcessors = this._initHandler(cfg, session);
  }

  /**
   * Initialise the correct sub-handler based on model type.
   * Mirrors: _init_handler(cfg, session)
   *
   * @param {import('../utils/typings.js').RapidLayoutInput} cfg
   * @param {import('../inference_engine/base.js').InferSession} session
   * @returns {import('./base/index.js').BaseModelHandler}
   */
  _initHandler(cfg, session) {
    const modelType = cfg.model_type ?? cfg.modelType;

    // characters = custom metadata list from ONNX model meta
    const characters = session.getCharacterList?.() ?? [];
    logger.info(`${modelType} contains ${characters.length} character entries`);

    if (modelType.startsWith('pp_doc') || modelType.startsWith('rt_detr')) {
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
      return new DocLayoutModelHandler(
        characters,
        cfg.confThresh ?? cfg.conf_thresh ?? 0.5,
        cfg.iouThresh  ?? cfg.iou_thresh  ?? 0.5,
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
