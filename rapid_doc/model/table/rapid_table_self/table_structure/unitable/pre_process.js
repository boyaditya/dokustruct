// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table_structure/unitable/pre_process.py → pre_process.js
// UniTable preprocessing: resize to 448×448, normalize.
// W2: cv.Mat cleanup in try/finally

const UNITABLE_MEAN = [0.86597056, 0.88463228, 0.87491467];
const UNITABLE_STD = [0.20686628, 0.18201602, 0.18485524];
const IMG_SIZE = 448;

/**
 * Preprocess image for UniTable model.
 * @param {cv.Mat} img - BGR uint8
 * @returns {{ data: Float32Array, dims: number[] }}
 */
export function unitablePreprocess(img) {
  let resized = new cv.Mat();
  let rgb = new cv.Mat();
  let float32 = new cv.Mat();
  try {
    cv.resize(img, resized, new cv.Size(IMG_SIZE, IMG_SIZE), 0, 0, cv.INTER_LINEAR);
    cv.cvtColor(resized, rgb, cv.COLOR_BGR2RGB);
    rgb.convertTo(float32, cv.CV_32F, 1.0 / 255.0);

    const src = float32.data32F;
    const out = new Float32Array(3 * IMG_SIZE * IMG_SIZE);
    for (let c = 0; c < 3; c++) {
      const mean = UNITABLE_MEAN[c], std = UNITABLE_STD[c];
      for (let i = 0; i < IMG_SIZE * IMG_SIZE; i++) {
        out[c * IMG_SIZE * IMG_SIZE + i] = (src[i * 3 + c] - mean) / std;
      }
    }
    return { data: out, dims: [1, 3, IMG_SIZE, IMG_SIZE] };
  } finally {
    resized.delete();
    rgb.delete();
    float32.delete();
  }
}

export default unitablePreprocess;
