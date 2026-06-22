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
    // Separate vitest config from vite.config.js to avoid interference
    // with browser-specific Vite build settings (COOP/COEP headers, optimizeDeps, etc.)
  },
});
