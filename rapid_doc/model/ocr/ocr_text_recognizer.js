/**
 * TextRecognizer — batch CRNN text recognition with CTC decoding.
 *
 * Handles batching by width/height ratio, GPU acquisition, and
 * concurrent batch processing with configurable parallelism.
 */

import * as ort from 'onnxruntime-web';
import { acquireGlobalGpu } from '../../utils/ort_runtime.js';
import { AbortException } from '../../utils/exceptions.js';
import { isAborted } from '../../utils/abort_registry.js';
import { formatPipelineError, MAX_CONCURRENT_BATCHES, yieldToBrowser } from '../../utils/browser_utils.js';
import { RecPreProcess } from './ocr_preprocess.js';
import { ctcDecode, getWordInfo } from './ocr_ctc_decode.js';

// FIX P10: scale MAX_CONCURRENT_BATCHES based on detected device tier.
// User-provided recBatchNum config overrides this at the recognizer level.
//
// Note: the device tier is derived from system RAM (deviceMemory API), not
// VRAM. On WebGPU we conservatively cap concurrency at 2 — running many
// in-flight session.run promises means many simultaneous GPU buffer
// allocations, which on lower-end discrete GPUs can blow past the device's
// `maxBufferSize` and surface as a lost-device. The serialized global GPU
// mutex (see ort_runtime.js acquireGlobalGpu) only serializes the run
// itself; queueing the next inputs can still allocate.
function getMaxConcurrentBatches(useWebGpu) {
  if (useWebGpu) return Math.min(2, MAX_CONCURRENT_BATCHES);
  // WASM: ONNX Runtime session.run() is NOT thread-safe for concurrent calls
  // on the same session. The GPU mutex (acquireGlobalGpu) serialises WebGPU
  // calls; WASM has no equivalent protection. Cap at 1 to prevent corrupted
  // recognition output from interleaved session.run() invocations. Throughput
  // is preserved because recBatchNum (default 6) already batches multiple
  // crops into a single session.run() call, and the WASM thread pool handles
  // intra-call parallelism.
  return 1;
}

/**
 * Yield execution back to the browser event loop between OCR rec batches.
 * FIX P11: keeps the event loop responsive between non-critical OCR rec batches.
 *
 * NOTE: this used to call requestIdleCallback (falling back to setTimeout), but
 * both are heavily throttled — or suspended entirely — in hidden/background
 * tabs, which stalled OCR recognition (the heaviest stage) whenever the tab
 * lost focus. It now delegates to the shared MessageChannel-based
 * `yieldToBrowser`, which is NOT subject to background-tab throttling.
 * @returns {Promise<void>}
 */
function yieldToIdleCallback() {
  return yieldToBrowser();
}

/**
 * Batch CRNN text recognition with CTC decoding.
 */
export class TextRecognizer {
  constructor(session, charList, recBatchNum = 48, recImageShape = [3, 48, 320], { useWebGpu = true } = {}) {
    this.session = session;
    this.charList = charList;
    this.recBatchNum = recBatchNum;
    this.recImageShape = recImageShape;
    this.preProcess = new RecPreProcess(recImageShape);
    this._acquireGpu = acquireGlobalGpu;
    this.useWebGpu = useWebGpu;
  }

  /**
   * Recognise text in a list of image crops.
   * @param {cv.Mat[]} crops
   * @param {boolean} returnWordBox
   * @returns {Promise<{txts: string[], scores: number[], wordResults?: any[][], elapse: number}>}
   */
  async call(crops, returnWordBox = false) {
    const t0 = performance.now();
    const imgH = this.recImageShape[1];
    const imgW = this.recImageShape[2];

    crops = crops.filter(c => c != null && typeof c.cols === 'number' && typeof c.rows === 'number');
    if (!crops.length) return { txts: [], scores: [], wordResults: [], elapse: 0 };

    const ratioList = crops.map(c => c.cols / c.rows);
    const indices = [...ratioList.keys()].sort((a, b) => ratioList[a] - ratioList[b]);

    const txts = new Array(crops.length).fill('');
    const scores = new Array(crops.length).fill(0);
    const wordResults = returnWordBox ? new Array(crops.length).fill(null) : null;

    const batchTasks = this._buildBatchTasks(crops.length);

    const processBatch = async (task) => {
      await this._processSingleBatch(
        task, indices, crops, ratioList, imgH, imgW, returnWordBox, txts, scores, wordResults,
      );
    };

    await this._runWithConcurrency(batchTasks, processBatch);

    const elapse = (performance.now() - t0) / 1000;
    const result = { txts, scores, elapse };
    if (returnWordBox) result.wordResults = wordResults;
    return result;
  }

  /** @private */
  _buildBatchTasks(totalCrops) {
    const tasks = [];
    for (let beg = 0; beg < totalCrops; beg += this.recBatchNum) {
      tasks.push({ beg, end: Math.min(totalCrops, beg + this.recBatchNum) });
    }
    return tasks;
  }

  /** @private */
  async _processSingleBatch(task, indices, crops, ratioList, imgH, imgW, returnWordBox, txts, scores, wordResults) {
    const { beg, end } = task;
    const batchI = indices.slice(beg, end);
    const C = this.recImageShape[0];

    const maxWhRatio = batchI.reduce((m, i) => Math.max(m, ratioList[i]), imgW / imgH);

    const batchData = [];
    let batchW = 0;
    for (const i of batchI) {
      const { data, shape } = this.preProcess.call(crops[i], maxWhRatio);
      batchData.push(data);
      batchW = shape[3];
    }

    const N = batchI.length;
    const flat = new Float32Array(N * C * imgH * batchW);
    batchData.forEach((d, b) => flat.set(d, b * C * imgH * batchW));

    const { predData, T, numChars } = await this._runInference(flat, N, C, imgH, batchW);

    if (predData) {
      this._decodeBatchResults(predData, T, numChars, N, beg, batchI, indices, ratioList, maxWhRatio, returnWordBox, txts, scores, wordResults);
    }
  }

  /** @private */
  async _runInference(flat, N, C, imgH, batchW) {
    const recInputName = this.session.inputNames?.[0] ?? 'x';
    let res = null;
    let tensor = null;

    try {
      tensor = new ort.Tensor('float32', flat, [N, C, imgH, batchW]);

      const releaseGpu = this.useWebGpu ? await this._acquireGpu() : null;
      try {
        res = await this.session.run({ [recInputName]: tensor });
      } finally {
        releaseGpu?.();
      }

      if (tensor?.dispose) { tensor.dispose(); tensor = null; }

      const pred = res instanceof Map ? res.values().next().value : Object.values(res)[0];
      if (!pred?.dims?.length) throw new Error('[TextRecognizer] no valid output from rec session');

      const T = Number(pred.dims[pred.dims.length - 2]);
      const numChars = Number(pred.dims[pred.dims.length - 1]);

      const rawData = typeof pred.getData === 'function' ? await pred.getData() : pred.data;
      const predData = new Float32Array(rawData);

      return { predData, T, numChars };
    } catch (err) {
      if (err instanceof AbortException) throw err;
      console.warn(formatPipelineError({
        stage: 'ocr', module: 'TextRecognizer', message: `session.run failed: ${err?.message ?? err}`, recoverable: true,
      }));
      return { predData: null, T: 0, numChars: 0 };
    } finally {
      if (tensor?.dispose) tensor.dispose();
      if (res) {
        const values = res instanceof Map ? res.values() : Object.values(res);
        for (const t of values) {
          if (t?.dispose) t.dispose();
        }
      }
    }
  }

  /** @private */
  _decodeBatchResults(predData, T, numChars, N, beg, batchI, indices, ratioList, maxWhRatio, returnWordBox, txts, scores, wordResults) {
    for (let b = 0; b < N; b++) {
      const batchPred = predData.subarray(b * T * numChars, (b + 1) * T * numChars);
      const decoded = ctcDecode(batchPred, T, numChars, this.charList, returnWordBox);
      const origIdx = indices[beg + b];
      txts[origIdx] = decoded.text;
      scores[origIdx] = decoded.score;

      if (returnWordBox && decoded.validCols) {
        const lineTxtLen = T * ratioList[origIdx] / maxWhRatio;
        const wordInfo = getWordInfo(decoded.text, decoded.validCols);
        wordInfo.lineTxtLen = lineTxtLen;
        wordResults[origIdx] = wordInfo;
      }
    }
  }

  /** @private */
  async _runWithConcurrency(tasks, processFn) {
    const inFlight = new Set();
    let isFirstBatch = true;
    const cap = getMaxConcurrentBatches(this.useWebGpu);
    for (const task of tasks) {
      if (isAborted()) throw new AbortException();
      const p = processFn(task).finally(() => inFlight.delete(p));
      inFlight.add(p);
      if (inFlight.size >= cap) {
        await Promise.race(inFlight);
      }
      // FIX P11: first batch is critical — start immediately without yielding.
      // Subsequent batches are non-critical; yield to idle so the browser event
      // loop stays responsive between batches.
      if (isFirstBatch) {
        isFirstBatch = false;
      } else {
        await yieldToIdleCallback();
      }
    }
    await Promise.all(inFlight);
  }
}
