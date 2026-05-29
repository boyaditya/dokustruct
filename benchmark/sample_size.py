"""
benchmark/sample_size.py
========================
Sample-size calculator for the skripsi benchmark.

Answers "how many documents is the minimum that is still statistically valid?"
with defensible numbers instead of a magic constant. Two modes:

  1. Theory mode (no data): prints required n for a range of margins of error,
     for both the worst-case (proportion-like, sigma^2=0.25) and a realistic
     low-variance metric, with finite population correction (FPC) for N.

  2. Pilot mode (--pilot results.xlsx OR --pilot-json scores.json): reads the
     observed standard deviation of each metric from a small pilot run and
     computes the required n to hit a target margin of error. This is the
     rigorous approach: run ~30 pages, measure variance, size the full sample.

Formulas
  n0 = z^2 * sigma^2 / E^2                      (infinite population)
  n  = n0 / (1 + (n0 - 1) / N)                  (finite population correction)
  margin(n) = z * sigma / sqrt(n) * sqrt((N-n)/(N-1))   (achieved half-width)

z = 1.96 for 95% confidence (default), 2.576 for 99%.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from pathlib import Path
from typing import Dict, List, Optional

# Robust console output on Windows (cp1252) for unicode glyphs (±, ∞, →).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass

Z = {0.90: 1.645, 0.95: 1.96, 0.99: 2.576}


def required_n(sigma: float, margin: float, population: int,
               confidence: float = 0.95) -> int:
    z = Z.get(confidence, 1.96)
    if margin <= 0 or sigma <= 0:
        return 0
    n0 = (z * z * sigma * sigma) / (margin * margin)
    if population and population > 0:
        n = n0 / (1.0 + (n0 - 1.0) / population)
    else:
        n = n0
    return max(1, math.ceil(n))


def achieved_margin(sigma: float, n: int, population: int,
                    confidence: float = 0.95) -> float:
    z = Z.get(confidence, 1.96)
    if n <= 0 or sigma <= 0:
        return float("inf")
    base = z * sigma / math.sqrt(n)
    if population and population > n:
        fpc = math.sqrt((population - n) / (population - 1))
        base *= fpc
    return base


def theory_table(population: int, confidence: float = 0.95) -> None:
    print("=" * 72)
    print(f" Sample-size theory  (N={population}, confidence={int(confidence*100)}%)")
    print("=" * 72)
    margins = [0.10, 0.07, 0.05, 0.03, 0.02]

    print("\n A) Worst-case (proportion-like metric, sigma=0.5):")
    print(f"   {'margin (±)':>12} | {'n (∞ pop)':>10} | {'n (FPC)':>10}")
    print("   " + "-" * 40)
    for E in margins:
        z = Z.get(confidence, 1.96)
        n0 = math.ceil((z * z * 0.25) / (E * E))
        n = required_n(0.5, E, population, confidence)
        print(f"   {E*100:>10.0f}% | {n0:>10d} | {n:>10d}")

    print("\n B) Realistic edit-distance/TEDS (sigma=0.15):")
    print(f"   {'margin (±)':>12} | {'n (∞ pop)':>10} | {'n (FPC)':>10}")
    print("   " + "-" * 40)
    for E in margins:
        z = Z.get(confidence, 1.96)
        n0 = math.ceil((z * z * 0.0225) / (E * E))
        n = required_n(0.15, E, population, confidence)
        print(f"   {E:>11.2f} | {n0:>10d} | {n:>10d}")

    print("\n Guidance:")
    print("   - Floor (defensible) : n ≈ 100   (overall CI fine, per-stratum ~8)")
    print("   - Recommended        : n ≈ 150-200")
    print("   - Strong             : n ≈ 300-350 (±5% worst-case)")
    print("   - Per-stratum        : aim ≥10-15 per (doc type × language) cell")
    print("   - Timing corpus      : 15-30 docs × ≥10 repeats (separate)")
    print("=" * 72)


def _collect_pilot_values(scores: List[Dict], keys: List[str]) -> Dict[str, List[float]]:
    out: Dict[str, List[float]] = {k: [] for k in keys}
    for row in scores:
        for k in keys:
            v = row.get(k)
            if isinstance(v, (int, float)):
                out[k].append(float(v))
    return out


def pilot_mode(scores: List[Dict], population: int, margin: float,
               confidence: float = 0.95) -> None:
    metric_keys = [
        ("text_edit", "Text Edit"), ("text_cer", "Text CER"),
        ("formula_edit", "Formula Edit"), ("table_teds", "Table TEDS"),
        ("overall", "Overall (0-100)"), ("coverage_f1", "Coverage F1"),
        ("mean_bbox_iou", "BBox IoU"),
    ]
    # 'overall' is on a 0-100 scale; convert margin accordingly when reporting.
    vals = _collect_pilot_values(scores, [k for k, _ in metric_keys])

    print("=" * 78)
    print(f" Pilot-based sample size  (N={population}, conf={int(confidence*100)}%, "
          f"target margin=±{margin})")
    print("=" * 78)
    print(f" {'Metric':<18}{'n_pilot':>8}{'mean':>10}{'std':>10}"
          f"{'req. n':>9}{'margin@pilot':>14}")
    print(" " + "-" * 75)
    max_req = 0
    for key, label in metric_keys:
        series = vals.get(key, [])
        series = [v for v in series if v is not None]
        if len(series) < 2:
            print(f" {label:<18}{len(series):>8}{'—':>10}{'—':>10}{'—':>9}{'—':>14}")
            continue
        mean = statistics.mean(series)
        sd = statistics.stdev(series)
        # For 'overall' (0-100) scale the target margin by 100 to compare fairly.
        eff_margin = margin * 100 if key == "overall" else margin
        req = required_n(sd, eff_margin, population, confidence)
        max_req = max(max_req, req)
        m_at_pilot = achieved_margin(sd, len(series), population, confidence)
        print(f" {label:<18}{len(series):>8}{mean:>10.4f}{sd:>10.4f}"
              f"{req:>9d}{m_at_pilot:>14.4f}")
    print(" " + "-" * 75)
    print(f" => Required n (max across metrics, to hit ±{margin}): {max_req}")
    print("    Use this as the accuracy-corpus size. Re-run sampler with --accuracy-n.")
    print("=" * 78)


def _load_pilot(path: Path) -> List[Dict]:
    if path.suffix.lower() == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            # accept {'js': [...], 'py': [...]} or a single list under 'rows'
            for k in ("rows", "js", "py", "scores"):
                if k in data and isinstance(data[k], list):
                    return data[k]
            return [data]
        return data
    if path.suffix.lower() in (".xlsx", ".xlsm"):
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True)
        ws = wb["Akurasi vs GT (Per Dok)"] if "Akurasi vs GT (Per Dok)" in wb.sheetnames \
            else wb[wb.sheetnames[0]]
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            return []
        header = [str(h) if h is not None else "" for h in rows[0]]
        # map the GT-accuracy excel headers back to metric keys
        label_to_key = {
            "Overall (0-100)": "overall", "Text Edit ↓": "text_edit",
            "Text CER ↓": "text_cer", "Formula Edit ↓": "formula_edit",
            "Table TEDS ↑": "table_teds", "Coverage F1 ↑": "coverage_f1",
            "BBox IoU ↑": "mean_bbox_iou",
        }
        out = []
        for r in rows[1:]:
            d = {}
            for h, v in zip(header, r):
                key = label_to_key.get(h, h)
                d[key] = v
            out.append(d)
        return out
    raise SystemExit(f"Unsupported pilot file: {path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Sample-size calculator for the OmniDocBench benchmark.")
    parser.add_argument("--population", type=int, default=1651,
                        help="Population size (default OmniDocBench = 1651)")
    parser.add_argument("--confidence", type=float, default=0.95,
                        choices=[0.90, 0.95, 0.99])
    parser.add_argument("--margin", type=float, default=0.03,
                        help="Target margin of error for pilot mode (default 0.03)")
    parser.add_argument("--pilot", type=Path, default=None,
                        help="Pilot results file (.xlsx from evaluate, or .json scores)")
    args = parser.parse_args()

    if args.pilot is not None:
        if not args.pilot.exists():
            raise SystemExit(f"Pilot file not found: {args.pilot}")
        scores = _load_pilot(args.pilot)
        if not scores:
            raise SystemExit("No rows found in pilot file.")
        pilot_mode(scores, args.population, args.margin, args.confidence)
    else:
        theory_table(args.population, args.confidence)


if __name__ == "__main__":
    main()
