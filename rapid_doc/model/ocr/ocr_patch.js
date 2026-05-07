/**
 * PORTING NOTE: rapid_doc/model/ocr/ocr_patch.py → ocr_patch.js
 *
 * In Python this module monkey-patches the installed `rapidocr` library at
 * runtime to fix preprocessing bugs and improve inference performance for
 * different back-ends (ONNX, PyTorch, OpenVINO).
 *
 * IN THE BROWSER / ONNXRUNTIME-WEB CONTEXT:
 *   - There is no `rapidocr` npm package to patch.
 *   - PyTorch and OpenVINO are server-only runtimes; they do not exist in the
 *     browser.
 *   - The `TextDetector.get_preprocess` fix is incorporated directly into the
 *     JS DetPreProcess class inside rapid_ocr.js.
 *   - The `LearnableRepLayer._fuse_bn_tensor` patch affects PyTorch model
 *     weight fusion — not applicable to ONNX inference.
 *   - All patches therefore become no-ops; this file is retained purely for
 *     structural parity with the Python source tree.
 *
 * EXPORTS:
 *   applyOcrPatch() — no-op function, called at the top of rapid_ocr.js for
 *   parity. Does nothing in the JS port.
 */

/**
 * Apply all OCR related patches.
 * Mirrors: apply_ocr_patch()
 *
 * NO-OP in the browser/onnxruntime-web port.  All fixes are incorporated
 * directly into the respective JS classes.
 */
export function applyOcrPatch() {
  // No-op: all patches are either baked into the JS implementations
  // or are not applicable to browser/WASM inference.
}

/**
 * Fix TextDetector.get_preprocess.
 * Mirrors: patch_text_detector()
 *
 * Fix is incorporated into DetPreProcess constructor in rapid_ocr.js.
 * @deprecated Use rapid_ocr.js directly.
 */
export function patchTextDetector() { /* no-op */ }

/**
 * Apply PyTorch OCR optimisations.
 * Mirrors: patch_torch_ocr()
 *
 * Not applicable in the browser (no PyTorch runtime).
 * @deprecated Not applicable.
 */
export function patchTorchOcr() { /* no-op */ }

/**
 * Apply OpenVINO OCR optimisations.
 * Mirrors: patch_openvino_ocr()
 *
 * Not applicable in the browser (no OpenVINO runtime).
 * @deprecated Not applicable.
 */
export function patchOpenvinoOcr() { /* no-op */ }
