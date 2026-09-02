/**
 * RapidOcrModel: text detection + recognition pipeline using PaddleOCR ONNX models.
 *
 * Architecture:
 *   1. DB (Differentiable Binarization) text detector.
 *   2. CRNN text recognizer with CTC decoding.
 *
 * Browser-specific: uses onnxruntime-web with WebGPU/WASM execution providers.
 *
 * Sub-modules:
 *   - ocr_preprocess.js: DetPreProcess, RecPreProcess
 *   - ocr_postprocess.js: DetPostProcess, safeBoxPoints, unclipPolygon
 *   - ocr_text_detector.js: TextDetector
 *   - ocr_text_recognizer.js: TextRecognizer
 *   - ocr_ctc_decode.js: ctcDecode, getWordInfo
 *   - ocr_word_boxes.js: calRecBoxes
 *   - ocr_helpers.js: URL resolution, caching, char list utilities
 */

/* global cv */
import * as ort from 'onnxruntime-web';
import { getLogger } from '../../model/layout/rapid_layout_self/utils/logger.js';
import { checkImg, preprocessImage, sortedBoxes, mergeDetBoxes, updateDetBoxes, getRotateCropImage, sortPolyBoxes, cropByPolys } from '../../utils/ocr_utils.js';
import { configureOrtWasmRuntime } from '../../utils/ort_runtime.js';
import { deleteMat, deleteMatList } from '../../utils/resource_utils.js';
import { AbortException } from '../../utils/exceptions.js';
import { throwIfAborted } from '../../utils/abort_registry.js';
import { REC_BATCH_NUM, yieldToBrowser } from '../../utils/browser_utils.js';

import { DetPreProcess } from './ocr_preprocess.js';
import { DetPostProcess } from './ocr_postprocess.js';
import { TextDetector } from './ocr_text_detector.js';
import { TextRecognizer } from './ocr_text_recognizer.js';
import { calRecBoxes } from './ocr_word_boxes.js';
import {
  DEFAULT_DET_MODEL_URL,
  DEFAULT_REC_MODEL_URL_CH,
  DEFAULT_REC_MODEL_URL_EN,
  REMOTE_REC_MODEL_URL_EN_CANDIDATES,
  DEFAULT_SEAL_DET_MODEL_URL,
  DEFAULT_SEAL_DET_MODEL_SHA256,
  fetchArrayBufferCached,
  fetchTextCached,
  resolveDetUrl,
  buildDefaultCharList,
  prepareCtcCharacterList,
} from './ocr_helpers.js';

const logger = getLogger('RapidOcrModel');

// ─── RapidOcrModel ────────────────────────────────────────────────────────────

export class RapidOcrModel {
  /** @private */
  constructor() {
    /** @type {TextDetector} */ this.textDetector = null;
    /** @type {TextDetector|null} */ this._sealDetector = null;
    /** @type {TextRecognizer}*/ this.textRecognizer = null;
    this.dropScore = 0.5;
    this.enableMergeDetBoxes = true;
    // Porting fix: default recBatchNum; overridable via config.
    this.recBatchNum = REC_BATCH_NUM;
  }

  // ── Factory ─────────────────────────────────────────────────────────────────

  /**
   * Create and initialise a RapidOcrModel instance.
   * @param {object} [params={}]
   * @returns {Promise<RapidOcrModel>}
   */
  static async create(params = {}) {
    const inst = new RapidOcrModel();
    const cfg = params.ocrConfig || {};

    inst.dropScore = params.dropScore ?? cfg['Rec.drop_score'] ?? cfg.drop_score ?? cfg.dropScore ?? 0.5;
    inst.enableMergeDetBoxes = params.enableMergeDetBoxes ?? cfg.enable_merge_det_boxes ?? cfg.enableMergeDetBoxes ?? true;
    // recBatchNum default; overridable via config.
    inst.recBatchNum = params.recBatchNum ?? cfg['Rec.rec_batch_num'] ?? cfg.rec_batch_num ?? REC_BATCH_NUM;

    const epList = resolveExecutionProviders(params, cfg);
    const useWebGpu = epList.includes('webgpu');

    const sessOpts = buildSessionOptions(epList, useWebGpu);
    await configureOrtWasmRuntime({ numThreads: cfg.numThreads ?? 4, useWebGpu });

    const detSession = await inst._loadDetModel(sessOpts, resolveDetUrl(params, cfg));
    const detPre = new DetPreProcess(
      params.limitSideLen ?? cfg['Det.limit_side_len'] ?? cfg.limit_side_len ?? cfg.limitSideLen ?? 960,
      params.limitType ?? cfg['Det.limit_type'] ?? cfg.limit_type ?? cfg.limitType ?? 'max',
      params.mean ?? cfg.mean ?? [0.485, 0.456, 0.406],
      params.std ?? cfg.std ?? [0.229, 0.224, 0.225],
    );
    const detPost = new DetPostProcess(
      params.detDbThresh ?? cfg['Det.det_db_thresh'] ?? cfg.det_db_thresh ?? cfg.detDbThresh ?? 0.3,
      params.detDbBoxThresh ?? cfg['Det.det_db_box_thresh'] ?? cfg.det_db_box_thresh ?? cfg.detDbBoxThresh ?? 0.3,
      params.detDbUnclipRatio ?? cfg['Det.det_db_unclip_ratio'] ?? cfg.det_db_unclip_ratio ?? cfg.detDbUnclipRatio ?? 1.8,
      3,
      params.useDilation ?? cfg.use_dilation ?? cfg.useDilation ?? true,
      1000,
    );
    inst.textDetector = new TextDetector(detSession, detPre, detPost, { useWebGpu });

    // Porting fix: initialise seal detector when isSeal/is_seal param is set
    const isSealMode = params.isSeal === true || params.is_seal === true
      || cfg.isSeal === true || cfg.is_seal === true;
    if (isSealMode) {
      await inst._initSealDetector(sessOpts, useWebGpu);
    }

    const { session: recSession, charList } = await inst._loadRecModel(params, cfg, sessOpts, useWebGpu);
    inst.textRecognizer = new TextRecognizer(
      recSession, charList, inst.recBatchNum, [3, 48, 320], { useWebGpu },
    );

    logger.info('RapidOcrModel ready.');
    return inst;
  }

  // ── Model loading ───────────────────────────────────────────────────────────

  /** @private */
  async _loadDetModel(sessOpts, url) {
    logger.info(`Loading Det model: ${url}`);
    const detBuf = await fetchArrayBufferCached(url);
    try {
      return await ort.InferenceSession.create(detBuf, sessOpts);
    } catch (err) {
      const detail = (err instanceof Error) ? err.message : String(err);
      throw new Error(`ONNX session creation failed (OCR det): ${detail}`);
    }
  }

  /**
   * Initialise the seal-specific DB detector.
   * Porting fix: seal params — box_type='poly', limit_side_len=736,
   *   limit_type='min', unclip_ratio=0.5, box_thresh=0.6, thresh=0.3.
   * @private
   */
  async _initSealDetector(sessOpts, useWebGpu) {
    // TODO: replace null SHA-256 with the real hash once the model file is published.
    //   Expected SHA-256: e6109a1022b5ebf0822fc00646ef2398a7ef387390ca5c978de79352b1314204
    //   (stored in DEFAULT_SEAL_DET_MODEL_SHA256 in ocr_helpers.js)
    logger.info(`Loading Seal Det model: ${DEFAULT_SEAL_DET_MODEL_URL}`);
    const sealBuf = await fetchArrayBufferCached(DEFAULT_SEAL_DET_MODEL_URL);
    let sealSession;
    try {
      sealSession = await ort.InferenceSession.create(sealBuf, sessOpts);
    } catch (err) {
      const detail = (err instanceof Error) ? err.message : String(err);
      throw new Error(`ONNX session creation failed (OCR seal det): ${detail}`);
    }

    // Porting fix: seal-specific preprocessing params
    const sealPre = new DetPreProcess(
      736,       // limit_side_len
      'min',     // limit_type
      [0.485, 0.456, 0.406],
      [0.229, 0.224, 0.225],
    );

    // Porting fix: seal-specific postprocessing params
    // Porting fix: box_type='poly' — use polygons_from_bitmap path in DetPostProcess
    const sealPost = new DetPostProcess(
      0.3,   // thresh
      0.6,   // box_thresh
      0.5,   // unclip_ratio
      3,     // minSize
      false, // useDilation=false (matches Python Det.use_dilation=False for seals)
      1000,
      'poly', // FIX O2: poly box_type — extracts contour polygons instead of quads
    );

    this._sealDetector = new TextDetector(sealSession, sealPre, sealPost, { useWebGpu });
    logger.info('Seal detector ready.');
  }

  /** @private */
  async _loadRecModel(params, cfg, sessOpts, useWebGpu) {
    const recUrl = params.recModelUrl
      ?? (params.lang === 'en' ? DEFAULT_REC_MODEL_URL_EN : DEFAULT_REC_MODEL_URL_CH);
    logger.info(`Loading Rec model: ${recUrl}`);

    const recCandidates = [recUrl];
    if (params.lang === 'en' && !params.recModelUrl) {
      recCandidates.push(...REMOTE_REC_MODEL_URL_EN_CANDIDATES);
    }

    const recBuf = await fetchWithFallback(recCandidates);
    logger.info(`Loaded Rec model successfully.`);

    let session;
    try {
      session = await ort.InferenceSession.create(recBuf, sessOpts);
    } catch (err) {
      const detail = (err instanceof Error) ? err.message : String(err);
      throw new Error(`ONNX session creation failed (OCR rec): ${detail}`);
    }

    const charList = await this._resolveCharList(params, session);
    return { session, charList };
  }

  /** @private */
  async _resolveCharList(params, session) {
    if (params.charList) {
      return prepareCtcCharacterList(params.charList);
    }

    const dictUrl = params.lang === 'en'
      ? '/models/ocr/ppocrv5_en_dict.txt'
      : '/models/ocr/ppocrv5_dict.txt';
    logger.info(`Loading dictionary from: ${dictUrl}`);

    let charList = null;
    try {
      const dictBuf = await fetchTextCached(dictUrl);
      charList = dictBuf.split(/\r?\n/).filter(Boolean);
    } catch (err) {
      logger.warning(`Failed to load external dict: ${err.message}. Trying metadata.`);
    }

    if (!charList) {
      charList = loadCharListFromMeta(session);
    }
    if (!charList) {
      logger.warning('Failed to load dictionary and metadata. Using default.');
      charList = buildDefaultCharList();
    }

    return prepareCtcCharacterList(charList);
  }

  // ── OCR entry point ─────────────────────────────────────────────────────────

  /**
   * Run OCR on an image.
   * @param {cv.Mat|Uint8Array|ArrayBuffer|cv.Mat[]} img
   * @param {object} [opts]
   * @returns {Promise<Array|null>}
   */
  async ocr(img, opts = {}) {
    // Porting fix: seal branch — route to _ocrSeal when is_seal=true
    if (opts.is_seal === true) {
      const matImg = img instanceof cv.Mat ? img : checkImg(img);
      const shouldDeleteMat = !(img instanceof cv.Mat);
      try {
        const prepImg = preprocessImage(matImg);
        const deletePrep = prepImg !== matImg;
        try {
          return await this._ocrSeal(prepImg, opts);
        } finally {
          if (deletePrep) deleteMat(prepImg);
        }
      } finally {
        if (shouldDeleteMat) deleteMat(matImg);
      }
    }

    const { det = true, rec = true, mfdRes = null, returnWordBox = false } = opts;

    if (Array.isArray(img)) {
      if (!det && rec) return this._runRecOnly(img, opts);
      const results = [];
      for (const singleImg of img) {
        const res = await this.ocr(singleImg, opts);
        results.push(res);
      }
      return results;
    }

    const matImg = img instanceof cv.Mat ? img : checkImg(img);
    const shouldDeleteMat = !(img instanceof cv.Mat);

    try {
      const prepImg = preprocessImage(matImg);
      const deletePrep = prepImg !== matImg;

      try {
        if (det && rec) return await this._runDetRec(prepImg, mfdRes, opts);
        if (det && !rec) return await this._runDetOnly(prepImg, mfdRes, opts);
        if (!det && rec) return await this._runRecOnly(prepImg, opts);
        return null;
      } finally {
        if (deletePrep) deleteMat(prepImg);
      }
    } finally {
      if (shouldDeleteMat) deleteMat(matImg);
    }
  }

  // ── Detection + Recognition ─────────────────────────────────────────────────

  /** @private */
  async _runDetRec(img, mfdRes, opts = {}) {
    const { returnWordBox = false } = opts;

    const detRes = await this.textDetector.call(img);
    let dtBoxes = detRes.boxes;
    if (!dtBoxes) return [null];

    dtBoxes = sortedBoxes(dtBoxes);
    if (opts.enableMergeDetBoxes ?? this.enableMergeDetBoxes) {
      dtBoxes = mergeDetBoxes(dtBoxes);
    }
    if (mfdRes) dtBoxes = updateDetBoxes(dtBoxes, mfdRes);

    const crops = dtBoxes.map(box => getRotateCropImage(img, box));
    try {
      const recRes = await this.textRecognizer.call(crops, returnWordBox);

      if (returnWordBox && recRes.wordResults) {
        const wordResults = calRecBoxes(crops, dtBoxes, recRes);
        const result = [];
        for (let i = 0; i < dtBoxes.length; i++) {
          if (recRes.scores[i] >= this.dropScore) {
            result.push([dtBoxes[i].map(p => [...p]), [recRes.txts[i], recRes.scores[i], wordResults[i]]]);
          }
        }
        return [result];
      }

      const pairs = recRes.txts.map((txt, i) => [txt, recRes.scores[i]]);
      const result = dtBoxes
        .map((box, i) => [box, pairs[i]])
        .filter(([, [, score]]) => score >= this.dropScore)
        .map(([box, pair]) => [box.map(p => [...p]), pair]);
      return [result];
    } finally {
      deleteMatList(crops);
    }
  }

  // ── Detection only ──────────────────────────────────────────────────────────

  /** @private */
  async _runDetOnly(img, mfdRes, opts = {}) {
    const detRes = await this.textDetector.call(img);
    let dtBoxes = detRes.boxes;
    if (!dtBoxes) return [null];

    dtBoxes = sortedBoxes(dtBoxes);
    if (opts.enableMergeDetBoxes ?? this.enableMergeDetBoxes) {
      dtBoxes = mergeDetBoxes(dtBoxes);
    }
    if (mfdRes) dtBoxes = updateDetBoxes(dtBoxes, mfdRes);

    return [dtBoxes.map(box => box.map(p => [...p]))];
  }

  // ── Recognition only ────────────────────────────────────────────────────────

  /** @private */
  async _runRecOnly(img, opts = {}) {
    const { returnWordBox = false, oriImg = null, dtBoxes = null } = opts;

    const crops = Array.isArray(img) ? img : [img];
    const recRes = await this.textRecognizer.call(crops, returnWordBox);

    if (returnWordBox && recRes.wordResults) {
      if (oriImg && dtBoxes) {
        const wordResults = calRecBoxes(crops, dtBoxes, recRes);
        return [recRes.txts.map((txt, i) => [txt, recRes.scores[i], wordResults[i]])];
      }
      return [recRes.txts.map((txt, i) => [txt, recRes.scores[i], recRes.wordResults[i]])];
    }
    return [recRes.txts.map((txt, i) => [txt, recRes.scores[i]])];
  }

  // ── Seal OCR ────────────────────────────────────────────────────────────────

  /**
   * Run seal OCR on an image.
   * Porting fix: use seal-specific detection params and poly path.
   *
   * Seal detection uses `pp-ocrv4_mobile_seal_det.onnx` with:
   *   box_type='poly', limit_side_len=736, limit_type='min',
   *   unclip_ratio=0.5, box_thresh=0.6, thresh=0.3
   *
   * The detected poly boxes are sorted and cropped via
   * perspective warp before text recognition.
   *
   * @param {cv.Mat} image - preprocessed BGR Mat (caller must not delete before return)
   * @param {object} [opts]
   * @returns {Promise<Array>}
   */
  async _ocrSeal(image, opts = {}) {
    if (!this._sealDetector) {
      throw new Error(
        '[RapidOcrModel._ocrSeal] Seal detector not initialised. ' +
        'Pass isSeal=true (or is_seal=true) when calling RapidOcrModel.create().',
      );
    }

    // Detect with poly-mode detector
    const detRes = await this._sealDetector.call(image);
    const rawBoxes = detRes.boxes;

    if (!rawBoxes || rawBoxes.length === 0) {
      return [[]];
    }

    // Porting fix: sort polys by min-y then min-x (matches Python SortPolyBoxes)
    const sortedPolys = sortPolyBoxes(rawBoxes);

    // Porting fix: crop each polygon region for recognition
    const crops = cropByPolys(image, sortedPolys);
    try {
      const recRes = await this.textRecognizer.call(crops);
      const result = sortedPolys.map((poly, i) => [
        poly,
        [recRes.txts[i] ?? '', recRes.scores[i] ?? 0],
      ]);
      return [result];
    } finally {
      deleteMatList(crops);
    }
  }

  // ── Batch detection ─────────────────────────────────────────────────────────

  /**
   * Batch text detection on a list of images.
   * @param {cv.Mat[]} imgList
   * @param {number} [maxBatchSize=8]
   * @returns {Promise<Array<{boxes: Array|null, elapse: number}>>}
   */
  async detBatchPredict(imgList, maxBatchSize = 8) {
    if (!imgList.length) return [];
    const results = [];
    for (let i = 0; i < imgList.length; i += maxBatchSize) {
      throwIfAborted();
      const batch = imgList.slice(i, i + maxBatchSize);
      results.push(...await this.textDetector.callBatch(batch));
      await yieldToBrowser();
    }
    return results;
  }

  // ── Public recognition entry-point ──────────────────────────────────────────

  /**
   * Public recognition entry-point.
   * @param {cv.Mat[]} imgList
   * @param {Function} [onProgress]
   * @returns {Promise<{txts: string[], scores: number[], elapse: number}>}
   */
  async textRecognizerCall(imgList, onProgress = null) {
    const res = await this.textRecognizer.call(imgList);
    if (onProgress) onProgress(imgList.length, imgList.length);
    return res;
  }

  // ── Disposal ────────────────────────────────────────────────────────────────

  /**
   * Release the three ONNX sessions (det, rec, optional seal det).
   * After this call the wrapper is unusable. Idempotent.
   *
   * Important: ORT-Web's WebGPU JSEP only returns pooled buffers to the driver
   * when the underlying `ort.InferenceSession.release()` is awaited. Without
   * this, repeat runs accumulate VRAM and eventually trip
   * `createBuffer ... too large for the implementation`.
   *
   * If the WebGPU device is already lost, `release()` will throw
   * "cannot release session, invalid session id" because the session handles
   * are invalidated when the device dies. In that case we just null the
   * references and rely on JS GC.
   * @returns {Promise<void>}
   */
  async dispose() {
    let skipRelease = false;
    try {
      const mod = await import('../../utils/ort_runtime.js');
      skipRelease = mod.isGpuDeviceLost?.() === true;
    } catch { /* ignore */ }

    const sessions = [
      this.textDetector?.session,
      this.textRecognizer?.session,
      this._sealDetector?.session,
    ];
    for (const session of sessions) {
      if (!session) continue;
      if (skipRelease) continue;
      try {
        if (typeof session.release === 'function') {
          await session.release();
        } else if (typeof session.dispose === 'function') {
          await session.dispose();
        }
      } catch (err) {
        // Treat invalid-session-id as expected when the device was lost mid-run.
        const msg = String(err?.message ?? err);
        if (!msg.includes('invalid session id')) {
          logger.warning(`Failed to release OCR session: ${msg}`);
        }
      }
    }
    this.textDetector = null;
    this.textRecognizer = null;
    this._sealDetector = null;
  }
}

// ─── Private module-level helpers ─────────────────────────────────────────────

/**
 * Resolves execution provider list from params/config.
 */
function resolveExecutionProviders(params, cfg) {
  const requestedProvider = params.executionProvider ?? cfg.execution_provider ?? null;
  if (Array.isArray(params.executionProviders)) return params.executionProviders;
  if (Array.isArray(cfg.executionProviders)) return cfg.executionProviders;
  return requestedProvider === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'];
}

/**
 * Builds ONNX session options.
 *
 * Note: we explicitly do NOT request `preferredOutputLocation: 'gpu-buffer'`
 * for OCR det/rec on WebGPU. Both detector and recognizer call `getData()`
 * on every output and immediately convert to CPU `Float32Array`, so keeping
 * outputs on the GPU just adds buffer-pool pressure without speedup. With
 * gpu-buffer outputs the rec batch pool grew across runs and tripped a
 * `createBuffer ... too large for the implementation` device-lost on
 * mid-tier hardware — see ort_runtime.js for adapter limit handling.
 *
 * If a future profiling pass shows download cost dominates, this can be
 * re-enabled with explicit `tensor.toCpuBuffer()` + immediate `dispose()`.
 */
function buildSessionOptions(epList, _useWebGpu) {
  return {
    executionProviders: epList,
    logSeverityLevel: 4,
    graphOptimizationLevel: 'all',
  };
}

/**
 * Fetches a model buffer from a list of candidate URLs, trying each in order.
 * @param {string[]} candidates
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchWithFallback(candidates) {
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      return await fetchArrayBufferCached(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Failed to fetch OCR rec model from candidates: ${candidates.join(', ')}. ` +
    `Last error: ${lastErr?.message ?? lastErr}`,
  );
}

/**
 * Attempts to load character list from ONNX session metadata.
 * @param {ort.InferenceSession} session
 * @returns {string[]|null}
 */
function loadCharListFromMeta(session) {
  try {
    const metadata = session?.getMetaData?.() ?? session?.metadata ?? null;
    const meta = session?.customMetadataMap
      ?? metadata?.customMetadataMap
      ?? metadata?.custom_metadata_map
      ?? {};
    const raw = meta.character ?? meta.chars ?? meta.charset ?? '';
    const list = raw.split('\n').filter(Boolean);
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}
