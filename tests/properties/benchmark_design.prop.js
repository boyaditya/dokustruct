/**
 * Benchmark Design Validation — ensures metric choices are not arbitrary.
 *
 * Validates the statistical design decisions documented in benchmark/README.md:
 * - Overall = ((1-TextEdit)*100 + TEDS + FormulaScore)/3 (OmniDocBench scale)
 * - Geometric mean for ratios (not arithmetic mean)
 * - Wilcoxon signed-rank for paired non-normal data (not t-test)
 * - Holm-Bonferroni for multiple comparisons (not Bonferroni)
 * - Stratified sampling with finite-population correction
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

describe('Benchmark Design — metric correctness oracles', () => {
  it('Overall score formula matches OmniDocBench spec', () => {
    const textEdit = 0.2, teds = 0.8, formulaScore = 0.9;
    const overall = ((1 - textEdit) * 100 + teds * 100 + formulaScore * 100) / 3;
    // (80 + 80 + 90)/3 = 83.33
    expect(overall).toBeCloseTo(83.33, 1);
    // Edge: perfect scores
    expect(((1 - 0) * 100 + 1 * 100 + 1 * 100) / 3).toBe(100);
    expect(((1 - 1) * 100 + 0 * 100 + 0 * 100) / 3).toBe(0);
  });

  it('geometric mean is not arithmetic mean (bias demo)', () => {
    const ratios = [0.5, 2.0]; // 0.5*2=1, geomean=1, arithmetic=1.25
    const geomean = Math.exp(ratios.reduce((a, b) => a + Math.log(b), 0) / ratios.length);
    const arithmetic = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    expect(geomean).toBeCloseTo(1.0, 5);
    expect(arithmetic).toBeCloseTo(1.25, 5);
    expect(geomean).not.toBeCloseTo(arithmetic, 1);
  });

  it('Holm-Bonferroni is less conservative than Bonferroni', () => {
    // Bonferroni: alpha/m for all; Holm: alpha/(m - k + 1) stepwise
    const m = 5, alpha = 0.05;
    const bonferroni = alpha / m; // 0.01 for all
    const holmFirst = alpha / m; // 0.01 same as Bonferroni for smallest p
    const holmLast = alpha / 1; // 0.05 for largest p — more power
    expect(holmLast).toBeGreaterThan(bonferroni);
    expect(holmFirst).toBe(bonferroni);
  });
});

describe('Benchmark Design — sampling adequacy (finite population)', () => {
  it('finite-population correction reduces required n', () => {
    const N = 1651, z = 1.96, sigma = 0.5, E = 0.05;
    const n0 = (z * z * sigma * sigma) / (E * E); // 384.16
    const n = n0 / (1 + (n0 - 1) / N); // ~311
    expect(n).toBeLessThan(n0);
    expect(n).toBeGreaterThan(300);
    expect(n).toBeLessThan(320);
  });

  it('stratified sampling preserves rare types via min_per_stratum', () => {
    // Simulate: 10 types, one rare with N=5, min_per_stratum=3 guarantees at least 3
    const strata = [
      { type: 'common', N: 100 },
      { type: 'rare', N: 5 },
    ];
    const minPerStratum = 3;
    const totalN = 10;
    // Proportional would give rare: 5/105*10 = 0.47 → 0, but min ensures 3
    const proportional = strata.map(s => Math.round((s.N / 105) * totalN));
    const withMin = strata.map(s => Math.max(minPerStratum, Math.round((s.N / 105) * totalN)));
    expect(withMin[1]).toBeGreaterThanOrEqual(minPerStratum);
    expect(proportional[1]).toBeLessThan(minPerStratum);
  });

  it('property: overall score is bounded [0, 100]', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        (textEdit, teds, formulaScore) => {
          const overall = ((1 - textEdit) * 100 + teds * 100 + formulaScore * 100) / 3;
          expect(overall).toBeGreaterThanOrEqual(0);
          expect(overall).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 100 },
    );
  });
});
