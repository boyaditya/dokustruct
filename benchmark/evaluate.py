"""
benchmark/evaluate.py
=====================
Evaluasi komparatif Sistem A (JS) vs Sistem B (Python) untuk skripsi.

Metrik yang dihitung per dokumen (menggunakan mean atas N run, model_init TIDAK dihitung):
  1. Processing Time  — total_inference_s dan rasio T_A / T_B
  2. Type Sequence Difference — EditDist(τ_A, τ_B) / max(|τ_A|, |τ_B|)
  3. Mean Normalized Edit Distance — rata-rata NED pada item yang sepadan

Input:
  --js-dir   : folder berisi file JSON hasil export JS benchmark UI
               Format: <stem>_timing.json  dan  <stem>_content_list.json
  --py-dir   : folder berisi file JSON hasil Python demo_batch.py
               Format: <stem>_timing.json  dan  <stem>_content_list.json
  --output   : path file Excel output (default: benchmark/results.xlsx)

Cara pakai:
  python -m benchmark.evaluate \\
      --js-dir  benchmark/js_results \\
      --py-dir  benchmark/py_results \\
      --output  benchmark/results.xlsx
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Edit distance (pure Python)
# ---------------------------------------------------------------------------

def edit_distance(a, b) -> int:
    m, n = len(a), len(b)
    if m == 0: return n
    if n == 0: return m
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        curr = [i] + [0] * n
        for j in range(1, n + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            curr[j] = min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
        prev = curr
    return prev[n]


def ned(s_a: str, s_b: str) -> float:
    la, lb = len(s_a), len(s_b)
    denom = max(la, lb)
    if denom == 0: return 0.0
    return edit_distance(s_a, s_b) / denom


# ---------------------------------------------------------------------------
# Content-list helpers
# ---------------------------------------------------------------------------

COMPARABLE_TYPES = {"text", "equation"}


def extract_type_sequence(content_list: List[Dict]) -> List[str]:
    return [item.get("type", "unknown") for item in content_list
            if item.get("type") != "discarded"]


def extract_text(item: Dict) -> Optional[str]:
    t = item.get("type", "")
    if t in COMPARABLE_TYPES:
        return item.get("text") or item.get("content") or ""
    return None


def type_sequence_difference(cl_a: List[Dict], cl_b: List[Dict]) -> float:
    tau_a = extract_type_sequence(cl_a)
    tau_b = extract_type_sequence(cl_b)
    denom = max(len(tau_a), len(tau_b))
    if denom == 0: return 0.0
    return edit_distance(tau_a, tau_b) / denom


def mean_ned(cl_a: List[Dict], cl_b: List[Dict]) -> Tuple[float, int]:
    tau_a = extract_type_sequence(cl_a)
    tau_b = extract_type_sequence(cl_b)
    m, n = len(tau_a), len(tau_b)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1): dp[i][0] = i
    for j in range(1, n + 1): dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            cost = 0 if tau_a[i - 1] == tau_b[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)

    def non_discarded(cl):
        return [i for i, item in enumerate(cl) if item.get("type") != "discarded"]

    idx_a = non_discarded(cl_a)
    idx_b = non_discarded(cl_b)
    i, j = m, n
    pairs: List[Tuple[int, int]] = []
    while i > 0 and j > 0:
        if tau_a[i - 1] == tau_b[j - 1] and dp[i][j] == dp[i - 1][j - 1]:
            pairs.append((idx_a[i - 1], idx_b[j - 1]))
            i -= 1; j -= 1
        elif dp[i - 1][j] <= dp[i][j - 1]:
            i -= 1
        else:
            j -= 1

    ned_values = []
    for ia, ib in pairs:
        item_a, item_b = cl_a[ia], cl_b[ib]
        if item_a.get("type") != item_b.get("type"): continue
        sa, sb = extract_text(item_a), extract_text(item_b)
        if sa is None or sb is None: continue
        ned_values.append(ned(sa, sb))

    if not ned_values: return 0.0, 0
    return sum(ned_values) / len(ned_values), len(ned_values)


# ---------------------------------------------------------------------------
# Unified timing extraction (model_init EXCLUDED)
# ---------------------------------------------------------------------------

def extract_unified_timing(timing_json: Dict, system: str) -> Dict[str, float]:
    """
    Extract unified timing dict. model_init is EXCLUDED from all totals.
    total_inference_s = layout + ocr + formula + table (pure inference only).
    """
    result: Dict[str, float] = {
        "total_s": 0.0,
        "layout_s": 0.0,
        "ocr_s": 0.0,
        "formula_s": 0.0,
        "table_s": 0.0,
        "postprocess_s": 0.0,
        "total_inference_s": 0.0,
        # Stats fields (populated if available)
        "n_runs": 1,
        "std_inference_s": 0.0,
        "median_inference_s": 0.0,
        "min_inference_s": 0.0,
        "max_inference_s": 0.0,
    }

    if system == "python":
        stages = timing_json.get("stages", {})
        batches = timing_json.get("batches", [])
        result["total_s"] = timing_json.get("total_s",
            timing_json.get("total_seconds", 0.0))
        result["layout_s"] = stages.get("layout_s", stages.get("layout", 0.0))
        result["ocr_s"] = stages.get("ocr_s", stages.get("ocr", 0.0))
        result["formula_s"] = stages.get("formula_s", stages.get("formula", 0.0))
        result["table_s"] = stages.get("table_s", stages.get("table", 0.0))
        post = (sum(b.get("middle_json", 0.0) for b in batches)
                + stages.get("make_markdown", 0.0)
                + stages.get("make_content_list", 0.0))
        result["postprocess_s"] = round(post, 4)
        # Stats from repeated runs
        stats = timing_json.get("stats", {})
        result["n_runs"] = stats.get("n", 1)
        result["std_inference_s"] = stats.get("std_inference_s", 0.0)
        result["median_inference_s"] = stats.get("median_inference_s",
            result.get("total_inference_s", 0.0))
        result["min_inference_s"] = stats.get("min_inference_s", 0.0)
        result["max_inference_s"] = stats.get("max_inference_s", 0.0)

    elif system == "js":
        def ms(key): return timing_json.get(key, 0) / 1000.0
        result["total_s"] = timing_json.get("total_s", ms("total_ms"))
        result["layout_s"] = timing_json.get("layout_s", ms("layout_ms"))
        result["ocr_s"] = timing_json.get("ocr_s", ms("ocr_ms"))
        result["formula_s"] = timing_json.get("formula_s", ms("formula_ms"))
        result["table_s"] = timing_json.get("table_s", ms("table_ms"))
        result["postprocess_s"] = timing_json.get("postprocess_s", ms("postprocessing_ms"))
        stats = timing_json.get("stats", {})
        result["n_runs"] = stats.get("n", 1)
        result["std_inference_s"] = stats.get("std_inference_s", 0.0)
        result["median_inference_s"] = stats.get("median_inference_s", 0.0)
        result["min_inference_s"] = stats.get("min_inference_s", 0.0)
        result["max_inference_s"] = stats.get("max_inference_s", 0.0)

    result["total_inference_s"] = round(
        result["layout_s"] + result["ocr_s"] + result["formula_s"] + result["table_s"], 4)
    return result


# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------

def find_pairs(js_dir: Path, py_dir: Path) -> List[str]:
    def stems(d: Path) -> set:
        return {f.stem.replace("_timing", "").replace("_content_list", "")
                for f in d.glob("*.json")}
    return sorted(stems(js_dir) & stems(py_dir))


def load_json(path: Path) -> Optional[Dict]:
    if not path.exists(): return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  [WARN] Failed to read {path}: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Aggregate statistics
# ---------------------------------------------------------------------------

def agg_stats(vals: List[float]) -> Dict[str, float]:
    import statistics
    if not vals:
        return {"mean": 0, "median": 0, "std": 0, "min": 0, "max": 0}
    return {
        "mean":   round(statistics.mean(vals), 4),
        "median": round(statistics.median(vals), 4),
        "std":    round(statistics.stdev(vals) if len(vals) > 1 else 0.0, 4),
        "min":    round(min(vals), 4),
        "max":    round(max(vals), 4),
    }


# ---------------------------------------------------------------------------
# Per-document evaluation
# ---------------------------------------------------------------------------

def evaluate_document(stem: str, js_dir: Path, py_dir: Path) -> Optional[Dict[str, Any]]:
    js_timing = load_json(js_dir / f"{stem}_timing.json")
    py_timing = load_json(py_dir / f"{stem}_timing.json")
    js_cl = load_json(js_dir / f"{stem}_content_list.json")
    py_cl = load_json(py_dir / f"{stem}_content_list.json")

    if js_timing is None or py_timing is None:
        print(f"  [SKIP] {stem}: missing timing JSON", file=sys.stderr)
        return None
    if js_cl is None or py_cl is None:
        print(f"  [WARN] {stem}: missing content_list — output metrics will be 0", file=sys.stderr)
        js_cl = js_cl or []
        py_cl = py_cl or []

    js_t = extract_unified_timing(js_timing, "js")
    py_t = extract_unified_timing(py_timing, "python")

    # Use total_inference_s (model_init excluded) for comparison
    t_a = js_t["total_inference_s"]
    t_b = py_t["total_inference_s"]
    time_ratio = round(t_a / t_b, 4) if t_b > 0 else None

    tsd = round(type_sequence_difference(js_cl, py_cl), 4)
    mean_ned_val, n_pairs = mean_ned(js_cl, py_cl)
    mean_ned_val = round(mean_ned_val, 4)

    page_count = (py_timing.get("page_count") or js_timing.get("page_count") or 0)

    return {
        "document": stem,
        "page_count": page_count,
        # JS (Sistem A) — inference only
        "js_inference_s": js_t["total_inference_s"],
        "js_total_s": js_t["total_s"],
        "js_layout_s": js_t["layout_s"],
        "js_ocr_s": js_t["ocr_s"],
        "js_formula_s": js_t["formula_s"],
        "js_table_s": js_t["table_s"],
        "js_postprocess_s": js_t["postprocess_s"],
        "js_n_runs": js_t["n_runs"],
        "js_std_inference_s": js_t["std_inference_s"],
        "js_median_inference_s": js_t["median_inference_s"],
        "js_min_inference_s": js_t["min_inference_s"],
        "js_max_inference_s": js_t["max_inference_s"],
        # Python (Sistem B) — inference only
        "py_inference_s": py_t["total_inference_s"],
        "py_total_s": py_t["total_s"],
        "py_layout_s": py_t["layout_s"],
        "py_ocr_s": py_t["ocr_s"],
        "py_formula_s": py_t["formula_s"],
        "py_table_s": py_t["table_s"],
        "py_postprocess_s": py_t["postprocess_s"],
        "py_n_runs": py_t["n_runs"],
        "py_std_inference_s": py_t["std_inference_s"],
        "py_median_inference_s": py_t["median_inference_s"],
        "py_min_inference_s": py_t["min_inference_s"],
        "py_max_inference_s": py_t["max_inference_s"],
        # Comparison
        "time_ratio": time_ratio,
        "type_sequence_diff": tsd,
        "mean_ned": mean_ned_val,
        "n_comparable_pairs": n_pairs,
        "js_content_list_len": len(js_cl),
        "py_content_list_len": len(py_cl),
    }


# ---------------------------------------------------------------------------
# Excel output (rombak total)
# ---------------------------------------------------------------------------

def write_excel(rows: List[Dict], output_path: Path) -> None:
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment
        from openpyxl.utils import get_column_letter
    except ImportError:
        print("[ERROR] openpyxl not installed. Run: pip install openpyxl", file=sys.stderr)
        sys.exit(1)

    wb = openpyxl.Workbook()

    # ── Sheet 1: Per-dokumen ────────────────────────────────────────────────
    ws = wb.active
    ws.title = "Per Dokumen"

    GROUPS = [
        ("Dokumen", ["document", "page_count"]),
        ("Sistem A – JS (detik, inference only)", [
            "js_inference_s", "js_layout_s", "js_ocr_s",
            "js_formula_s", "js_table_s", "js_postprocess_s",
            "js_n_runs", "js_std_inference_s", "js_median_inference_s",
            "js_min_inference_s", "js_max_inference_s",
        ]),
        ("Sistem B – Python (detik, inference only)", [
            "py_inference_s", "py_layout_s", "py_ocr_s",
            "py_formula_s", "py_table_s", "py_postprocess_s",
            "py_n_runs", "py_std_inference_s", "py_median_inference_s",
            "py_min_inference_s", "py_max_inference_s",
        ]),
        ("Perbandingan", [
            "time_ratio", "type_sequence_diff", "mean_ned",
            "n_comparable_pairs", "js_content_list_len", "py_content_list_len",
        ]),
    ]

    LABELS = {
        "document": "Nama Dokumen", "page_count": "Halaman",
        "js_inference_s": "Inferensi", "js_layout_s": "Layout",
        "js_ocr_s": "OCR", "js_formula_s": "Formula",
        "js_table_s": "Tabel", "js_postprocess_s": "Postprocess",
        "js_n_runs": "N Run", "js_std_inference_s": "Std Dev",
        "js_median_inference_s": "Median", "js_min_inference_s": "Min",
        "js_max_inference_s": "Max",
        "py_inference_s": "Inferensi", "py_layout_s": "Layout",
        "py_ocr_s": "OCR", "py_formula_s": "Formula",
        "py_table_s": "Tabel", "py_postprocess_s": "Postprocess",
        "py_n_runs": "N Run", "py_std_inference_s": "Std Dev",
        "py_median_inference_s": "Median", "py_min_inference_s": "Min",
        "py_max_inference_s": "Max",
        "time_ratio": "Rasio (A/B)", "type_sequence_diff": "Type Seq. Diff.",
        "mean_ned": "Mean NED", "n_comparable_pairs": "N Pasang",
        "js_content_list_len": "CL JS", "py_content_list_len": "CL Py",
    }

    GROUP_COLORS = {
        "Dokumen": "4472C4",
        "Sistem A – JS (detik, inference only)": "70AD47",
        "Sistem B – Python (detik, inference only)": "ED7D31",
        "Perbandingan": "FFC000",
    }

    all_keys: List[str] = []
    for _, keys in GROUPS:
        all_keys.extend(keys)

    col = 1
    for group_name, keys in GROUPS:
        ws.merge_cells(start_row=1, start_column=col, end_row=1, end_column=col + len(keys) - 1)
        cell = ws.cell(row=1, column=col, value=group_name)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor=GROUP_COLORS.get(group_name, "808080"))
        cell.alignment = Alignment(horizontal="center", vertical="center")
        col += len(keys)

    for c, key in enumerate(all_keys, start=1):
        cell = ws.cell(row=2, column=c, value=LABELS.get(key, key))
        cell.font = Font(bold=True)
        cell.alignment = Alignment(horizontal="center", wrap_text=True)
        cell.fill = PatternFill("solid", fgColor="D9D9D9")

    for r, row in enumerate(rows, start=3):
        for c, key in enumerate(all_keys, start=1):
            val = row.get(key)
            cell = ws.cell(row=r, column=c, value=val)
            cell.alignment = Alignment(horizontal="center")
            if key == "time_ratio" and val is not None:
                cell.fill = PatternFill("solid", fgColor="FFCCCC" if val > 1 else "CCFFCC")

    for c in range(1, len(all_keys) + 1):
        max_len = max((len(str(ws.cell(row=r, column=c).value or ""))
                       for r in range(1, len(rows) + 3)), default=8)
        ws.column_dimensions[get_column_letter(c)].width = min(max(max_len + 2, 10), 28)

    ws.row_dimensions[1].height = 22
    ws.row_dimensions[2].height = 32
    ws.freeze_panes = "A3"

    # ── Sheet 2: Statistik Agregat ──────────────────────────────────────────
    ws2 = wb.create_sheet("Statistik Agregat")
    stat_keys = [
        ("js_inference_s", "JS Inferensi (s)"),
        ("py_inference_s", "Python Inferensi (s)"),
        ("time_ratio", "Rasio Waktu (A/B)"),
        ("js_layout_s", "JS Layout (s)"),
        ("py_layout_s", "Python Layout (s)"),
        ("js_ocr_s", "JS OCR (s)"),
        ("py_ocr_s", "Python OCR (s)"),
        ("js_formula_s", "JS Formula (s)"),
        ("py_formula_s", "Python Formula (s)"),
        ("js_table_s", "JS Tabel (s)"),
        ("py_table_s", "Python Tabel (s)"),
        ("type_sequence_diff", "Type Seq. Diff."),
        ("mean_ned", "Mean NED"),
    ]
    for c, h in enumerate(["Metrik", "Rata-rata", "Median", "Std. Dev.", "Min", "Max"], start=1):
        cell = ws2.cell(row=1, column=c, value=h)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="4472C4")
        cell.alignment = Alignment(horizontal="center")
    for r, (key, label) in enumerate(stat_keys, start=2):
        stats = agg_stats([row[key] for row in rows if row.get(key) is not None])
        ws2.cell(row=r, column=1, value=label)
        ws2.cell(row=r, column=2, value=stats["mean"])
        ws2.cell(row=r, column=3, value=stats["median"])
        ws2.cell(row=r, column=4, value=stats["std"])
        ws2.cell(row=r, column=5, value=stats["min"])
        ws2.cell(row=r, column=6, value=stats["max"])
    for c in range(1, 7):
        ws2.column_dimensions[get_column_letter(c)].width = 24

    # ── Sheet 3: Content List Diff ──────────────────────────────────────────
    ws3 = wb.create_sheet("Content List Diff")
    ws3.append(["Dokumen", "Halaman", "CL JS", "CL Python",
                "Type Seq. Diff.", "Mean NED", "N Pasang",
                "Tipe JS (urutan)", "Tipe Python (urutan)"])
    for cell in ws3[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="4472C4")
    for row in rows:
        js_cl_path = Path(row.get("_js_dir", "")) / f"{row['document']}_content_list.json"
        py_cl_path = Path(row.get("_py_dir", "")) / f"{row['document']}_content_list.json"
        js_types = py_types = ""
        try:
            if js_cl_path.exists():
                cl = json.loads(js_cl_path.read_text(encoding="utf-8"))
                js_types = " → ".join(extract_type_sequence(cl))
        except Exception: pass
        try:
            if py_cl_path.exists():
                cl = json.loads(py_cl_path.read_text(encoding="utf-8"))
                py_types = " → ".join(extract_type_sequence(cl))
        except Exception: pass
        ws3.append([row["document"], row["page_count"],
                    row["js_content_list_len"], row["py_content_list_len"],
                    row["type_sequence_diff"], row["mean_ned"],
                    row["n_comparable_pairs"], js_types, py_types])
    ws3.column_dimensions["A"].width = 30
    ws3.column_dimensions["H"].width = 60
    ws3.column_dimensions["I"].width = 60

    output_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(output_path)
    print(f"[evaluate] Excel saved → {output_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate JS vs Python pipeline output (skripsi benchmark).",
    )
    parser.add_argument("--js-dir", required=True, type=Path)
    parser.add_argument("--py-dir", required=True, type=Path)
    parser.add_argument("--output", default=Path("benchmark/results.xlsx"), type=Path)
    args = parser.parse_args()

    js_dir, py_dir = args.js_dir, args.py_dir
    if not js_dir.exists():
        print(f"[ERROR] JS dir not found: {js_dir}", file=sys.stderr); sys.exit(1)
    if not py_dir.exists():
        print(f"[ERROR] Python dir not found: {py_dir}", file=sys.stderr); sys.exit(1)

    stems = find_pairs(js_dir, py_dir)
    if not stems:
        print("[ERROR] No matching document stems found.", file=sys.stderr); sys.exit(1)

    print(f"[evaluate] Found {len(stems)} document(s): {', '.join(stems)}")

    rows: List[Dict] = []
    for stem in stems:
        print(f"  Processing: {stem}")
        result = evaluate_document(stem, js_dir, py_dir)
        if result is not None:
            result["_js_dir"] = str(js_dir)
            result["_py_dir"] = str(py_dir)
            rows.append(result)

    if not rows:
        print("[ERROR] No documents could be evaluated.", file=sys.stderr); sys.exit(1)

    clean_rows = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]
    write_excel(rows, args.output)

    print()
    print("=" * 60)
    print(f"  Evaluated {len(rows)} document(s)")
    print(f"  Avg time ratio (JS/Py inference): {agg_stats([r['time_ratio'] for r in clean_rows if r.get('time_ratio')])['mean']:.3f}")
    print(f"  Avg type seq. diff:               {agg_stats([r['type_sequence_diff'] for r in clean_rows])['mean']:.4f}")
    print(f"  Avg mean NED:                     {agg_stats([r['mean_ned'] for r in clean_rows])['mean']:.4f}")
    print("=" * 60)


if __name__ == "__main__":
    main()
