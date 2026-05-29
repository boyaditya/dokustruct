"""
benchmark/evaluate.py
=====================
Evaluasi komparatif Sistem A (JS/browser) vs Sistem B (Python) untuk skripsi.

Metrik per dokumen (mean atas N run):
  WAKTU
    - total_inference_s (layout+ocr+formula+table) dan rasio T_A / T_B
    - inference per halaman (s/halaman)
    - cold-start / model_init sebagai metrik headline terpisah (bukan dibuang)
  KESEPADANAN OUTPUT (alignment per-halaman, content-aware)
    - Type Sequence Difference
    - Coverage precision / recall / F1 (menangkap item hilang / berlebih)
    - Mean NED raw & ternormalisasi (NFC + whitespace collapse)
    - CER / WER (referensi = Python)
    - TEDS untuk tabel
    - Mean bbox IoU
    - Korelasi urutan baca (Kendall tau, Spearman rho)
  STATISTIK AGREGAT
    - geometric mean untuk rasio (menghindari bias mean-of-ratios)
    - uji Wilcoxon signed-rank (JS vs Python) + effect size

Selain Excel, tiap dokumen menghasilkan dump diff per-item (string output)
untuk audit di benchmark/diffs/<stem>_diff.json.

Pemakaian:
  python -m benchmark.evaluate \
      --js-dir  benchmark/js_results \
      --py-dir  benchmark/py_results \
      --output  benchmark/results.xlsx

Mendukung input JS berupa file gabungan benchmark_js_*.json (kunci "files"):
  python -m benchmark.evaluate --js-combined benchmark/js_results/benchmark_js_x.json ...
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# Make console output robust on Windows (cp1252) so unicode in document names
# and arrow glyphs in log lines do not crash the run when stdout is piped.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:
        pass

from .alignment import align_content_lists, extract_type_sequence
from .metrics import edit_distance, geometric_mean, wilcoxon_signed_rank
from .gt_scoring import score_against_gt


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------

def load_json(path: Path) -> Optional[Any]:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  [WARN] Failed to read {path}: {e}", file=sys.stderr)
        return None


def explode_js_combined(js_dir: Path) -> None:
    """If a combined benchmark_js_*.json exists, split it into per-stem
    <stem>_timing.json + <stem>_content_list.json so discovery works."""
    for combined in js_dir.glob("benchmark_js_*.json"):
        data = load_json(combined)
        if not isinstance(data, dict) or "files" not in data:
            continue
        meta = data.get("metadata", {})
        for stem, payload in (data.get("files") or {}).items():
            timing = payload.get("timing", {}) or {}
            # propagate run-level metadata into per-file timing if absent
            timing.setdefault("metadata", meta)
            timing.setdefault("run_config", meta)
            (js_dir / f"{stem}_timing.json").write_text(
                json.dumps(timing, ensure_ascii=False, indent=2), encoding="utf-8")
            (js_dir / f"{stem}_content_list.json").write_text(
                json.dumps(payload.get("content_list", []), ensure_ascii=False, indent=2),
                encoding="utf-8")
        print(f"[evaluate] Exploded combined export: {combined.name}")


def find_pairs(js_dir: Path, py_dir: Path) -> List[str]:
    def stems(d: Path) -> set:
        return {f.name.replace("_timing.json", "").replace("_content_list.json", "")
                for f in d.glob("*.json")
                if f.name.endswith(("_timing.json", "_content_list.json"))}
    return sorted(stems(js_dir) & stems(py_dir))


# ---------------------------------------------------------------------------
# Unified timing extraction
# ---------------------------------------------------------------------------

def extract_timing(timing_json: Dict, system: str) -> Dict[str, float]:
    """Extract a unified timing dict.

    total_inference_s = layout + ocr + formula + table (model_init EXCLUDED).
    model_init is kept separately as the cold-start headline metric.
    """
    r: Dict[str, Any] = {
        "total_s": 0.0, "model_init_s": 0.0,
        "layout_s": 0.0, "ocr_s": 0.0, "formula_s": 0.0, "table_s": 0.0,
        "postprocess_s": 0.0, "total_inference_s": 0.0,
        "page_count": 0,
        "n_runs": 1, "std_inference_s": 0.0, "cv_inference": 0.0,
        "median_inference_s": 0.0, "min_inference_s": 0.0, "max_inference_s": 0.0,
    }

    if system == "python":
        stages = timing_json.get("stages", {})
        batches = timing_json.get("batches", [])
        # New schema (demo_batch unified) takes precedence; fall back to raw stages.
        r["total_s"] = timing_json.get("total_s", timing_json.get("total_seconds", 0.0))
        r["model_init_s"] = timing_json.get("model_init_s", stages.get("model_init", 0.0))
        r["layout_s"] = timing_json.get("layout_s", stages.get("layout_s", stages.get("layout", 0.0)))
        r["ocr_s"] = timing_json.get("ocr_s", stages.get("ocr_s", stages.get("ocr", 0.0)))
        r["formula_s"] = timing_json.get("formula_s", stages.get("formula_s", stages.get("formula", 0.0)))
        r["table_s"] = timing_json.get("table_s", stages.get("table_s", stages.get("table", 0.0)))
        if "postprocess_s" in timing_json:
            r["postprocess_s"] = timing_json["postprocess_s"]
        else:
            r["postprocess_s"] = round(
                sum(b.get("middle_json", 0.0) for b in batches)
                + stages.get("make_markdown", 0.0)
                + stages.get("make_content_list", 0.0), 4)
    else:  # js
        def ms(key):
            return timing_json.get(key, 0) / 1000.0
        r["total_s"] = timing_json.get("total_s", ms("total_ms"))
        r["model_init_s"] = timing_json.get("model_init_s", ms("model_init_ms"))
        r["layout_s"] = timing_json.get("layout_s", ms("layout_ms"))
        r["ocr_s"] = timing_json.get("ocr_s", ms("ocr_ms"))
        r["formula_s"] = timing_json.get("formula_s", ms("formula_ms"))
        r["table_s"] = timing_json.get("table_s", ms("table_ms"))
        r["postprocess_s"] = timing_json.get("postprocess_s", ms("postprocessing_ms"))

    r["page_count"] = timing_json.get("page_count") or 0
    stats = timing_json.get("stats", {})
    r["n_runs"] = stats.get("n", 1)
    r["std_inference_s"] = stats.get("std_inference_s", 0.0)
    r["median_inference_s"] = stats.get("median_inference_s", 0.0)
    r["min_inference_s"] = stats.get("min_inference_s", 0.0)
    r["max_inference_s"] = stats.get("max_inference_s", 0.0)

    r["total_inference_s"] = round(
        r["layout_s"] + r["ocr_s"] + r["formula_s"] + r["table_s"], 4)
    # coefficient of variation = stability indicator
    r["cv_inference"] = round(r["std_inference_s"] / r["total_inference_s"], 4) \
        if r["total_inference_s"] > 0 else 0.0
    return r


def _run_config(timing_json: Dict) -> Dict[str, Any]:
    cfg = timing_json.get("run_config") or timing_json.get("metadata") or {}
    return {
        "formula_enable": cfg.get("formula_enable"),
        "table_enable": cfg.get("table_enable"),
        "parse_method": cfg.get("parse_method"),
        "execution_provider": cfg.get("execution_provider"),
        "real_eps": cfg.get("real_eps") or cfg.get("ort_providers"),
    }


def _config_mismatch(js_cfg: Dict, py_cfg: Dict) -> List[str]:
    issues = []
    for key in ("formula_enable", "table_enable", "parse_method"):
        ja, pb = js_cfg.get(key), py_cfg.get(key)
        if ja is None or pb is None:
            continue
        if ja != pb:
            issues.append(f"{key}: JS={ja} vs PY={pb}")
    return issues


# ---------------------------------------------------------------------------
# Per-document evaluation
# ---------------------------------------------------------------------------

def type_sequence_difference(cl_a: List[Dict], cl_b: List[Dict]) -> float:
    ta = extract_type_sequence(cl_a)
    tb = extract_type_sequence(cl_b)
    denom = max(len(ta), len(tb))
    return round(edit_distance(ta, tb) / denom, 4) if denom else 0.0


def evaluate_document(stem: str, js_dir: Path, py_dir: Path,
                      diffs_dir: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    js_timing = load_json(js_dir / f"{stem}_timing.json")
    py_timing = load_json(py_dir / f"{stem}_timing.json")
    js_cl = load_json(js_dir / f"{stem}_content_list.json")
    py_cl = load_json(py_dir / f"{stem}_content_list.json")

    if js_timing is None or py_timing is None:
        print(f"  [SKIP] {stem}: missing timing JSON", file=sys.stderr)
        return None
    if js_cl is None or py_cl is None:
        print(f"  [WARN] {stem}: missing content_list — output metrics = 0", file=sys.stderr)
        js_cl = js_cl or []
        py_cl = py_cl or []

    js_t = extract_timing(js_timing, "js")
    py_t = extract_timing(py_timing, "python")

    # config consistency (C2)
    js_cfg, py_cfg = _run_config(js_timing), _run_config(py_timing)
    mismatch = _config_mismatch(js_cfg, py_cfg)
    if mismatch:
        print(f"  [WARN] {stem}: config mismatch → {'; '.join(mismatch)}", file=sys.stderr)

    t_a = js_t["total_inference_s"]
    t_b = py_t["total_inference_s"]
    time_ratio = round(t_a / t_b, 4) if t_b > 0 else None

    page_count = py_t["page_count"] or js_t["page_count"] or 0
    js_per_page = round(t_a / page_count, 4) if page_count else 0.0
    py_per_page = round(t_b / page_count, 4) if page_count else 0.0

    # cold-start headline (A2)
    js_cold = round(js_t["model_init_s"] + t_a, 4)
    py_cold = round(py_t["model_init_s"] + t_b, 4)
    cold_ratio = round(js_cold / py_cold, 4) if py_cold > 0 else None

    # output equivalence (alignment per page, content-aware)
    align = align_content_lists(js_cl, py_cl)
    tsd = type_sequence_difference(js_cl, py_cl)

    # dump per-item diff (the string dump) for auditing
    if diffs_dir is not None:
        diffs_dir.mkdir(parents=True, exist_ok=True)
        (diffs_dir / f"{stem}_diff.json").write_text(
            json.dumps({
                "document": stem,
                "config": {"js": js_cfg, "py": py_cfg, "mismatch": mismatch},
                "summary": {k: v for k, v in align.items() if k != "diff_items"},
                "items": align["diff_items"],
            }, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "document": stem,
        "page_count": page_count,
        "config_mismatch": "; ".join(mismatch) if mismatch else "",
        # JS timing
        "js_inference_s": t_a,
        "js_per_page_s": js_per_page,
        "js_model_init_s": js_t["model_init_s"],
        "js_cold_start_s": js_cold,
        "js_layout_s": js_t["layout_s"],
        "js_ocr_s": js_t["ocr_s"],
        "js_formula_s": js_t["formula_s"],
        "js_table_s": js_t["table_s"],
        "js_postprocess_s": js_t["postprocess_s"],
        "js_n_runs": js_t["n_runs"],
        "js_std_inference_s": js_t["std_inference_s"],
        "js_cv_inference": js_t["cv_inference"],
        "js_median_inference_s": js_t["median_inference_s"],
        "js_min_inference_s": js_t["min_inference_s"],
        "js_max_inference_s": js_t["max_inference_s"],
        # Python timing
        "py_inference_s": t_b,
        "py_per_page_s": py_per_page,
        "py_model_init_s": py_t["model_init_s"],
        "py_cold_start_s": py_cold,
        "py_layout_s": py_t["layout_s"],
        "py_ocr_s": py_t["ocr_s"],
        "py_formula_s": py_t["formula_s"],
        "py_table_s": py_t["table_s"],
        "py_postprocess_s": py_t["postprocess_s"],
        "py_n_runs": py_t["n_runs"],
        "py_std_inference_s": py_t["std_inference_s"],
        "py_cv_inference": py_t["cv_inference"],
        "py_median_inference_s": py_t["median_inference_s"],
        "py_min_inference_s": py_t["min_inference_s"],
        "py_max_inference_s": py_t["max_inference_s"],
        # Comparison — time
        "time_ratio": time_ratio,
        "cold_start_ratio": cold_ratio,
        # Comparison — output equivalence
        "type_sequence_diff": tsd,
        "coverage_precision": align["coverage_precision"],
        "coverage_recall": align["coverage_recall"],
        "coverage_f1": align["coverage_f1"],
        "type_consistency": align["type_consistency"],
        "mean_ned_raw": align["mean_ned_raw"],
        "mean_ned_norm": align["mean_ned_norm"],
        "n_text_pairs": align["n_text_pairs"],
        "mean_cer": align["mean_cer"],
        "mean_wer": align["mean_wer"],
        "mean_teds": align["mean_teds"],
        "n_table_pairs": align["n_table_pairs"],
        "mean_bbox_iou": align["mean_bbox_iou"],
        "n_bbox_pairs": align["n_bbox_pairs"],
        "reading_order_kendall_tau": align["reading_order_kendall_tau"],
        "reading_order_spearman_rho": align["reading_order_spearman_rho"],
        "n_only_js": align["n_only_js"],
        "n_only_python": align["n_only_python"],
        "js_content_list_len": len(js_cl),
        "py_content_list_len": len(py_cl),
        "_js_dir": str(js_dir),
        "_py_dir": str(py_dir),
    }


# ---------------------------------------------------------------------------
# Aggregate statistics
# ---------------------------------------------------------------------------

def agg_stats(vals: List[float]) -> Dict[str, float]:
    import statistics
    vals = [v for v in vals if v is not None]
    if not vals:
        return {"mean": 0, "median": 0, "std": 0, "min": 0, "max": 0, "geomean": 0}
    return {
        "mean": round(statistics.mean(vals), 4),
        "median": round(statistics.median(vals), 4),
        "std": round(statistics.stdev(vals) if len(vals) > 1 else 0.0, 4),
        "min": round(min(vals), 4),
        "max": round(max(vals), 4),
        "geomean": round(geometric_mean(vals), 4),
    }


# ---------------------------------------------------------------------------
# Excel writer
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
    HDR = Font(bold=True, color="FFFFFF")
    BLUE = PatternFill("solid", fgColor="4472C4")

    # ── Sheet 1: Per Dokumen ────────────────────────────────────────────────
    ws = wb.active
    ws.title = "Per Dokumen"
    GROUPS = [
        ("Dokumen", "4472C4", ["document", "page_count", "config_mismatch"]),
        ("Sistem A – JS (s)", "70AD47", [
            "js_inference_s", "js_per_page_s", "js_layout_s", "js_ocr_s",
            "js_formula_s", "js_table_s", "js_postprocess_s",
            "js_model_init_s", "js_cold_start_s",
            "js_n_runs", "js_std_inference_s", "js_cv_inference",
            "js_median_inference_s", "js_min_inference_s", "js_max_inference_s"]),
        ("Sistem B – Python (s)", "ED7D31", [
            "py_inference_s", "py_per_page_s", "py_layout_s", "py_ocr_s",
            "py_formula_s", "py_table_s", "py_postprocess_s",
            "py_model_init_s", "py_cold_start_s",
            "py_n_runs", "py_std_inference_s", "py_cv_inference",
            "py_median_inference_s", "py_min_inference_s", "py_max_inference_s"]),
        ("Waktu (A/B)", "FFC000", ["time_ratio", "cold_start_ratio"]),
        ("Kesepadanan Output", "7030A0", [
            "type_sequence_diff", "coverage_precision", "coverage_recall",
            "coverage_f1", "type_consistency", "mean_ned_raw", "mean_ned_norm",
            "n_text_pairs", "mean_cer", "mean_wer", "mean_teds", "n_table_pairs",
            "mean_bbox_iou", "n_bbox_pairs", "reading_order_kendall_tau",
            "reading_order_spearman_rho", "n_only_js", "n_only_python",
            "js_content_list_len", "py_content_list_len"]),
    ]
    LABELS = {
        "document": "Nama Dokumen", "page_count": "Halaman", "config_mismatch": "Config Mismatch",
        "js_inference_s": "Inferensi", "js_per_page_s": "Inf/Halaman",
        "js_layout_s": "Layout", "js_ocr_s": "OCR", "js_formula_s": "Formula",
        "js_table_s": "Tabel", "js_postprocess_s": "Postprocess",
        "js_model_init_s": "Model Init", "js_cold_start_s": "Cold Start",
        "js_n_runs": "N Run", "js_std_inference_s": "Std", "js_cv_inference": "CV",
        "js_median_inference_s": "Median", "js_min_inference_s": "Min", "js_max_inference_s": "Max",
        "py_inference_s": "Inferensi", "py_per_page_s": "Inf/Halaman",
        "py_layout_s": "Layout", "py_ocr_s": "OCR", "py_formula_s": "Formula",
        "py_table_s": "Tabel", "py_postprocess_s": "Postprocess",
        "py_model_init_s": "Model Init", "py_cold_start_s": "Cold Start",
        "py_n_runs": "N Run", "py_std_inference_s": "Std", "py_cv_inference": "CV",
        "py_median_inference_s": "Median", "py_min_inference_s": "Min", "py_max_inference_s": "Max",
        "time_ratio": "Rasio Inferensi", "cold_start_ratio": "Rasio Cold Start",
        "type_sequence_diff": "Type Seq. Diff.", "coverage_precision": "Cov. Precision",
        "coverage_recall": "Cov. Recall", "coverage_f1": "Cov. F1",
        "type_consistency": "Type Consistency", "mean_ned_raw": "NED (raw)",
        "mean_ned_norm": "NED (norm)", "n_text_pairs": "N Pasang Teks",
        "mean_cer": "CER", "mean_wer": "WER", "mean_teds": "TEDS",
        "n_table_pairs": "N Tabel", "mean_bbox_iou": "BBox IoU", "n_bbox_pairs": "N BBox",
        "reading_order_kendall_tau": "Kendall τ", "reading_order_spearman_rho": "Spearman ρ",
        "n_only_js": "Hanya JS", "n_only_python": "Hanya Py",
        "js_content_list_len": "CL JS", "py_content_list_len": "CL Py",
    }
    all_keys: List[str] = []
    for _, _, keys in GROUPS:
        all_keys.extend(keys)
    col = 1
    for name, color, keys in GROUPS:
        ws.merge_cells(start_row=1, start_column=col, end_row=1, end_column=col + len(keys) - 1)
        c = ws.cell(row=1, column=col, value=name)
        c.font = HDR
        c.fill = PatternFill("solid", fgColor=color)
        c.alignment = Alignment(horizontal="center", vertical="center")
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
            if key in ("time_ratio", "cold_start_ratio") and val is not None:
                cell.fill = PatternFill("solid", fgColor="FFCCCC" if val > 1 else "CCFFCC")
            if key == "config_mismatch" and val:
                cell.fill = PatternFill("solid", fgColor="FF9999")
    for c in range(1, len(all_keys) + 1):
        max_len = max((len(str(ws.cell(row=r, column=c).value or ""))
                       for r in range(2, len(rows) + 3)), default=8)
        ws.column_dimensions[get_column_letter(c)].width = min(max(max_len + 2, 9), 26)
    ws.row_dimensions[1].height = 22
    ws.row_dimensions[2].height = 30
    ws.freeze_panes = "D3"

    # ── Sheet 2: Statistik Agregat ──────────────────────────────────────────
    ws2 = wb.create_sheet("Statistik Agregat")
    stat_keys = [
        ("js_inference_s", "JS Inferensi (s)"), ("py_inference_s", "Py Inferensi (s)"),
        ("js_per_page_s", "JS Inf/Halaman (s)"), ("py_per_page_s", "Py Inf/Halaman (s)"),
        ("time_ratio", "Rasio Inferensi (A/B)"),
        ("js_cold_start_s", "JS Cold Start (s)"), ("py_cold_start_s", "Py Cold Start (s)"),
        ("cold_start_ratio", "Rasio Cold Start (A/B)"),
        ("js_model_init_s", "JS Model Init (s)"), ("py_model_init_s", "Py Model Init (s)"),
        ("type_sequence_diff", "Type Seq. Diff."),
        ("coverage_f1", "Coverage F1"), ("type_consistency", "Type Consistency"),
        ("mean_ned_norm", "Mean NED (norm)"), ("mean_cer", "Mean CER"),
        ("mean_wer", "Mean WER"), ("mean_teds", "Mean TEDS"),
        ("mean_bbox_iou", "Mean BBox IoU"),
        ("reading_order_kendall_tau", "Reading Order Kendall τ"),
    ]
    headers = ["Metrik", "Rata-rata", "Median", "Geomean", "Std. Dev.", "Min", "Max"]
    for c, h in enumerate(headers, start=1):
        cell = ws2.cell(row=1, column=c, value=h)
        cell.font = HDR
        cell.fill = BLUE
        cell.alignment = Alignment(horizontal="center")
    for r, (key, label) in enumerate(stat_keys, start=2):
        st = agg_stats([row.get(key) for row in rows])
        ws2.cell(row=r, column=1, value=label)
        ws2.cell(row=r, column=2, value=st["mean"])
        ws2.cell(row=r, column=3, value=st["median"])
        ws2.cell(row=r, column=4, value=st["geomean"])
        ws2.cell(row=r, column=5, value=st["std"])
        ws2.cell(row=r, column=6, value=st["min"])
        ws2.cell(row=r, column=7, value=st["max"])
    for c in range(1, 8):
        ws2.column_dimensions[get_column_letter(c)].width = 22

    # Note on geomean for ratios
    note_row = len(stat_keys) + 3
    ws2.cell(row=note_row, column=1,
             value="Catatan: untuk rasio gunakan Geomean (mean-of-ratios bias).").font = Font(italic=True)

    # ── Sheet 3: Uji Statistik ──────────────────────────────────────────────
    ws4 = wb.create_sheet("Uji Statistik")
    ws4.append(["Uji Wilcoxon signed-rank (paired, JS vs Python) atas dokumen"])
    ws4["A1"].font = Font(bold=True)
    ws4.append([])
    ws4.append(["Metrik", "N Pasang", "Statistik W", "p-value", "Effect size r",
                "Median selisih (A-B)", "Signifikan (α=0.05)", "Catatan"])
    for cell in ws4[3]:
        cell.font = HDR
        cell.fill = BLUE
    test_metrics = [
        ("js_inference_s", "py_inference_s", "Inferensi (s)"),
        ("js_per_page_s", "py_per_page_s", "Inferensi per halaman (s)"),
        ("js_cold_start_s", "py_cold_start_s", "Cold start (s)"),
        ("js_layout_s", "py_layout_s", "Layout (s)"),
        ("js_ocr_s", "py_ocr_s", "OCR (s)"),
    ]
    for ka, kb, label in test_metrics:
        a = [r.get(ka) for r in rows]
        b = [r.get(kb) for r in rows]
        res = wilcoxon_signed_rank(a, b)
        sig = ""
        if res["p_value"] is not None:
            sig = "ya" if res["p_value"] < 0.05 else "tidak"
        ws4.append([label, res["n_pairs"], res["statistic"], res["p_value"],
                    res["effect_size_r"], res["median_diff"], sig, res["note"]])
    for c in range(1, 9):
        ws4.column_dimensions[get_column_letter(c)].width = 22

    # ── Sheet 4: Content List Diff (ringkas) ────────────────────────────────
    ws3 = wb.create_sheet("Content List Diff")
    ws3.append(["Dokumen", "Halaman", "CL JS", "CL Py", "Hanya JS", "Hanya Py",
                "Type Seq. Diff.", "Cov F1", "NED norm", "CER", "TEDS",
                "Tipe JS (urutan)", "Tipe Python (urutan)"])
    for cell in ws3[1]:
        cell.font = HDR
        cell.fill = BLUE
    for row in rows:
        js_types = py_types = ""
        jp = Path(row.get("_js_dir", "")) / f"{row['document']}_content_list.json"
        pp = Path(row.get("_py_dir", "")) / f"{row['document']}_content_list.json"
        try:
            if jp.exists():
                js_types = " → ".join(extract_type_sequence(json.loads(jp.read_text(encoding="utf-8"))))
        except Exception:
            pass
        try:
            if pp.exists():
                py_types = " → ".join(extract_type_sequence(json.loads(pp.read_text(encoding="utf-8"))))
        except Exception:
            pass
        ws3.append([row["document"], row["page_count"], row["js_content_list_len"],
                    row["py_content_list_len"], row["n_only_js"], row["n_only_python"],
                    row["type_sequence_diff"], row["coverage_f1"], row["mean_ned_norm"],
                    row["mean_cer"], row["mean_teds"], js_types, py_types])
    ws3.column_dimensions["A"].width = 28
    ws3.column_dimensions["L"].width = 55
    ws3.column_dimensions["M"].width = 55

    output_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(output_path)
    print(f"[evaluate] Excel saved → {output_path}")


# ---------------------------------------------------------------------------
# OmniDocBench ground-truth scoring (absolute accuracy)
# ---------------------------------------------------------------------------

def _load_gt_index(gt_dir: Path) -> Dict[str, Dict[str, Any]]:
    idx_path = gt_dir / "omnidocbench_index.json"
    if idx_path.exists():
        try:
            return json.loads(idx_path.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def evaluate_against_gt(stem: str, sys_dir: Path, gt_dir: Path,
                        system_label: str,
                        diffs_dir: Optional[Path] = None,
                        gt_index: Optional[Dict] = None) -> Optional[Dict[str, Any]]:
    sys_cl = load_json(sys_dir / f"{stem}_content_list.json")
    gt_cl = load_json(gt_dir / f"{stem}_content_list.json")
    if sys_cl is None or gt_cl is None:
        return None
    score = score_against_gt(sys_cl, gt_cl)

    if diffs_dir is not None:
        diffs_dir.mkdir(parents=True, exist_ok=True)
        (diffs_dir / f"{stem}_{system_label}_vs_gt.json").write_text(
            json.dumps({
                "document": stem,
                "system": system_label,
                "summary": {k: v for k, v in score.items() if k != "diff_items"},
                "items": score["diff_items"],
            }, ensure_ascii=False, indent=2), encoding="utf-8")

    meta = (gt_index or {}).get(stem, {})
    row = {k: v for k, v in score.items() if k != "diff_items"}
    row.update({
        "document": stem,
        "system": system_label,
        "data_source": meta.get("data_source"),
        "language": meta.get("language"),
        "layout": meta.get("layout"),
    })
    return row


def run_gt_evaluation(js_dir: Path, py_dir: Path, gt_dir: Path,
                      output: Path, diffs_dir: Path) -> Dict[str, List[Dict]]:
    """Score BOTH systems against OmniDocBench GT. Returns {'js': [...], 'py': [...]}.
    Writes a separate Excel with per-document + per-category + per-language sheets.
    """
    gt_index = _load_gt_index(gt_dir)
    gt_stems = {f.name.replace("_content_list.json", "")
                for f in gt_dir.glob("*_content_list.json")}

    out: Dict[str, List[Dict]] = {"js": [], "py": []}
    for label, sys_dir in (("js", js_dir), ("py", py_dir)):
        sys_stems = {f.name.replace("_content_list.json", "")
                     for f in sys_dir.glob("*_content_list.json")}
        common = sorted(gt_stems & sys_stems)
        for stem in common:
            row = evaluate_against_gt(stem, sys_dir, gt_dir, label,
                                      diffs_dir=diffs_dir, gt_index=gt_index)
            if row is not None:
                out[label].append(row)

    write_gt_excel(out, output)
    return out


def _gt_agg(rows: List[Dict], key: str) -> Dict[str, float]:
    return agg_stats([r.get(key) for r in rows])


def write_gt_excel(scores: Dict[str, List[Dict]], output_path: Path) -> None:
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment
        from openpyxl.utils import get_column_letter
    except ImportError:
        print("[ERROR] openpyxl not installed.", file=sys.stderr)
        return

    wb = openpyxl.Workbook()
    HDR = Font(bold=True, color="FFFFFF")
    BLUE = PatternFill("solid", fgColor="4472C4")
    GREEN = PatternFill("solid", fgColor="70AD47")

    metric_keys = [
        ("overall", "Overall (0-100)"),
        ("text_edit", "Text Edit ↓"),
        ("text_cer", "Text CER ↓"),
        ("formula_edit", "Formula Edit ↓"),
        ("table_teds", "Table TEDS ↑"),
        ("reading_order_edit", "Reading Order Edit ↓"),
        ("coverage_f1", "Coverage F1 ↑"),
        ("mean_bbox_iou", "BBox IoU ↑"),
    ]

    # ── Sheet 1: Per Dokumen (both systems) ─────────────────────────────────
    ws = wb.active
    ws.title = "Akurasi vs GT (Per Dok)"
    head = ["Dokumen", "Sistem", "Doc Type", "Bahasa"] + [lbl for _, lbl in metric_keys] \
        + ["N Teks", "N Tabel", "Hanya Pred", "Hanya GT"]
    ws.append(head)
    for cell in ws[1]:
        cell.font = HDR
        cell.fill = BLUE
        cell.alignment = Alignment(horizontal="center", wrap_text=True)
    for label in ("js", "py"):
        for r in scores.get(label, []):
            ws.append([
                r.get("document"), label.upper(), r.get("data_source"), r.get("language"),
                *[r.get(k) for k, _ in metric_keys],
                r.get("n_text_pairs"), r.get("n_table_pairs"),
                r.get("n_only_pred"), r.get("n_only_gt"),
            ])
    ws.freeze_panes = "E2"
    for c in range(1, len(head) + 1):
        ws.column_dimensions[get_column_letter(c)].width = 15

    # ── Sheet 2: Ringkasan per Sistem ───────────────────────────────────────
    ws2 = wb.create_sheet("Ringkasan per Sistem")
    ws2.append(["Sistem", "N Dok"] + [lbl for _, lbl in metric_keys])
    for cell in ws2[1]:
        cell.font = HDR
        cell.fill = GREEN
    for label in ("js", "py"):
        rows = scores.get(label, [])
        if not rows:
            continue
        ws2.append([label.upper(), len(rows)] +
                   [_gt_agg(rows, k)["mean"] for k, _ in metric_keys])
    for c in range(1, len(metric_keys) + 3):
        ws2.column_dimensions[get_column_letter(c)].width = 16

    # ── Sheet 3: Per Kategori Dokumen ───────────────────────────────────────
    ws3 = wb.create_sheet("Per Kategori Dokumen")
    _write_strata_sheet(ws3, scores, "data_source", metric_keys, HDR, BLUE)

    # ── Sheet 4: Per Bahasa ─────────────────────────────────────────────────
    ws4 = wb.create_sheet("Per Bahasa")
    _write_strata_sheet(ws4, scores, "language", metric_keys, HDR, BLUE)

    # ── Sheet 5: JS vs Py vs GT (head-to-head) ──────────────────────────────
    ws5 = wb.create_sheet("JS vs Py (vs GT)")
    ws5.append(["Metrik", "JS (mean)", "Python (mean)", "Selisih (JS-Py)", "Pemenang"])
    for cell in ws5[1]:
        cell.font = HDR
        cell.fill = BLUE
    lower_better = {"text_edit", "text_cer", "formula_edit", "reading_order_edit"}
    for k, lbl in metric_keys:
        js_mean = _gt_agg(scores.get("js", []), k)["mean"]
        py_mean = _gt_agg(scores.get("py", []), k)["mean"]
        diff = round(js_mean - py_mean, 4)
        if k in lower_better:
            winner = "JS" if js_mean < py_mean else ("Python" if py_mean < js_mean else "seri")
        else:
            winner = "JS" if js_mean > py_mean else ("Python" if py_mean > js_mean else "seri")
        ws5.append([lbl, js_mean, py_mean, diff, winner])
    for c in range(1, 6):
        ws5.column_dimensions[get_column_letter(c)].width = 20

    output_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(output_path)
    print(f"[evaluate] GT accuracy Excel saved → {output_path}")


def _write_strata_sheet(ws, scores, attr_key, metric_keys, HDR, FILL):
    from openpyxl.styles import Alignment
    ws.append(["Sistem", attr_key, "N Dok"] + [lbl for _, lbl in metric_keys])
    for cell in ws[1]:
        cell.font = HDR
        cell.fill = FILL
        cell.alignment = Alignment(horizontal="center", wrap_text=True)
    for label in ("js", "py"):
        rows = scores.get(label, [])
        groups: Dict[Any, List[Dict]] = {}
        for r in rows:
            groups.setdefault(r.get(attr_key) or "unknown", []).append(r)
        for gkey in sorted(groups, key=lambda x: str(x)):
            grp = groups[gkey]
            ws.append([label.upper(), gkey, len(grp)] +
                      [_gt_agg(grp, k)["mean"] for k, _ in metric_keys])


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run_evaluation(js_dir: Path, py_dir: Path, output: Path,
                   diffs_dir: Optional[Path] = None,
                   gt_dir: Optional[Path] = None) -> List[Dict]:
    explode_js_combined(js_dir)
    stems = find_pairs(js_dir, py_dir)
    if not stems:
        print("[ERROR] No matching document stems found.", file=sys.stderr)
        return []
    print(f"[evaluate] Found {len(stems)} document(s): {', '.join(stems)}")
    if diffs_dir is None:
        diffs_dir = output.parent / "diffs"

    rows: List[Dict] = []
    for stem in stems:
        print(f"  Processing: {stem}")
        res = evaluate_document(stem, js_dir, py_dir, diffs_dir=diffs_dir)
        if res is not None:
            rows.append(res)
    if not rows:
        print("[ERROR] No documents could be evaluated.", file=sys.stderr)
        return []

    write_excel(rows, output)

    clean = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]
    ratios = [r["time_ratio"] for r in clean if r.get("time_ratio")]
    print()
    print("=" * 64)
    print(f"  Evaluated {len(rows)} document(s)")
    print(f"  Time ratio (JS/Py inference)  geomean : {geometric_mean(ratios):.3f}")
    print(f"  Avg type seq. diff                     : {agg_stats([r['type_sequence_diff'] for r in clean])['mean']:.4f}")
    print(f"  Avg coverage F1                        : {agg_stats([r['coverage_f1'] for r in clean])['mean']:.4f}")
    print(f"  Avg NED (norm)                         : {agg_stats([r['mean_ned_norm'] for r in clean])['mean']:.4f}")
    print(f"  Avg CER                                : {agg_stats([r['mean_cer'] for r in clean])['mean']:.4f}")
    print(f"  Avg TEDS                               : {agg_stats([r['mean_teds'] for r in clean])['mean']:.4f}")
    print(f"  Diffs dumped to                        : {diffs_dir}")
    print("=" * 64)

    # Optional: absolute accuracy vs OmniDocBench ground truth
    if gt_dir is not None and gt_dir.exists():
        print(f"\n[evaluate] Scoring against OmniDocBench GT in {gt_dir} …")
        gt_output = output.parent / (output.stem + "_gt_accuracy.xlsx")
        gt_scores = run_gt_evaluation(js_dir, py_dir, gt_dir, gt_output, diffs_dir)
        for label in ("js", "py"):
            srows = gt_scores.get(label, [])
            if srows:
                ov = agg_stats([r.get("overall") for r in srows])["mean"]
                te = agg_stats([r.get("text_edit") for r in srows])["mean"]
                td = agg_stats([r.get("table_teds") for r in srows])["mean"]
                print(f"  {label.upper():6s} vs GT  ({len(srows)} docs): "
                      f"Overall={ov:.2f}  TextEdit={te:.4f}  TableTEDS={td:.4f}")
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate JS vs Python pipeline output (skripsi benchmark).")
    parser.add_argument("--js-dir", required=True, type=Path)
    parser.add_argument("--py-dir", required=True, type=Path)
    parser.add_argument("--output", default=Path("benchmark/results.xlsx"), type=Path)
    parser.add_argument("--diffs-dir", default=None, type=Path,
                        help="Where to dump per-item diff JSON (default: <output dir>/diffs)")
    parser.add_argument("--gt-dir", default=None, type=Path,
                        help="OmniDocBench GT content lists dir (enables absolute accuracy scoring)")
    args = parser.parse_args()

    if not args.js_dir.exists():
        print(f"[ERROR] JS dir not found: {args.js_dir}", file=sys.stderr)
        sys.exit(1)
    if not args.py_dir.exists():
        print(f"[ERROR] Python dir not found: {args.py_dir}", file=sys.stderr)
        sys.exit(1)

    rows = run_evaluation(args.js_dir, args.py_dir, args.output, args.diffs_dir,
                          gt_dir=args.gt_dir)
    if not rows:
        sys.exit(1)


if __name__ == "__main__":
    main()
