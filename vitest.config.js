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
    environmentMatchGlobs: [['tests/unit/ui/**', 'jsdom']],
    include: ['tests/**/*.{test,spec,prop}.js'],
    setupFiles: ['tests/setup.js'],
    timeout: 30000,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['rapid_doc/**/*.js', 'ui/**/*.js'],
      exclude: ['**/*.yaml', 'rapid_doc/**/index.js'],
    },
  },
});
