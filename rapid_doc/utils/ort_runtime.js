import * as ort from 'onnxruntime-web';
// Resolve the ORT WASM loader + binary through Vite's `?url` mechanism (same
// pattern as pdfjs_loader.js). This routes the assets through Vite's transform
// pipeline so the dev server does not block them. Importing the `/public/ort/*`
// copies as source strings triggers Vite's "should not be imported from source
// code" guard in dev. The `/public` files remain a build-time/debug fallback.
import ortJsepMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import ortJsepWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';

let configured = false;
let gpuDevice = null;
let gpuDeviceLostListenerAttached = false;
/**
 * Diagnostic metadata captured when the shared WebGPU device is initialised.
 * Consumers can use this to size batches adaptively based on the adapter's
 * actual reported limits rather than guessing from system RAM.
 *
 * Shape:
 *   {
 *     label:           string  // "vendor / arch / description" or "unknown"
 *     looksIntegrated: boolean // heuristic match against integrated GPU names
 *     limits: {                // promoted device limits (when supported)
 *       maxBufferSize?:                 number
 *       maxStorageBufferBindingSize?:   number
 *       maxComputeWorkgroupStorageSize?:number
 *       maxComputeInvocationsPerWorkgroup?:number
 *     }
 *   }
 *
 * @type {{label:string,looksIntegrated:boolean,limits:object}|null}
 */
let adapterMetadata = null;
/**
 * Set when the WebGPU device has been lost (driver-killed or destroyed).
 * Code that releases sessions/tensors must check this and SKIP `release()`
 * because session IDs are invalid once the device is gone — calling release
 * trips "cannot release session, invalid session id" stack noise that masks
 * the real error.
 */
let deviceLost = false;

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
    // Primary source: Vite-resolved `?url` paths (dev-server safe). An optional
    // global override is honored for debugging against the /public copies.
    const override = (typeof window !== 'undefined' && window.__RAPIDDOC_ORT_WASM_PATHS__) || null;
    runtime.env.wasm.wasmPaths = {
      mjs: override?.mjs ?? ortJsepMjsUrl,
      wasm: override?.wasm ?? ortJsepWasmUrl,
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
        // Request a high-performance adapter explicitly. On systems with
        // both an integrated and a discrete GPU, the browser may otherwise
        // bind to the lower-power adapter, which has a much smaller VRAM
        // budget and tighter buffer-size limits. Asking for high-performance
        // does NOT guarantee the discrete GPU is selected — that ultimately
        // depends on the OS-level GPU preference for the browser process —
        // but it is the strongest hint the WebGPU API supports.
        const adapter = await navigator.gpu.requestAdapter({
          powerPreference: 'high-performance',
        });
        if (adapter) {
          // Surface adapter info for diagnostics. Helps confirm which GPU
          // ORT-Web bound to (some browsers report empty info for privacy).
          let adapterDesc = '';
          let adapterVendor = '';
          let adapterArch = '';
          try {
            const info = typeof adapter.requestAdapterInfo === 'function'
              ? await adapter.requestAdapterInfo()
              : (adapter.info ?? {});
            adapterDesc = info?.description || info?.device || '';
            adapterVendor = info?.vendor || '';
            adapterArch = info?.architecture || '';
          } catch { /* ignore */ }
          const adapterLabel = [adapterDesc, adapterVendor, adapterArch]
            .filter(Boolean).join(' / ') || 'unknown';

          // Heuristic: warn when the bound adapter looks like an integrated
          // GPU. If a discrete GPU is also present on the system, the user
          // may be able to switch to it via the OS GPU preference panel.
          // This is informational only; the pipeline still runs on whatever
          // adapter the browser provides.
          const looksIntegrated = /intel|hd graphics|uhd graphics|iris/i.test(adapterLabel);
          if (looksIntegrated) {
            console.warn(
              `[ORT] WebGPU bound to what appears to be an integrated GPU ` +
              `("${adapterLabel}"). If a discrete GPU is available, set the ` +
              `browser's GPU preference to "High performance" at the OS level ` +
              `(e.g. Windows Settings → Display → Graphics) and restart the ` +
              `browser. The WASM fallback is always available as an alternative.`,
            );
          }

          // Promote the adapter's reported limits into the requested device
          // limits. ORT-Web's WebGPU backend allocates large kernel-internal
          // buffers per session; the default device limits are conservative
          // and reject buffer requests that the underlying adapter actually
          // supports. Promoting `maxBufferSize` and the storage-binding cap
          // is what unlocks PaddleOCR rec on mid-tier GPUs.
          const limits = adapter.limits ?? {};
          const requiredLimits = {};
          for (const key of [
            'maxBufferSize',
            'maxStorageBufferBindingSize',
            'maxComputeWorkgroupStorageSize',
            'maxComputeInvocationsPerWorkgroup',
          ]) {
            const v = limits?.[key];
            if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
              requiredLimits[key] = v;
            }
          }

          gpuDevice = await adapter.requestDevice({ requiredLimits });
          runtime.env.webgpu.device = gpuDevice;
          deviceLost = false;
          adapterMetadata = {
            label: adapterLabel,
            looksIntegrated,
            limits: { ...requiredLimits },
          };
          attachDeviceLostListener(gpuDevice);
          console.info(
            `[ORT] WebGPU device initialized — adapter: ${adapterLabel}, ` +
            `maxBufferSize: ${requiredLimits.maxBufferSize ?? 'default'}, ` +
            `maxStorageBufferBindingSize: ${requiredLimits.maxStorageBufferBindingSize ?? 'default'}`,
          );
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

/**
 * Returns the currently shared WebGPU device, or null if unavailable.
 * @returns {GPUDevice|null}
 */
export function getGpuDevice() {
  return gpuDevice;
}

/**
 * Returns adapter metadata captured during the most recent device init,
 * or null when WebGPU is unavailable / not yet initialised.
 *
 * Useful for adaptive batch-size selection: callers can read
 * `getAdapterMetadata()?.limits.maxStorageBufferBindingSize` to scale the
 * per-batch tensor size to the actual hardware capability.
 * @returns {{label:string,looksIntegrated:boolean,limits:object}|null}
 */
export function getAdapterMetadata() {
  return adapterMetadata;
}

/**
 * True if the WebGPU device was lost (driver-killed, manually destroyed, or
 * never created). Once true, every ORT session referencing that device is
 * invalid. Callers that try to dispose those sessions must skip `release()`.
 * @returns {boolean}
 */
export function isGpuDeviceLost() {
  return deviceLost;
}

/**
 * Reset the device-lost flag. Called internally after a fresh device is
 * acquired. Exported for tests.
 */
export function clearGpuDeviceLostFlag() {
  deviceLost = false;
}

/**
 * Wait for all GPU work submitted before this call to complete.
 * Used to ensure transient inference buffers have been freed by the
 * runtime before the caller takes a memory measurement or starts a new run.
 *
 * Safe to call when WebGPU is not initialised (no-op).
 * @returns {Promise<void>}
 */
export async function flushGpuQueue() {
  if (!gpuDevice || typeof gpuDevice.queue?.onSubmittedWorkDone !== 'function') return;
  try {
    await gpuDevice.queue.onSubmittedWorkDone();
  } catch (err) {
    console.warn('[ORT] flushGpuQueue failed:', err?.message ?? err);
  }
}

/**
 * Release the shared WebGPU device. After this call, the next session create
 * triggered through `configureOrtRuntime({ useWebGpu: true })` will request
 * a fresh adapter + device. This is the only way to drain ORT-Web's internal
 * WebGPU JSEP buffer pool — `session.release()` alone does not return all
 * pooled buffers to the driver.
 *
 * Safe to call when WebGPU is not initialised (no-op).
 * @returns {Promise<void>}
 */
export async function releaseGpuDevice() {
  if (!gpuDevice) return;
  const dev = gpuDevice;
  gpuDevice = null;
  gpuDeviceLostListenerAttached = false;
  configured = false;
  adapterMetadata = null;
  // Mark device as lost so any pending dispose() calls skip release().
  deviceLost = true;

  try {
    // Best-effort: detach the device from ORT before destroying so subsequent
    // session.run calls do not silently use a dead handle.
    if (ort?.env?.webgpu) ort.env.webgpu.device = undefined;
  } catch { /* ignore */ }

  try {
    await dev.queue?.onSubmittedWorkDone?.();
  } catch { /* device may already be lost */ }

  try {
    if (typeof dev.destroy === 'function') dev.destroy();
  } catch (err) {
    console.warn('[ORT] device.destroy failed:', err?.message ?? err);
  }
}

/**
 * Full GPU runtime reset: flush queue, destroy device, drop ORT reference.
 * Combine with model/session disposal for a clean per-run reset.
 * @returns {Promise<void>}
 */
export async function resetGpuRuntime() {
  await flushGpuQueue();
  await releaseGpuDevice();
}

/**
 * Attach a `device.lost` listener that clears module state so the next
 * configureOrtRuntime call requests a fresh device. Without this, a lost
 * device produces "external Instance reference no longer exists" errors
 * that are not recoverable by retry.
 * @param {GPUDevice} device
 */
function attachDeviceLostListener(device) {
  if (gpuDeviceLostListenerAttached) return;
  if (!device || typeof device.lost?.then !== 'function') return;
  gpuDeviceLostListenerAttached = true;

  device.lost
    .then((info) => {
      const reason = info?.reason ?? 'unknown';
      const message = info?.message ?? '';
      console.warn(`[ORT] WebGPU device lost (reason=${reason}): ${message}`);
      // Reset module state so the next configureOrtRuntime call gets a fresh device.
      gpuDevice = null;
      gpuDeviceLostListenerAttached = false;
      configured = false;
      adapterMetadata = null;
      // Mark device as lost so dispose paths skip session.release() (calling
      // release on a dead device throws "cannot release session, invalid
      // session id" which masks the real WebGPU failure).
      deviceLost = true;
      try { if (ort?.env?.webgpu) ort.env.webgpu.device = undefined; } catch { /* ignore */ }
    })
    .catch(() => { /* lost-promise itself is informational */ });
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
