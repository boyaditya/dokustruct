// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: model_handler/pp_formulanet_plus/utils.py → utils.js
// Extends fix_utils.js with extra fixDelimiter parameter and additional commands.
// Note: This file has slightly different versions of the same functions as fix_utils.js.

export {
  fixLatexLeftRight,
  fixUnbalancedBraces,
  fixLatexEnvironments,
  removeUpCommands,
  removeUnsupportedCommands,
  latexRmWhitespace,
} from "../../../fix_utils.js";

// Re-export with Python-cased aliases used internally
export {
  fixLatexLeftRight as fix_latex_left_right,
  fixLatexEnvironments as fix_latex_environments,
  removeUpCommands as remove_up_commands,
  removeUnsupportedCommands as remove_unsupported_commands,
} from "../../../fix_utils.js";

import { latexRmWhitespace as _latexRm } from "../../../fix_utils.js";

/**
 * Apply all LaTeX post-processing fixes.
 * PORTING NOTE: fix_latex(formula) → latexRmWhitespace from fix_utils.js
 * @param {string} formula
 * @returns {string}
 */
export function fixLatex(formula) {
  return _latexRm(formula);
}
