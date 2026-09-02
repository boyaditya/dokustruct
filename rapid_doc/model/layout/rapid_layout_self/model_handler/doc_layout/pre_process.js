/**
 * DocLayoutPreProcess: resize with letterbox, flip channels BGR→RGB, transpose
 * HWC → NCHW, normalise to [0, 1].
 *
 * INPUT: cv.Mat (BGR, uint8, HWC)
 * OUTPUT: { data: Float32Array, shape: [1, 3, H, W] }
 *
 * The letterbox result Mat is deleted inside call (try/finally).
 */

import { LetterBox } from './utils.js';

export class DocLayoutPreProcess {
  /**
   * @param {[number, number]} imgSize - [H, W]
   */
  constructor(imgSize) {
    this.imgSize = imgSize;       // [H, W]
    this.letterbox = new LetterBox({
      newShape: imgSize,
      auto: false,
      stride: 32,
    });
  }

  /**
   * Preprocess a single image for DocLayout ONNX inference.
   * Mirrors: __call__(image: np.ndarray) -> np.ndarray
   *
   * @param {cv.Mat} image - Input BGR cv.Mat (not modified, caller retains ownership)
   * @returns {{ data: Float32Array, shape: [1, 3, number, number] }}
   */
  call(image) {
    const letterboxed = this.letterbox.call(image);
    let tensor;
    try {
      const [H, W] = [letterboxed.rows, letterboxed.cols];
      const channels = letterboxed.channels();  // should be 3 (BGR)

      // Read raw uint8 data from cv.Mat (HWC)
      const raw = new Uint8Array(
        letterboxed.data.buffer,
        letterboxed.data.byteOffset,
        H * W * channels,
      );

      // Build Float32 NCHW tensor: N=1, C=3, H, W
      // Python: input_img[..., ::-1] ← flip BGR→RGB then transpose
      const data = new Float32Array(H * W * 3);
      for (let h = 0; h < H; h++) {
        for (let w = 0; w < W; w++) {
          const srcOff = (h * W + w) * channels;
          // channels in OpenCV are BGR (idx 0=B, 1=G, 2=R)
          // Python reverses: ::-1 → R comes first
          const r = raw[srcOff + 2];   // channel 2 in BGR = R
          const g = raw[srcOff + 1];
          const b = raw[srcOff + 0];   // channel 0 in BGR = B

          // NCHW layout: channel 0 = R, channel 1 = G, channel 2 = B
          data[0 * H * W + h * W + w] = r / 255;
          data[1 * H * W + h * W + w] = g / 255;
          data[2 * H * W + h * W + w] = b / 255;
        }
      }

      tensor = { data, shape: /** @type {[1, 3, number, number]} */ ([1, 3, H, W]) };
    } finally {
      letterboxed.delete();
    }
    return tensor;
  }
}
