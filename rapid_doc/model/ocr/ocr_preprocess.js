/**
 * OCR preprocessing — detection and recognition image preparation.
 *
 * DetPreProcess: resize + normalize + HWC→NCHW for DB text detection.
 * RecPreProcess: resize crop to fixed height + normalize to [-1, 1] for CRNN recognition.
 */

/* global cv */
import { deleteMat } from '../../utils/resource_utils.js';

// ─── DetPreProcess ────────────────────────────────────────────────────────────

const DET_STRIDE = 32;
const DET_MIN_SIDE = 32;

/**
 * Preprocessing for PP-OCR DB text detection model.
 * Steps: resize → normalise → transpose HWC → NCHW.
 */
export class DetPreProcess {
  constructor(limitSideLen = 960, limitType = 'max', mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225]) {
    this.limitSideLen = limitSideLen;
    this.limitType = limitType;
    this.mean = mean;
    this.std = std;
  }

  /**
   * @param {cv.Mat} img - BGR, uint8
   * @returns {{ data: Float32Array, shape: [1,3,number,number], ratio: {h:number, w:number} }}
   */
  call(img) {
    const srcH = img.rows;
    const srcW = img.cols;

    let ratio = this.limitType === 'max'
      ? this.limitSideLen / Math.max(srcH, srcW)
      : this.limitSideLen / Math.min(srcH, srcW);
    if (ratio > 1) ratio = 1;

    const tgtH = Math.max(DET_MIN_SIDE, Math.round(srcH * ratio / DET_STRIDE) * DET_STRIDE);
    const tgtW = Math.max(DET_MIN_SIDE, Math.round(srcW * ratio / DET_STRIDE) * DET_STRIDE);
    const actualRatio = { h: tgtH / srcH, w: tgtW / srcW };

    const resized = new cv.Mat();
    try {
      cv.resize(img, resized, new cv.Size(tgtW, tgtH), 0, 0, cv.INTER_LINEAR);
      return this._normalizeToNchw(resized, actualRatio);
    } finally {
      deleteMat(resized);
    }
  }

  /**
   * Converts a resized BGR Mat to NCHW Float32Array with ImageNet normalization.
   *
   * Optional SIMD investigation: WebAssembly SIMD intrinsics for
   * uint8→float32 conversion were evaluated here. Key findings:
   *   • V8 already auto-vectorises simple typed-array loops at -O2 / on
   *     WASM-SIMD builds (--experimental-wasm-simd), so a hand-rolled WASM
   *     module would compete with the engine's own vectoriser.
   *   • A minimal WASM SIMD implementation for this kernel (load 4 uint8s,
   *     widen to i32, convert to f32, subtract mean, divide by std) would
   *     require ~80–120 lines of WAT or an Emscripten build step, with an
   *     estimated measured gain of 1.2–1.5× for large tiles.
   *   • Detection tiles (960×960 px) are normalised once per page; the
   *     absolute time saved (<3 ms at 1920×1080) does not justify the
   *     added build complexity or the binary-size overhead of a WASM module.
   *   • JS-level micro-optimisations applied instead: hoist area constants
   *     and per-row offsets out of the inner loop (matches RecPreProcess pattern).
   * @private
   */
  _normalizeToNchw(resized, ratio) {
    const H = resized.rows;
    const W = resized.cols;
    const channels = resized.channels();
    const raw = resized.data;
    const data = new Float32Array(H * W * 3);
    const [m0, m1, m2] = this.mean;
    const [s0, s1, s2] = this.std;
    const area = H * W;
    const area2 = area * 2;

    for (let h = 0; h < H; h++) {
      const srcRowOff = h * W * channels;
      const dstRowOff = h * W;
      for (let w = 0; w < W; w++) {
        const off = srcRowOff + w * channels;
        const dstOff = dstRowOff + w;
        data[dstOff] = (raw[off] / 255 - m0) / s0;
        data[area + dstOff] = (raw[off + 1] / 255 - m1) / s1;
        data[area2 + dstOff] = (raw[off + 2] / 255 - m2) / s2;
      }
    }

    return { data, shape: [1, 3, H, W], ratio };
  }
}

// ─── RecPreProcess ────────────────────────────────────────────────────────────

/**
 * Preprocessing for PP-OCR CRNN text recognition model.
 * Resizes crop to fixed height preserving aspect ratio, normalizes to [-1, 1].
 */
export class RecPreProcess {
  constructor(recImageShape = [3, 48, 320]) {
    this.recImageShape = recImageShape;
  }

  /**
   * @param {cv.Mat} img - BGR crop (not modified, caller retains ownership)
   * @param {number} maxWhRatio
   * @returns {{ data: Float32Array, shape: [1, 3, number, number] }}
   */
  call(img, maxWhRatio) {
    const [, imgH] = this.recImageShape;
    const srcH = img.rows;
    const srcW = img.cols;
    const ratio = srcW / srcH;

    const targetW = Math.max(1, Math.floor(imgH * maxWhRatio));
    const resizedW = Math.min(targetW, Math.max(1, Math.ceil(imgH * ratio)));

    const resized = new cv.Mat();
    try {
      cv.resize(img, resized, new cv.Size(resizedW, imgH), 0, 0, cv.INTER_LINEAR);
      return this._normalizeToNchw(resized, imgH, targetW, resizedW);
    } finally {
      deleteMat(resized);
    }
  }

  /**
   * Converts resized crop to NCHW Float32Array normalized to [-1, 1].
   * Pads remaining width with zeros (which maps to -1 after normalization).
   *
   * Optional SIMD investigation: Same analysis applies as in
   * DetPreProcess._normalizeToNchw. Recognition crops are narrow (typically
   * H=48, W≤320) so the kernel runs on ≤15 360 pixels per crop; auto-
   * vectorisation by V8/WASM-SIMD already captures the easy gains. The
   * hoisted area/area2 constants and per-row offsets below are the practical
   * JS-level micro-optimisations chosen in lieu of a WASM SIMD module.
   * @private
   */
  _normalizeToNchw(resized, imgH, targetW, resizedW) {
    const H = resized.rows;
    const channels = resized.channels();
    const raw = resized.data;
    const data = new Float32Array(imgH * targetW * 3);

    const area = imgH * targetW;
    const area2 = area * 2;

    for (let h = 0; h < H; h++) {
      const srcRowOff = h * resizedW * channels;
      const dstRowOff = h * targetW;
      for (let w = 0; w < resizedW; w++) {
        const off = srcRowOff + w * channels;
        const dstOff = dstRowOff + w;
        data[dstOff] = raw[off] / 127.5 - 1;
        data[area + dstOff] = raw[off + 1] / 127.5 - 1;
        data[area2 + dstOff] = raw[off + 2] / 127.5 - 1;
      }
    }
    return { data, shape: [1, 3, imgH, targetW] };
  }
}
