export class BaseModelHandler {
  /**
   * Run the model handler on a batch of images.
   * @param {cv.Mat[]} imgList
   * @returns {Promise<import('../../utils/typings.js').RapidLayoutOutput[]>}
   */
  async call(_imgList) {
    throw new Error(`${this.constructor.name}.call() not implemented`);
  }

  /** @param {cv.Mat} image */
  preprocess(_image) {
    throw new Error(`${this.constructor.name}.preprocess() not implemented`);
  }

  /** @param {...any} args */
  postprocess(..._args) {
    throw new Error(`${this.constructor.name}.postprocess() not implemented`);
  }
}
