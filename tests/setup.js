// Mock OffscreenCanvas for tests that need it
if (typeof globalThis.OffscreenCanvas === 'undefined') {
  globalThis.OffscreenCanvas = class OffscreenCanvas {
    width; height;
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
    getContext() { return null; }
    convertToBlob() { return Promise.resolve(new Blob()); }
  };
}
