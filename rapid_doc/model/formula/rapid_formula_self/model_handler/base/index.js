// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: model_handler/base/__init__.py → base/index.js
// Python ABC abstract class → JS base class with abstract guards

/**
 * Abstract base class for all formula model handlers.
 * PORTING NOTE: BaseModelHandler ABC → JS with abstract method guards
 */
export class BaseModelHandler {
  /**
   * Run full inference: preprocess → session → postprocess.
   * @param {cv.Mat[]} oriImgList
   * @returns {Promise<import('../../utils/typings.js').RapidFormulaOutput[]>}
   */
  async run(oriImgList) {
    throw new Error("BaseModelHandler.run() is abstract");
  }

  /**
   * @param {cv.Mat[]} oriImgList
   * @returns {{ inputData: Object, imgShapes: number[][] }}
   */
  preprocess(oriImgList) {
    throw new Error("BaseModelHandler.preprocess() is abstract");
  }

  /**
   * @param {Object} preds
   * @returns {string[]}
   */
  postprocess(preds) {
    throw new Error("BaseModelHandler.postprocess() is abstract");
  }
}

export default BaseModelHandler;
