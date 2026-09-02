/**
 * Consolidated resource cleanup utilities.
 * Replaces duplicated deleteMat/clearLayoutImageList across pipeline files.
 */

/**
 * Safely deletes a cv.Mat instance.
 * Null-safe: guards against null/undefined, non-Mat objects, and already-deleted Mats.
 * @param {*} mat - The Mat to delete
 */
export function deleteMat(mat) {
  if (mat && typeof cv !== 'undefined' && mat instanceof cv.Mat && !mat.isDeleted?.()) {
    mat.delete();
  }
}

/**
 * Safely deletes an array of cv.Mat instances.
 * Null-safe: guards against null/undefined input and non-array values.
 * @param {Array|null|undefined} mats - Array of Mats to delete
 */
export function deleteMatList(mats) {
  if (!Array.isArray(mats)) return;
  for (const mat of mats) {
    deleteMat(mat);
  }
}

/**
 * Clears layout image list from table results, deleting associated Mat resources.
 * Null-safe: guards against null/undefined tableRes and missing layout_image_list.
 * @param {object|null|undefined} tableRes - Table result object containing layout_image_list
 */
export function clearLayoutImageList(tableRes) {
  if (!tableRes) return;
  const list = tableRes.layout_image_list;
  if (Array.isArray(list)) {
    for (const item of list) {
      deleteMat(item?.pil_image);
    }
  }
  delete tableRes.layout_image_list;
}

/**
 * Releases an OffscreenCanvas by resizing it to 0x0 to free GPU/memory resources.
 * Null-safe: guards against null/undefined input.
 * @param {OffscreenCanvas|null|undefined} canvas - The canvas to release
 */
export function releaseCanvas(canvas) {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // Canvas may already be detached or in an invalid state
  }
}

/**
 * Releases an ImageBitmap by calling close.
 * Null-safe: guards against null/undefined input.
 * @param {ImageBitmap|null|undefined} bitmap - The ImageBitmap to release
 */
export function releaseImageBitmap(bitmap) {
  if (!bitmap) return;
  try {
    if (typeof bitmap.close === 'function') {
      bitmap.close();
    }
  } catch {
    // Bitmap may already be closed or in an invalid state
  }
}

/**
 * Dispose every tensor inside an ORT result map (returned by session.run).
 * Safely handles both Map instances and plain object outputs.
 * Without this, gpu-buffer-located output tensors keep their backing GPU
 * buffer pinned in ORT-Web's pool until the wrapper is GC'd, which can be
 * many seconds after the run completes.
 *
 * @param {Map<string, any>|Record<string, any>|null|undefined} outputMap
 */
export function disposeOutputMap(outputMap) {
  if (!outputMap) return;
  const tensors = outputMap instanceof Map
    ? outputMap.values()
    : Object.values(outputMap);
  for (const tensor of tensors) {
    if (tensor && typeof tensor.dispose === 'function') {
      try { tensor.dispose(); } catch { /* already disposed */ }
    }
  }
}

/**
 * RAII-style resource guard for Mat operations.
 * Calls factory to create Mats, passes them to operation(), and ensures
 * all Mats are deleted in a finally block even if operation throws.
 *
 * @param {function(): Array} factory - Function that returns an array of Mats
 * @param {function(Array): *} operation - Function that receives the Mats and performs work
 * @returns {Promise<*>} The result of the operation
 */
export async function withMats(factory, operation) {
  if (!factory || !operation) return undefined;
  const mats = factory();
  try {
    return await operation(mats);
  } finally {
    if (Array.isArray(mats)) {
      for (const mat of mats) {
        deleteMat(mat);
      }
    }
  }
}
