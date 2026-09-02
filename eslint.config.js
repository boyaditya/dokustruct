/**
 * ESLint flat configuration for RapidDoc-JS.
 *
 * Uses ESLint's flat config format (eslint.config.js), required for ESLint ≥ 9.
 * Custom parity rules are loaded from `tooling/eslint-rules/`.
 *
 * Run:
 *   npx eslint rapid_doc/ — lint all source files
 *   npm run lint — same via package.json script
 *   npm run lint:bbox — targeted bbox-coordinate check only
 */

import rapiddocPlugin from './tooling/eslint-rules/index.js';

export default [
  // ---------------------------------------------------------------------------
  // Global ignores
  // ---------------------------------------------------------------------------
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'output/**',
      '__pycache__/**',
      '.venv/**',
      'public/models/**',
      'rapid_doc/vendor/**',
      // math_utils.js defines bankerRound which internally calls Math.round — that's intentional
      'rapid_doc/utils/math_utils.js',
    ],
  },

  // ---------------------------------------------------------------------------
  // Source files — apply parity rules
  // ---------------------------------------------------------------------------
  {
    files: ['rapid_doc/**/*.js', 'ui/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        navigator: 'readonly',
        window: 'readonly',
        document: 'readonly',
        crypto: 'readonly',
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
    },
    plugins: {
      rapiddoc: rapiddocPlugin,
    },
    rules: {
      // -----------------------------------------------------------------------
      // Parity rule —
      // Warn on Math.round in bbox-coordinate contexts.
      // Use intTrunc from rapid_doc/utils/math_utils.js instead.
      // References:
      // -----------------------------------------------------------------------
      'rapiddoc/no-math-round-bbox': 'warn',

      // -----------------------------------------------------------------------
      // General quality (warnings only for incremental adoption)
      // -----------------------------------------------------------------------
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off', // pipeline relies on console.warn/error
    },
  },

  // ---------------------------------------------------------------------------
  // Test files — relax rules, still check bbox heuristic
  // ---------------------------------------------------------------------------
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
        navigator: 'readonly',
      },
    },
    plugins: {
      rapiddoc: rapiddocPlugin,
    },
    rules: {
      'rapiddoc/no-math-round-bbox': 'warn',
      'no-unused-vars': 'off',
    },
  },
];
