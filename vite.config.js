import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  publicDir: path.resolve(__dirname, 'public'),
  cacheDir: 'node_modules/.vite_rapiddoc',
  
  // SOLUSI 1: Membatasi entry point hanya ke index.html 
  // Agar Vite tidak menscan file HTML legacy/rusak di folder lain
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
    },
  },

  // SOLUSI 2: Update target esbuild untuk mendukung Top-level await (pdfjs-dist)
  optimizeDeps: {
    esbuildOptions: {
      target: 'es2022',
    },
    include: [
      'pdfjs-dist',
      'marked',
      'franc-min',
      'js-yaml'
    ]
  },

  server: {
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    }
  },
  
  resolve: {
    conditions: ['module', 'browser', 'development|production', 'onnxruntime-web-use-extern-wasm'],
    alias: {
      '@rapid_doc': path.resolve(__dirname, 'rapid_doc'),
    }
  }
});
