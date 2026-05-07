/**
 * model_handler/base/__init__.py → base/index.js
 * Mirrors the ABC base class with a runtime-only abstract enforcement.
 */

export class BaseModelHandler {
  /**
   * Run the model handler on a batch of images.
   * @param {cv.Mat[]} imgList
   * @returns {Promise<import('../../utils/typings.js').RapidLayoutOutput[]>}
   */
  async call(imgList) {          // mirrors __call__
    throw new Error(`${this.constructor.name}.call() not implemented`);
  }

  /** @param {cv.Mat} image */
  preprocess(image) {
    throw new Error(`${this.constructor.name}.preprocess() not implemented`);
  }

  /** @param  {...any} args */
  postprocess(...args) {
    throw new Error(`${this.constructor.name}.postprocess() not implemented`);
  }
}
