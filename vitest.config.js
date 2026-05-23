import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.{test,spec,prop}.js'],
    timeout: 30000,
    // Separate vitest config from vite.config.js to avoid interference
    // with browser-specific Vite build settings (COOP/COEP headers, optimizeDeps, etc.)
  },
});
