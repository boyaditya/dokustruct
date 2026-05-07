import * as ort from 'onnxruntime-web';
import ortWasmThreadedJsepMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import ortWasmThreadedJsepWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';

let configured = false;
let gpuDevice = null;

/**
 * Configure ORT wasm runtime paths through Vite-managed asset URLs.
 * Also handles WebGPU device initialization for sharing across models.
 *
 * @param {{ numThreads?: number, useWebGpu?: boolean }} [opts]
 */
export async function configureOrtRuntime(opts = {}) {
  const runtime = ort || globalThis.ort;
  if (!runtime) return false;

  // WASM Config
  if (runtime.env.wasm) {
    runtime.env.wasm.wasmPaths = {
      mjs: ortWasmThreadedJsepMjsUrl,
      wasm: ortWasmThreadedJsepWasmUrl,
    };

    const fallbackThreads = typeof SharedArrayBuffer === 'undefined' ? 1 : 2;
    const requestedThreads = Number(opts.numThreads);
    runtime.env.wasm.numThreads = Number.isFinite(requestedThreads) && requestedThreads > 0
      ? Math.max(1, Math.trunc(requestedThreads))
      : fallbackThreads;
    runtime.env.wasm.proxy = false;
  }

  // WebGPU Config (Best Practice: Shared Device)
  if (opts.useWebGpu && navigator.gpu) {
    try {
      if (!gpuDevice) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          gpuDevice = await adapter.requestDevice();
          runtime.env.webgpu.device = gpuDevice;
          console.info(`[ORT] WebGPU Shared Device Initialized: ${adapter.name}`);
        }
      }
    } catch (err) {
      console.warn('[ORT] Failed to initialize shared WebGPU device:', err.message);
    }
  }

  configured = true;
  return true;
}

// Deprecated alias for backward compatibility
export function configureOrtWasmRuntime(opts) {
  return configureOrtRuntime(opts);
}

export function isOrtRuntimeConfigured() {
  return configured;
}

// ─── GLOBAL WEBGPU MUTEX ──────────────────────────────────────────────────────
// ORT WebGPU uses a global device context. Concurrent session.run() calls 
// across *any* session instance will crash with 'Session already started'.
// This global mutex ensures strictly serialized GPU access application-wide.
let globalGpuMutexQueue = Promise.resolve();

/**
 * Acquire the global WebGPU lock.
 * Returns a release function that MUST be called immediately after session.run()
 * completes (before await getData() or any CPU postprocessing) to keep the GPU fed.
 * @returns {Promise<() => void>}
 */
export const acquireGlobalGpu = () => {
  let release;
  const next = new Promise(resolve => release = resolve);
  const ready = globalGpuMutexQueue.then(() => release);
  globalGpuMutexQueue = globalGpuMutexQueue.then(() => next);
  return ready;
};
