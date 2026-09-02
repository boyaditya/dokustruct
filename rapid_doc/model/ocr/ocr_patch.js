/**
 * OCR patch registry — documents the parity status of every OCR-related patch
 * between the Python RapidDoc baseline and this JS/browser port.
 *
 *   This module provides:
 *   (a) accurate documentation of patches already baked into the JS implementation,
 *   (b) patches not yet ported and the rationale for deferral, and
 *   (c) a queryable API via `getOcrPatchStatus()`.
 *
 * Patch ID convention: O1, O2, ... sequential IDs grouped by subsystem.
 * Status values: 'ported' | 'deferred' | 'not_applicable'
 */

// ─── Patch registry ───────────────────────────────────────────────────────────

/**
 * Canonical list of OCR patches tracked for Python→JS parity.
 *
 * @typedef {Object} OcrPatchDescriptor
 * @property {string} id - Patch ID (e.g. 'O1')
 * @property {string} name - Human-readable patch name
 * @property {'ported'|'deferred'|'not_applicable'} status
 * @property {string} jsFile - Primary JS file that implements/defers the patch
 * @property {string} pyRef - Corresponding Python module / function reference
 * @property {string} notes - Implementation notes and links to related fixes
 */

/** @type {OcrPatchDescriptor[]} */
const OCR_PATCHES = Object.freeze([
  {
    id: 'O1',
    name: 'Seal OCR mode',
    status: 'ported',
    jsFile: 'rapid_doc/model/ocr/rapid_ocr.js (_initSealDetector, _ocrSeal)',
    pyRef: 'rapid_ocr_onnxruntime/main.py:_ocrSeal — box_type="poly", limit_side_len=736, limit_type="min", unclip_ratio=0.5, box_thresh=0.6',
    notes: [
      'Seal detection model: pp-ocrv4_mobile_seal_det.onnx (registered in ocr_helpers.js).',
      'Activated when ocr(img, { is_seal: true }) or RapidOcrModel.create({ is_seal: true }).',
      'DetPostProcess constructed with box_type="poly" — dispatches to _polygonsFromBitmap.',
      'See also: patch O2 (sortPolyBoxes, cropByPolys) which are part of the seal pipeline.',
    ].join(' '),
  },
  {
    id: 'O2',
    name: 'Polygon helpers — sortPolyBoxes + cropByPolys + polygons_from_bitmap',
    status: 'ported',
    jsFile: [
      'rapid_doc/utils/ocr_utils.js (sortPolyBoxes, cropByPolys, _warpPolyRectCrop)',
      'rapid_doc/model/ocr/ocr_postprocess.js (DetPostProcess._polygonsFromBitmap)',
    ].join(', '),
    pyRef: 'rapid_ocr_onnxruntime/utils.py:SortPolyBoxes, CropByPolys; post_process/db_postprocess.py:polygons_from_bitmap',
    notes: [
      'sortPolyBoxes: sorts polygon arrays by min-y then min-x — matches Python SortPolyBoxes.',
      'cropByPolys: perspective-warps each polygon region via minAreaRect — equivalent to Python get_poly_rect_crop for seal (IoU >= 0.7).',
      'polygons_from_bitmap: DetPostProcess._polygonsFromBitmap extracts raw contour polygons',
      '  when box_type="poly"; skips dilation (matches Python seal path).',
      'All returned cv.Mat crops must be deleted by caller.',
    ].join(' '),
  },
  {
    id: 'O3',
    name: 'ocr_patch.js documentation — patch registry',
    status: 'ported',
    jsFile: 'rapid_doc/model/ocr/ocr_patch.js (this file)',
    pyRef: 'rapid_ocr_onnxruntime/ocr_patch.py:apply_ocr_patch',
    notes: [
      'Python apply_ocr_patch() monkey-patches TextDetector/TextRecognizer at import time.',
      'In JS there is no monkey-patching; all patches are baked into the class constructors.',
      'This file documents which Python patches are ported and which are deferred.',
    ].join(' '),
  },
  {
    id: 'O4',
    name: 'CTC blank token explicit insert at index 0',
    status: 'ported',
    jsFile: 'rapid_doc/model/ocr/ocr_ctc_decode.js (CTCLabelDecode constructor)',
    pyRef: 'rapid_ocr_onnxruntime/utils.py:CTCLabelDecode.__init__ — character = ["blank"] + charDict',
    notes: [
      'Patch O8: blank token always inserted at index 0 explicitly.',
      'Previous JS implementation auto-detected blank by checking charList[0] === "blank",',
      '  which fails when the dict file omits the blank entry.',
    ].join(' '),
  },
  {
    id: 'cls_180',
    name: 'Text orientation classifier (cls_180 / use_cls)',
    status: 'deferred',
    jsFile: 'rapid_doc/model/ocr/rapid_ocr.js (not implemented)',
    pyRef: 'rapid_ocr_onnxruntime/main.py: use_cls flag + ClsPreProcess / angle classifier model',
    notes: [
      'Python baseline sets Global.use_cls=False globally — the cls_180 classifier is',
      '  disabled in the reference pipeline, so omitting it preserves parity.',
      'Deferred: no JS implementation planned until Python re-enables it.',
      'Documented in documentation/PYTHON_PARITY_DIVERGENCES.md.',
    ].join(' '),
  },
  {
    id: 'img2table',
    name: 'img2table integration',
    status: 'deferred',
    jsFile: 'rapid_doc/model/ocr/rapid_ocr.js (not implemented)',
    pyRef: 'rapid_doc/main.py: optional img2table post-processing for scanned table extraction',
    notes: [
      'img2table is a Python-only library with no browser-compatible JS port.',
      'Feature is not in scope for the browser port.',
      'Documented in documentation/PYTHON_PARITY_DIVERGENCES.md.',
    ].join(' '),
  },
]);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return the full list of OCR patch descriptors with their porting status.
 *
 * Each descriptor has:
 *   - id {string} patch identifier
 *   - name {string} human-readable name
 *   - status {'ported'|'deferred'|'not_applicable'}
 *   - jsFile {string} JS implementation location
 *   - pyRef {string} Python reference location
 *   - notes {string} implementation details and rationale
 *
 * @returns {Readonly<OcrPatchDescriptor[]>}
 */
export function getOcrPatchStatus() {
  return OCR_PATCHES;
}

/**
 * Apply all OCR-related patches.
 *
 * In the browser/onnxruntime-web port all patches from `OCR_PATCHES` with
 * status='ported' are **baked directly into the JS class implementations**
 * (see `jsFile` in each descriptor). There is no monkey-patching at runtime.
 *
 * This function is kept for structural parity with `apply_ocr_patch()` in the
 * Python baseline so import sites need not change if a future patch does
 * require a runtime hook.
 *
 * @returns {void}
 */
export function applyOcrPatch() {
  // All patches are baked into the JS implementations — see getOcrPatchStatus().
  // No runtime monkey-patching required in the browser port.
}
