/**
 * rapid_doc/utils/opencv_loader.js
 * Shared OpenCV.js loader — single source of truth for `public/opencv/`.
 *
 * `public/opencv/opencv.js` is the 225KB Emscripten glue; the 7.9MB WASM lives
 * in `public/opencv/opencv.wasm` referenced via a RELATIVE
 * `wasmBinaryFile="opencv.wasm"`, so Emscripten's default locateFile
 * (scriptDirectory + path) resolves a single `/opencv/opencv.wasm`.
 *
 * Do NOT set a custom Module.locateFile with an absolute `/opencv/...` path:
 * Emscripten calls it as locateFile(path, scriptDirectory) where
 * scriptDirectory already ends with `/opencv/`, producing
 * `/opencv//opencv/opencv.wasm` (double slash) which serves index.html
 * (magic 3c21444f) and breaks WebAssembly instantiation with
 * "Incorrect response MIME type". No Module.wasmBinary pre-fetch is needed
 * either — keep this loader minimal so ui/ and benchmark/ cannot drift apart.
 */

let openCvScriptPromise = null;

export function hasOpenCVRuntime() {
  return Boolean(globalThis.cv?.Mat);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException('Operation aborted', 'AbortError');
  }
}

export function loadOpenCVScript(signal) {
  if (hasOpenCVRuntime()) return Promise.resolve();
  if (openCvScriptPromise) return openCvScriptPromise;

  openCvScriptPromise = new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const existingScript = document.querySelector('script[data-dokustruct-opencv], script[src="/opencv/opencv.js"]');
    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener('error', () => reject(new Error('Failed to load /opencv/opencv.js')), { once: true });
      signal?.addEventListener('abort', () => reject(new DOMException('Operation aborted', 'AbortError')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = '/opencv/opencv.js';
    script.async = true;
    script.dataset.dokustructOpencv = 'true';
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Failed to load /opencv/opencv.js')), { once: true });
    signal?.addEventListener('abort', () => reject(new DOMException('Operation aborted', 'AbortError')), { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    if (!hasOpenCVRuntime()) openCvScriptPromise = null;
    throw error;
  });

  return openCvScriptPromise;
}

export function waitForOpenCV(signal, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    if (hasOpenCVRuntime()) {
      resolve(true);
      return;
    }

    const checkInterval = setInterval(() => {
      if (hasOpenCVRuntime()) {
        clearInterval(checkInterval);
        resolve(true);
      }
    }, 100);

    const timeout = setTimeout(() => {
      clearInterval(checkInterval);
      resolve(hasOpenCVRuntime());
    }, timeoutMs);

    signal?.addEventListener('abort', () => {
      clearInterval(checkInterval);
      clearTimeout(timeout);
      reject(new DOMException('Operation aborted', 'AbortError'));
    }, { once: true });
  });
}
