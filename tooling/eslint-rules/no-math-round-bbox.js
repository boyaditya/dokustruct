/**
 * ESLint custom rule: no-math-round-bbox
 *
 * Flags uses of `Math.round(...)` in files or code contexts related to
 * bounding-box coordinate arithmetic. In the RapidDoc-JS codebase,
 * bounding-box coordinates must be truncated using `intTrunc()` from
 * `rapid_doc/utils/math_utils.js` (matching Python `int()` semantics),
 * NOT rounded with `Math.round()`.
 *
 * Detection heuristics (any one triggers the warning):
 *
 *   1. FILE PATTERN — the source file path matches a known bbox-heavy pattern:
 *        post_process.js, pre_process.js, pp_doclayout, xycut_plus,
 *        xycut_enhanced, layout_objects, layout_parsing, block_sort
 *
 *   2. VARIABLE NAME — the argument to Math.round contains a name that is
 *        commonly a bbox coordinate:
 *        x, y, x1, y1, x2, y2, w, h, width, height, cx, cy,
 *        left, top, right, bottom, col, row, bbox, box, coord, ratio,
 *        scaleX, scaleY, padX, padY, minX, minY, maxX, maxY
 *
 *   3. ANNOTATION — the surrounding function or its JSDoc contains the phrase
 *        "bbox", "bounding box", or "coordinate".
 *
 * Severity: warn (not error) so that non-bbox Math.round usages in the same
 * file are not blocked if they are clearly non-coordinate (e.g., display
 * rounding for UI strings). Fix Math.round → intTrunc where the flag is correct.
 *
 * Implements: Requirement 9.2 (ESLint rule for Math.round bbox usage)
 * References: Audit findings L9, R5, R7, R8, R9, T10, 12.5
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * File path patterns that indicate bbox-coordinate heavy files.
 * Matched against the normalized filename (forward slashes, lowercase).
 */
const BBOX_FILE_PATTERNS = [
  /post_process/,
  /pre_process/,
  /pp_doclayout/,
  /xycut_plus/,
  /xycut_enhanced/,
  /layout_objects/,
  /layout_parsing/,
  /block_sort/,
  /scale_boxes/,
  /restructured_boxes/,
  /utils\/ocr_utils/,
  /unet\/main/,
  /unet\/utils/,
];

/**
 * Variable/parameter names that strongly suggest a bbox coordinate.
 * Matched as exact strings (case-insensitive).
 */
const BBOX_VAR_NAMES = new Set([
  'x', 'y', 'z',
  'x1', 'y1', 'x2', 'y2',
  'x0', 'y0', 'x3', 'y3',
  'w', 'h',
  'width', 'height',
  'cx', 'cy',
  'left', 'top', 'right', 'bottom',
  'col', 'row',
  'bbox', 'box',
  'coord',
  'scalex', 'scaley',
  'padx', 'pady',
  'minx', 'miny', 'maxx', 'maxy',
  'startx', 'starty', 'endx', 'endy',
  'offsetx', 'offsety',
  'dx', 'dy',
  'nw', 'nh', 'neww', 'newh', 'newwidth', 'newheight',
  'ratiox', 'ratioy', 'scale', 'ratio',
]);

/** Return true if the identifier name (case-insensitive) looks like a bbox coord. */
function isBboxVarName(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (BBOX_VAR_NAMES.has(lower)) return true;
  // Suffix patterns: anything ending in _x, _y, _w, _h, _left, etc.
  if (/_(x|y|w|h|left|top|right|bottom|col|row|coord|bbox|box)(\d*)$/.test(lower)) return true;
  if (/^(x|y|w|h|left|top|right|bottom)(\d+)$/.test(lower)) return true;
  return false;
}

/**
 * Extract the "deepest" identifier name from a node.
 * For `a.b.c` returns 'c', for `a` returns 'a', for `arr[i]` returns null.
 */
function extractIdentifierName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed) {
    return extractIdentifierName(node.property);
  }
  if (node.type === 'BinaryExpression') {
    // e.g. Math.round(a * ratio) — check both sides
    const left = extractIdentifierName(node.left);
    const right = extractIdentifierName(node.right);
    return left || right;
  }
  return null;
}

/** Walk ancestors to find if any enclosing function/JSDoc mentions "bbox". */
function hasEnclosingBboxAnnotation(node, sourceCode) {
  let current = node.parent;
  while (current) {
    // Check JSDoc comment on the enclosing function
    if (
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      const comments = sourceCode.getCommentsBefore(current);
      for (const c of comments) {
        if (/\b(bbox|bounding.?box|coordinate)\b/i.test(c.value)) return true;
      }
    }
    // Check if nearest variable declarator name is bbox-ish
    if (current.type === 'VariableDeclarator' && current.id) {
      if (isBboxVarName(current.id.name)) return true;
    }
    current = current.parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rule definition (ESM export)
// ---------------------------------------------------------------------------

/** @type {import('eslint').Rule.RuleModule} */
export const noMathRoundBbox = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow Math.round() for bounding-box coordinate arithmetic — use intTrunc() instead.',
      category: 'Parity',
      recommended: false,
    },
    fixable: null, // Manual fix required (Math.round → intTrunc)
    schema: [
      {
        type: 'object',
        properties: {
          /** Additional file path patterns (RegExp source strings) to flag. */
          additionalFilePatterns: {
            type: 'array',
            items: { type: 'string' },
            default: [],
          },
          /** Additional variable names to flag (case-insensitive). */
          additionalVarNames: {
            type: 'array',
            items: { type: 'string' },
            default: [],
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noMathRoundBbox:
        'Use intTrunc() from rapid_doc/utils/math_utils.js instead of Math.round() ' +
        'for bounding-box coordinate arithmetic. ' +
        'Math.round() rounds half-up; Python int() truncates toward zero. ' +
        '[Audit: L9, R5, R7, R8, R9, T10]',
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const extraFilePatterns = (options.additionalFilePatterns ?? []).map(
      (s) => new RegExp(s),
    );
    const extraVarNames = new Set(
      (options.additionalVarNames ?? []).map((s) => s.toLowerCase()),
    );

    const filename = context.getFilename().replace(/\\/g, '/').toLowerCase();
    const sourceCode = context.getSourceCode();

    // Check if the file itself is in a bbox-heavy module
    const isInBboxFile = [...BBOX_FILE_PATTERNS, ...extraFilePatterns].some(
      (pat) => pat.test(filename),
    );

    return {
      CallExpression(node) {
        // Match Math.round(...)
        if (
          node.callee.type !== 'MemberExpression' ||
          node.callee.object.type !== 'Identifier' ||
          node.callee.object.name !== 'Math' ||
          node.callee.property.type !== 'Identifier' ||
          node.callee.property.name !== 'round'
        ) {
          return;
        }

        const arg = node.arguments[0];

        // Heuristic 1: file is known bbox-heavy
        if (isInBboxFile) {
          context.report({ node, messageId: 'noMathRoundBbox' });
          return;
        }

        // Heuristic 2: argument identifier looks like a bbox coordinate
        const argName = extractIdentifierName(arg);
        if (
          argName &&
          (isBboxVarName(argName) || extraVarNames.has(argName.toLowerCase()))
        ) {
          context.report({ node, messageId: 'noMathRoundBbox' });
          return;
        }

        // Heuristic 3: enclosing function/declarator has bbox annotation
        if (hasEnclosingBboxAnnotation(node, sourceCode)) {
          context.report({ node, messageId: 'noMathRoundBbox' });
        }
      },
    };
  },
};

export default noMathRoundBbox;
