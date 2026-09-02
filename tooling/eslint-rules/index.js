/**
 * RapidDoc-JS custom ESLint rules plugin (ESM).
 *
 * Exposes project-specific parity and quality rules that are not
 * available in standard ESLint rule sets.
 *
 * Usage in eslint.config.js (flat config):
 *
 *   import rapiddocPlugin from './tooling/eslint-rules/index.js';
 *
 *   export default [
 *     {
 *       plugins: { rapiddoc: rapiddocPlugin },
 *       rules: {
 *         'rapiddoc/no-math-round-bbox': 'warn',
 *       },
 *     },
 *   ];
 */

import { noMathRoundBbox } from './no-math-round-bbox.js';

const rapiddocPlugin = {
  meta: {
    name: 'rapiddoc',
    version: '1.0.0',
  },
  rules: {
    /**
     * Warn when Math.round is used for bounding-box coordinate arithmetic.
     * Use intTrunc from rapid_doc/utils/math_utils.js instead.
     * References: —
     */
    'no-math-round-bbox': noMathRoundBbox,
  },
};

export default rapiddocPlugin;
