/**
 * PORTING NOTE: Browser-specific cancellation plumbing (no Python equivalent).
 *
 * The pipeline adapter owns the per-run AbortController, but the engine runs
 * deep synchronous CPU loops (CTC decode, contour postprocessing, unionMake)
 * that never receive the adapter's signal. A module-level registry lets any
 * hot loop check cancellation without threading a signal argument through
 * every function signature.
 *
 * The signal is set at run start and cleared at run end (success/abort/error),
 * so a stale aborted signal can never poison a later run.
 */

import { AbortException } from './exceptions.js';

/** @type {AbortSignal|null} */
let globalSignal = null;

/**
 * Register the signal for the current pipeline run.
 * @param {AbortSignal|null} signal
 */
export function setGlobalAbortSignal(signal) {
  globalSignal = signal ?? null;
}

/** Clear the registered signal (called when a run finishes). */
export function clearGlobalAbortSignal() {
  globalSignal = null;
}

/**
 * True when either the given signal or the registered global signal is aborted.
 * @param {AbortSignal|null} [signal]
 * @returns {boolean}
 */
export function isAborted(signal = null) {
  return Boolean(signal?.aborted || globalSignal?.aborted);
}

/**
 * Throw AbortException when the run has been cancelled.
 * Cheap enough to call inside hot loops.
 * @param {AbortSignal|null} [signal]
 * @param {string} [message]
 */
export function throwIfAborted(signal = null, message = 'Operation aborted') {
  if (isAborted(signal)) throw new AbortException(message);
}
