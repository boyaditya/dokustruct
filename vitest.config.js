import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec,prop}.{js,mjs}'],
    globals: false,
    environment: 'node',
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@rapid_doc': path.resolve(__dirname, 'rapid_doc'),
    },
  },
});
