import { describe, expect, it } from 'vitest';
import katex from 'katex';
import {
  fixLatexLeftRight,
  sanitizeFormulaLatex,
} from '../../rapid_doc/model/formula/fix_utils.js';
import { fixLatex } from '../../rapid_doc/model/formula/rapid_formula_self/model_handler/pp_formulanet_plus/utils.js';

const BS = '\\';

function hasKatexError(latex) {
  const html = katex.renderToString(latex, {
    throwOnError: false,
    strict: false,
    trust: false,
  });
  return html.includes('katex-error')
    || html.includes('mathcolor="#cc0000"')
    || html.includes('<merror');
}

describe('PP-FormulaNet LaTeX cleanup', () => {
  it('removes the dangling trailing backslash from the reported FormulaNet output', () => {
    const raw = [
      `${BS}sum _ { p , m }`,
      `${BS}frac { p ^ { - m s } } { m } =`,
      `${BS}sum _ { n = 1 } ^ { ${BS}infty } c _ { n } n ^ { - s }`,
    ].join(' ') + ` ${BS}`;

    const fixed = fixLatex(raw);

    expect(raw.endsWith(BS)).toBe(true);
    expect(fixed.endsWith(BS)).toBe(false);
    expect(hasKatexError(raw)).toBe(true);
    expect(hasKatexError(fixed)).toBe(false);
  });

  it('splits glued spacing commands without dropping the following token', () => {
    expect(fixLatex(`a${BS}quadb`)).toBe(`a${BS}quad b`);
    expect(fixLatex(`a${BS}qquadb`)).toBe(`a${BS}qquad b`);
    expect(fixLatex(`a${BS}  quadb`)).toBe(`a${BS}quad b`);
  });

  it('preserves valid mathit arguments', () => {
    const formula = `a ${BS}mathit { bad } + b`;
    expect(fixLatex(formula)).toBe(formula);
  });

  it('drops only dangling known argument commands at formula end', () => {
    expect(fixLatex(`a + ${BS}mathit`)).toBe('a +');
  });

  it('preserves short spacing macros', () => {
    const formula = `x ${BS}: ,`;
    expect(fixLatex(formula)).toBe(formula);
  });

  it('keeps safe FormulaNet replacements without generic backslash rewriting', () => {
    expect(sanitizeFormulaLatex(`${BS}Bar + ${BS}slash`)).toBe(`${BS}hat + /`);
  });

  it('keeps fixLatexLeftRight fixDelimiter=false behavior unchanged', () => {
    const formula = `${BS}left x + 1 ${BS}right)`;
    expect(fixLatexLeftRight(formula, false)).toBe(formula);
    expect(fixLatex(formula)).toBe(formula);
  });

  it('repairs split commands and duplicate subscripts from FormulaNet garbage', () => {
    const raw = `M _ { * } ${BS}${BS}  tilde { L _ _ { E } }  tilde   t   {{}   } / { ${BS}${BS}  lambda } c ^ { 2 }`;

    const fixed = fixLatex(raw);

    expect(fixed).toContain(`${BS}tilde { L _ { E } }`);
    expect(fixed).toContain(`{ ${BS}lambda }`);
    expect(fixed).not.toContain('_ _');
    expect(hasKatexError(raw)).toBe(true);
    expect(hasKatexError(fixed)).toBe(false);
  });

  it('repairs malformed array environments enough to avoid KaTeX errors', () => {
    const raw = `${BS}begin{array}{c} ${BS}begin(array} { c } { {left${BS} 1 - 2 x - x ^ { 2 } ) ${BS}sum _ { m = 0 } ^ { ${BS}infty } a _ { m } x ^ { m } = 1 } ${BS}${BS} ${BS}end{array}`;

    const fixed = sanitizeFormulaLatex(raw);

    expect(fixed).toContain(`${BS}begin{array}`);
    expect(fixed).not.toContain(`${BS}begin(array}`);
    expect(hasKatexError(raw)).toBe(true);
    expect(hasKatexError(fixed)).toBe(false);
  });

  it('collapses repeated script markers from boldsymbol garbage', () => {
    const raw = `${BS}{${BS}${BS}boldsymbol{{ b}   ___ n n} ${BS}}`;

    const fixed = sanitizeFormulaLatex(raw);

    expect(fixed).not.toContain('___');
    expect(hasKatexError(raw)).toBe(true);
    expect(hasKatexError(fixed)).toBe(false);
  });

  it('adds missing backslashes to common leaked command words', () => {
    const raw = 'mathit { x } + tilde t';

    const fixed = sanitizeFormulaLatex(raw);

    expect(fixed).toBe(`${BS}mathit { x } + ${BS}tilde t`);
    expect(hasKatexError(fixed)).toBe(false);
  });
});
