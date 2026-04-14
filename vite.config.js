import { defineConfig } from 'vite';
import path from 'node:path';

const coepPolicy = process.env.RAPIDDOC_COEP_POLICY ?? 'credentialless';

function buildIsolationHeaders() {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': coepPolicy,
  };
}

export default defineConfig({
  publicDir: 'public',
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        e2eHost: path.resolve(__dirname, 'e2e-host.html'),
      },
    },
  },
  server: {
    host: true,
    port: 5174,
    headers: buildIsolationHeaders(),
  },
  preview: {
    headers: buildIsolationHeaders(),
  },
});
