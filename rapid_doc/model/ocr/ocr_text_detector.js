/**
 * TextDetector — batch DB text detection using ONNX inference.
 *
 * Handles batching by shape groups, GPU acquisition, and graceful
 * fallback to smaller batch sizes on inference failure.
 */

import * as ort from 'onnxruntime-web';
import { acquireGlobalGpu } from '../../utils/ort_runtime.js';
import { AbortException } from '../../utils/exceptions.js';
import { formatPipelineError } from '../../utils/browser_utils.js';

/**
 * Batch DB text detection.
 * Groups images by preprocessed shape and runs inference per group.
 */
export class TextDetector {
  constructor(session, detPreProcess, detPostProcess, { useWebGpu = true } = {}) {
    this.session = session;
    this.preProcess = detPreProcess;
    this.postProcess = detPostProcess;
    this._acquireGpu = acquireGlobalGpu;
    this.useWebGpu = useWebGpu;
  }

  /**
   * Single-image detection convenience method.
   * @param {cv.Mat} img
   * @returns {Promise<{ boxes: Array<Array<[number,number]>>|null, elapse: number }>}
   */
  async call(img) {
    const [result] = await this.callBatch([img]);
    return result ?? { boxes: null, elapse: 0 };
  }

  /**
   * Batch DB text detection.
   * @param {cv.Mat[]} imgList
   * @returns {Promise<Array<{boxes: Array<Array<[number,number]>>|null, elapse: number}>>}
   */
  async callBatch(imgList) {
    const results = new Array(imgList.length).fill(null);
    const items = this._preprocessBatch(imgList, results);
    const groups = this._groupByShape(items);

    for (const group of groups.values()) {
      await this._runBatchGroup(group, results);
    }

    return results.map(result => result ?? { boxes: null, elapse: 0 });
  }

  /** @private */
  _preprocessBatch(imgList, results) {
    const items = [];
    for (let index = 0; index < imgList.length; index++) {
      const img = imgList[index];
      const t0 = performance.now();
      try {
        if (!img || typeof img.rows !== 'number' || typeof img.cols !== 'number') {
          results[index] = { boxes: null, elapse: 0 };
          continue;
        }
        const { data, shape, ratio } = this.preProcess.call(img);
        items.push({ index, img, data, shape, ratio, t0 });
      } catch (err) {
        if (err instanceof AbortException) throw err;
        console.warn(formatPipelineError({
          stage: 'ocr', module: 'TextDetector', message: `preprocess failed: ${err?.message ?? err}`, recoverable: true,
        }));
        results[index] = { boxes: null, elapse: (performance.now() - t0) / 1000 };
      }
    }
    return items;
  }

  /** @private */
  _groupByShape(items) {
    const groups = new Map();
    for (const item of items) {
      const key = item.shape.slice(1).join('x');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return groups;
  }

  /** @private */
  async _runBatchGroup(group, output) {
    const inputName = this.session.inputNames?.[0] ?? 'x';
    const [, C, H, W] = group[0].shape.map(Number);
    const N = group.length;
    const sampleSize = C * H * W;
    const flat = new Float32Array(N * sampleSize);

    for (let b = 0; b < N; b++) {
      const { data, shape } = group[b];
      if (shape[1] !== C || shape[2] !== H || shape[3] !== W) {
        throw new Error('[TextDetector] mixed shapes in detector batch');
      }
      flat.set(data, b * sampleSize);
    }

    let results = null;
    let tensor = null;
    try {
      tensor = new ort.Tensor('float32', flat, [N, C, H, W]);
      const releaseGpu = this.useWebGpu ? await this._acquireGpu() : null;
      try {
        results = await this.session.run({ [inputName]: tensor });
      } finally {
        releaseGpu?.();
      }

      const predTensor = results instanceof Map
        ? results.values().next().value
        : Object.values(results)[0];

      if (!predTensor?.dims?.length) {
        console.warn(formatPipelineError({
          stage: 'ocr', module: 'TextDetector', message: 'inference returned no valid output tensor', recoverable: true,
        }));
        for (const item of group) {
          output[item.index] = { boxes: null, elapse: (performance.now() - item.t0) / 1000 };
        }
        return;
      }

      await this._postprocessBatchResults(predTensor, N, group, output);
    } catch (err) {
      if (err instanceof AbortException) throw err;
      console.warn(formatPipelineError({
        stage: 'ocr', module: 'TextDetector', message: `session.run failed for batch=${N}: ${err?.message ?? err}`, recoverable: true,
      }));
      if (N > 1) {
        this._disposeTensorAndResults(tensor, results);
        tensor = null;
        results = null;
        await this._retryWithSmallerBatches(group, output, N);
        return;
      }
      for (const item of group) {
        output[item.index] = { boxes: null, elapse: (performance.now() - item.t0) / 1000 };
      }
    } finally {
      this._disposeTensorAndResults(tensor, results);
    }
  }

  /** @private */
  async _postprocessBatchResults(predTensor, N, group, output) {
    // WebGPU: download data to CPU before post-processing
    const rawPredData = typeof predTensor.getData === 'function'
      ? await predTensor.getData()
      : predTensor.data;
    const predData = rawPredData instanceof Float32Array ? rawPredData : new Float32Array(rawPredData);
    const predDims = predTensor.dims.map(Number);
    const outN = predDims[0] ?? 1;
    if (outN !== N) {
      throw new Error(`[TextDetector] detector batch output mismatch: expected ${N}, got ${outN}`);
    }
    const perItemDims = [1, ...predDims.slice(1)];
    const perItemSize = perItemDims.slice(1).reduce((acc, dim) => acc * dim, 1);

    for (let b = 0; b < N; b++) {
      const item = group[b];
      try {
        const itemData = predData.subarray(b * perItemSize, (b + 1) * perItemSize);
        const boxes = this.postProcess.call(
          { dims: perItemDims, data: itemData },
          item.ratio,
          [item.img.rows, item.img.cols],
        );
        output[item.index] = {
          boxes: boxes.length > 0 ? boxes : null,
          elapse: (performance.now() - item.t0) / 1000,
        };
      } catch (err) {
        if (err instanceof AbortException) throw err;
        console.warn(formatPipelineError({
          stage: 'ocr', module: 'TextDetector', message: `postprocess failed: ${err?.message ?? err}`, recoverable: true,
        }));
        output[item.index] = { boxes: null, elapse: (performance.now() - item.t0) / 1000 };
      }
    }
  }

  /** @private */
  async _retryWithSmallerBatches(group, output, N) {
    const nextSize = Math.max(1, Math.floor(N / 2));
    for (let i = 0; i < group.length; i += nextSize) {
      await this._runBatchGroup(group.slice(i, i + nextSize), output);
    }
  }

  /** @private */
  _disposeTensorAndResults(tensor, results) {
    if (tensor?.dispose) tensor.dispose();
    if (results) {
      const values = results instanceof Map ? results.values() : Object.values(results);
      for (const t of values) {
        if (t?.dispose) t.dispose();
      }
    }
  }
}
