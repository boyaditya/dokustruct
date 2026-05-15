import {
  fixLatexLeftRight,
  fixLatexEnvironments,
  removeUpCommands,
  removeUnsupportedCommands,
} from "../../../fix_utils.js";

/**
 * Apply all LaTeX post-processing fixes.
 * Python baseline passes fix_delimiter=False to fix_latex_left_right (post_process.py).
 * @param {string} formula
 * @returns {string}
 */
export function fixLatex(formula) {
  let result = fixLatexLeftRight(formula, false); // fix_delimiter=False in Python
  result = fixLatexEnvironments(result);
  result = removeUpCommands(result);
  result = removeUnsupportedCommands(result);
  return result;
}
