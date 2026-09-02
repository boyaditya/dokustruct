import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@rapid_doc': path.resolve(__dirname, 'rapid_doc'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.{test,spec,prop}.js'],
    timeout: 30000,
    // Run test files sequentially: onnxruntime-web wasm init is not
    // parallel-safe on Windows CI and can exceed per-test timeouts
    fileParallelism: false,
    // Separate vitest config from vite.config.js to avoid interference
    // with browser-specific Vite build settings (COOP/COEP headers, optimizeDeps, etc.)
  },
});
