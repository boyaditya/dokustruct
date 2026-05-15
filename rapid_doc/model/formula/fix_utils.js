/**
 * LaTeX string cleanup and fix utilities.
 * Fixes mismatched \left/\right pairs, unbalanced braces,
 * unbalanced environments, and unsupported commands.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_DELIMS = new Set([
  "(", ")", "[", "]", "{", "}", "/", "|",
  "\\{", "\\}", "\\lceil", "\\rceil", "\\lfloor",
  "\\rfloor", "\\backslash", "\\uparrow", "\\downarrow",
  "\\Uparrow", "\\Downarrow", "\\|", "\\.",
]);

const ENV_TYPES = [
  "array", "matrix", "pmatrix", "bmatrix", "vmatrix",
  "Bmatrix", "Vmatrix", "cases", "aligned", "gathered",
];

const UP_COMMANDS_KEEP = new Set(["arrow", "downarrow", "lus", "silon"]);
const UP_PATTERN = /\\up([a-zA-Z]+)/g;
const COMMANDS_TO_REMOVE =
  /\\(?:lefteqn|boldmath|ensuremath|centering|textsubscript|sides|textsl|textcent|emph|protect|null)/g;

const REPLACEMENTS = [
  [/\\underbar/g, "\\underline"],
  [/\\Bar/g, "\\hat"],
  [/\\Hat/g, "\\hat"],
  [/\\Tilde/g, "\\tilde"],
  [/\\slash/g, "/"],
  [/\\textperthousand/g, "\u2030"],
  [/\\sun/g, "\u2609"],
  [/\\textunderscore/g, "\\_"],
  [/\\fint/g, "\u2a0f"],
  [/\\up /g, "\\ "],
  [/\\vline = /g, "\\models "],
  [/\\vDash /g, "\\models "],
  [/\\sq \\sqcup /g, "\\square "],
  [/\\copyright/g, "\u00a9"],
];

const QQUAD_PATTERN = /\\qquad(?!\s)/g;
const SPECIAL_CHARS = new Set(['#', '$', '%', '&', '~', '_', '^', '|', '\\', '{', '}', ' ', '\t', '\n', '\r']);

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * @param {string} cmd
 * @param {string} rest
 * @returns {string}
 */
function _fixDelim(cmd, rest) {
  if (!rest || !VALID_DELIMS.has(rest)) return cmd + ".";
  return cmd + rest;
}

/**
 * @param {string} text
 * @param {number} pos
 * @returns {boolean}
 */
function _isEscaped(text, pos) {
  let count = 0;
  let j = pos - 1;
  while (j >= 0 && text[j] === "\\") { count++; j--; }
  return count % 2 === 1;
}

/**
 * @param {string} text
 * @param {number} pos
 * @param {number} depth
 * @returns {number}
 */
function _findGroupEnd(text, pos, depth) {
  let curDepth = depth;
  for (let i = pos; i < text.length; i++) {
    if (text[i] === "{" && !_isEscaped(text, i)) curDepth++;
    else if (text[i] === "}" && !_isEscaped(text, i)) {
      curDepth--;
      if (curDepth < depth) return i;
    }
  }
  return -1;
}

/**
 * Fix mismatched \\left/\\right pairs within brace groups.
 * @param {string} s
 * @returns {string}
 */
function _fixLeftRightPairs(s) {
  const braceStack = [];
  const leftStack = [];
  const adjustments = [];
  let i = 0;

  while (i < s.length) {
    if (i > 0 && s[i - 1] === "\\") {
      let bsCount = 0;
      for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) bsCount++;
      if (bsCount % 2 === 1) { i++; continue; }
    }

    const slice5 = s.slice(i, i + 5);
    const slice6 = s.slice(i, i + 6);

    if (slice5 === "\\left" && i + 5 < s.length) {
      leftStack.push([i, braceStack.length, s[i + 5]]);
      i += 6; continue;
    }
    if (slice6 === "\\right" && i + 6 < s.length) {
      if (leftStack.length) {
        const [leftPos, leftDepth] = leftStack.pop();
        if (leftDepth !== braceStack.length) {
          const target = _findGroupEnd(s, leftPos, leftDepth);
          if (target !== -1) adjustments.push([i, i + 7, target]);
        }
      }
      i += 7; continue;
    }

    if (s[i] === "{") braceStack.push(i);
    else if (s[i] === "}" && braceStack.length) braceStack.pop();
    i++;
  }

  if (!adjustments.length) return s;

  const result = s.split("");
  adjustments.sort((a, b) => b[0] - a[0]);
  for (const [start, end, target] of adjustments) {
    const part = result.splice(start, end - start);
    result.splice(target, 0, ...part);
  }
  return result.join("");
}

/**
 * Process LaTeX backslash handling (internal helper for latexRmWhitespace).
 * If \ is followed by special chars, keep as-is.
 * If \ is followed by two letters (a command), keep as-is.
 * Otherwise, add a space after \.
 * @param {string} s
 * @returns {string}
 */
function _processLatex(s) {
  return s.replace(/\\(.)/g, (match, next, offset) => {
    if (SPECIAL_CHARS.has(next)) return match;
    if (/[a-zA-Z]/.test(next)) {
      const afterNext = s[offset + 2];
      if (afterNext && /[a-zA-Z]/.test(afterNext)) return match;
    }
    return '\\ ' + next;
  });
}

// ─── Exported functions ───────────────────────────────────────────────────────

/**
 * Fix LaTeX \\left and \\right commands.
 * Ensures valid delimiters follow \left/\right, and balances pairs.
 * @param {string} s
 * @param {boolean} [fixDelimiter=true]
 * @returns {string}
 */
export function fixLatexLeftRight(s, fixDelimiter = true) {
  if (!s) return s ?? "";

  if (fixDelimiter) {
    s = s.replace(/\\left(\S*)/g, (_, rest) => _fixDelim("\\left", rest));
    s = s.replace(/\\right(\S*)/g, (_, rest) => _fixDelim("\\right", rest));
  }

  const leftCount = (s.match(/\\left(?![a-zA-Z])/g) || []).length;
  const rightCount = (s.match(/\\right(?![a-zA-Z])/g) || []).length;

  if (leftCount === rightCount) return _fixLeftRightPairs(s);
  return s.replace(/\\left\.?|\\right\.?/g, "");
}

/**
 * Remove unmatched braces from a LaTeX string.
 * @param {string} s
 * @returns {string}
 */
export function fixUnbalancedBraces(s) {
  if (!s) return s ?? "";

  const stack = [];
  const unmatched = new Set();
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{" || s[i] === "}") {
      let bsCount = 0;
      for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) bsCount++;
      if (bsCount % 2 === 1) continue;
      if (s[i] === "{") stack.push(i);
      else if (stack.length) stack.pop();
      else unmatched.add(i);
    }
  }
  for (const idx of stack) unmatched.add(idx);
  return s.split("").filter((_, i) => !unmatched.has(i)).join("");
}

/**
 * Fix unbalanced LaTeX \\begin/\\end environment pairs.
 * Adds missing \\begin at the start or \\end at the end as needed.
 * @param {string} s
 * @returns {string}
 */
export function fixLatexEnvironments(s) {
  if (!s) return s ?? "";

  for (const env of ENV_TYPES) {
    const beginRe = new RegExp(`\\\\begin\\{${env}\\}`, "g");
    const endRe = new RegExp(`\\\\end\\{${env}\\}`, "g");
    const beginCount = (s.match(beginRe) || []).length;
    const endCount = (s.match(endRe) || []).length;

    if (beginCount === endCount) continue;

    if (endCount > beginCount) {
      const fmt = new RegExp(`\\\\begin\\{${env}\\}\\{([^}]*)\\}`);
      const fmtMatch = fmt.exec(s);
      const defaultFormat = env === "array" ? "{c}" : "";
      const formatStr = fmtMatch ? `{${fmtMatch[1]}}` : defaultFormat;
      const missing = endCount - beginCount;
      s = `\\begin{${env}}${formatStr} `.repeat(missing) + s;
    } else {
      const missing = beginCount - endCount;
      s = s + (` \\end{${env}}`).repeat(missing);
    }
  }
  return s;
}

/**
 * Remove \\up<word> commands that are not in the keep-list.
 * Keeps: \\uparrow, \\updownarrow, \\uplus, \\upsilon.
 * @param {string} s
 * @returns {string}
 */
export function removeUpCommands(s) {
  if (!s) return s ?? "";
  return s.replace(UP_PATTERN, (m, word) => {
    if (UP_COMMANDS_KEEP.has(word)) return m;
    return `\\${word}`;
  });
}

/**
 * Remove unsupported LaTeX commands (lefteqn, boldmath, ensuremath, etc.).
 * @param {string} s
 * @returns {string}
 */
export function removeUnsupportedCommands(s) {
  if (!s) return s ?? "";
  return s.replace(COMMANDS_TO_REMOVE, "");
}

/**
 * Main LaTeX cleanup function. Applies all fixes in sequence:
 * braces → left/right → environments → up commands → unsupported → replacements → backslash handling.
 * @param {string} s
 * @returns {string}
 */
export function latexRmWhitespace(s) {
  if (!s) return s ?? "";

  s = fixUnbalancedBraces(s);
  s = fixLatexLeftRight(s);
  s = fixLatexEnvironments(s);
  s = removeUpCommands(s);
  s = removeUnsupportedCommands(s);
  for (const [pattern, replacement] of REPLACEMENTS) {
    s = s.replace(pattern, replacement);
  }
  s = s.replace(QQUAD_PATTERN, "\\qquad ");
  s = _processLatex(s);
  while (s.endsWith("\\")) s = s.slice(0, -1);
  return s;
}
