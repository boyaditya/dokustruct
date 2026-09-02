export class BaseModelHandler {
  /**
   * Run the model handler on a batch of images.
   * @param {cv.Mat[]} imgList
   * @returns {Promise<import('../../utils/typings.js').RapidLayoutOutput[]>}
   */
  async call(imgList) {
    throw new Error(`${this.constructor.name}.call() not implemented`);
  }

  /** @param {cv.Mat} image */
  preprocess(image) {
    throw new Error(`${this.constructor.name}.preprocess() not implemented`);
  }

  /** @param {...any} args */
  postprocess(...args) {
    throw new Error(`${this.constructor.name}.postprocess() not implemented`);
  }
}
