import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let pdfjsLibPromise = null;
let sharedWorkerPort = null;

function getSharedWorkerPort() {
  if (typeof Worker === 'undefined') return null;
  if (!sharedWorkerPort) {
    sharedWorkerPort = new Worker(pdfWorkerSrc, { type: 'module' });
    if (typeof globalThis !== 'undefined') {
      globalThis.addEventListener?.('beforeunload', () => {
        try { sharedWorkerPort?.terminate?.(); } catch { /* ignore */ }
        sharedWorkerPort = null;
      }, { once: true });
    }
  }
  return sharedWorkerPort;
}

export async function getPdfjsLib() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const pdfjsLib = (typeof globalThis !== 'undefined' && globalThis.pdfjsLib)
        ? globalThis.pdfjsLib
        : await import('pdfjs-dist');

      if (pdfjsLib.GlobalWorkerOptions) {
        const workerPort = getSharedWorkerPort();
        if (workerPort) {
          pdfjsLib.GlobalWorkerOptions.workerPort = workerPort;
        } else if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
          pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
        }
      }

      return pdfjsLib;
    })();
  }
  return pdfjsLibPromise;
}

export function terminateSharedPdfWorker() {
  try { sharedWorkerPort?.terminate?.(); } catch { /* ignore */ }
  sharedWorkerPort = null;
  pdfjsLibPromise = null;
}
