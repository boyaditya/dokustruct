/**
 * OCR patch module — retained for structural parity with Python source tree.
 *
 * In the browser/onnxruntime-web context all Python-specific patches
 * (TextDetector preprocessing, PyTorch fusion, OpenVINO optimisations) are
 * either baked directly into the JS classes or not applicable.
 */

/**
 * Apply all OCR related patches.
 * NO-OP in the browser/onnxruntime-web port.
 */
export function applyOcrPatch() {
  // No-op: all patches are baked into the JS implementations.
}
