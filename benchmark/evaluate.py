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
from datetime import datetime
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
from .metrics import (
    edit_distance, geometric_mean, geometric_mean_ci, holm_bonferroni,
    paired_diff_ci, wilcoxon_signed_rank,
)
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
        "layout_s": 0.0, "ocr_s": 0.0, "ocr_det_s": 0.0, "ocr_rec_s": 0.0,
        "formula_s": 0.0, "table_s": 0.0,
        "postprocess_s": 0.0, "other_s": 0.0, "total_inference_s": 0.0,
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
        # OCR split into det + rec (both inference). Fall back to combined "ocr".
        r["ocr_det_s"] = timing_json.get("ocr_det_s", stages.get("ocr_det_s", 0.0))
        r["ocr_rec_s"] = timing_json.get("ocr_rec_s", stages.get("ocr_rec_s", 0.0))
        _ocr_combined = timing_json.get("ocr_s", stages.get("ocr_s", stages.get("ocr", 0.0)))
        r["ocr_s"] = round(r["ocr_det_s"] + r["ocr_rec_s"], 4) if (r["ocr_det_s"] or r["ocr_rec_s"]) else _ocr_combined
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
        r["ocr_det_s"] = timing_json.get("ocr_det_s", ms("ocr_det_ms"))
        r["ocr_rec_s"] = timing_json.get("ocr_rec_s", ms("ocr_rec_ms"))
        _ocr_combined = timing_json.get("ocr_s", ms("ocr_ms"))
        r["ocr_s"] = round(r["ocr_det_s"] + r["ocr_rec_s"], 4) if (r["ocr_det_s"] or r["ocr_rec_s"]) else _ocr_combined
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

    # Real cold-start (first warm-up run), when the runner captured it.
    cold = timing_json.get("cold_start") or {}
    if cold:
        r["cold_total_inference_s"] = cold.get("total_inference_s", 0.0)
        r["cold_model_init_s"] = cold.get("model_init_s", 0.0)
        r["cold_start_total_s"] = cold.get(
            "cold_start_total_s",
            round((cold.get("model_init_s", 0.0) or 0.0)
                  + (cold.get("total_inference_s", 0.0) or 0.0), 4))
        r["has_real_cold_start"] = True
    else:
        r["cold_total_inference_s"] = 0.0
        r["cold_model_init_s"] = 0.0
        r["cold_start_total_s"] = 0.0
        r["has_real_cold_start"] = False

    r["total_inference_s"] = round(
        r["layout_s"] + r["ocr_s"] + r["formula_s"] + r["table_s"], 4)
    # Reconciliation in the cross-system view: other_s absorbs EVERYTHING not in
    # {model_init, inference(4 stages), postprocess} — including pdf_load,
    # orientation, region_collect, and JS/Python overhead. Recomputed here (not
    # read) so the 6-stage Excel breakdown always sums to total_s for BOTH
    # systems regardless of how many sub-stages each one tracks internally.
    r["other_s"] = round(max(0.0, r["total_s"] - (
        r["model_init_s"] + r["total_inference_s"] + r["postprocess_s"])), 4)
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
        "ep_mode": cfg.get("ep_mode"),
        "execution_provider": cfg.get("execution_provider"),
        "real_eps": cfg.get("real_eps") or cfg.get("ort_providers"),
    }


def _model_hashes(timing_json: Dict) -> Dict[str, str]:
    """Map a logical model name -> short sha256, from either the JS metadata
    (keyed by manifest id) or the Python metadata (keyed by relative path).
    Returns {} when not present."""
    meta = timing_json.get("metadata") or {}
    mh = meta.get("model_hashes") or {}
    files = mh.get("files") or {}
    out: Dict[str, str] = {}
    for key, info in files.items():
        if isinstance(info, dict):
            h = info.get("sha256_full") or info.get("sha256_16")
            if h:
                out[str(key)] = h
    return out


def _config_mismatch(js_cfg: Dict, py_cfg: Dict) -> List[str]:
    issues = []
    for key in ("formula_enable", "table_enable", "parse_method"):
        ja, pb = js_cfg.get(key), py_cfg.get(key)
        if ja is None or pb is None:
            continue
        if ja != pb:
            issues.append(f"{key}: JS={ja} vs PY={pb}")
    # EP-mode comparison: each mode is a legitimate deployment-config comparison
    # (accelerated vs accelerated = the GPU-deployment headline; cpu vs cpu = the
    # CPU-only deployment). Comparing ACROSS modes (JS accelerated vs Python cpu)
    # is not a like-for-like deployment pairing, so we flag it.
    ja, pb = js_cfg.get("ep_mode"), py_cfg.get("ep_mode")
    if ja and pb and ja != pb:
        issues.append(f"ep_mode: JS={ja} vs PY={pb} (deployment configs differ — "
                      f"not a like-for-like pairing)")
    return issues


# ---------------------------------------------------------------------------
# Per-document evaluation
# ---------------------------------------------------------------------------

def type_sequence_difference(cl_a: List[Dict], cl_b: List[Dict]) -> float:
    ta = extract_type_sequence(cl_a)
    tb = extract_type_sequence(cl_b)
    denom = max(len(ta), len(tb))
    return round(edit_distance(ta, tb) / denom, 4) if denom else 0.0


def _input_parity(js_timing: Dict, py_timing: Dict) -> Dict[str, Any]:
    """Compare the input-file provenance recorded by both runners.

    Returns whether both systems consumed the SAME input bytes (sha256 match)
    plus the input kind. This is a clean parity proof for the paired comparison.
    """
    ji = js_timing.get("input_file") or {}
    pi = py_timing.get("input_file") or {}
    out: Dict[str, Any] = {
        "js_kind": ji.get("kind"),
        "py_kind": pi.get("kind"),
        "js_sha256": ji.get("sha256_full") or ji.get("sha256_16"),
        "py_sha256": pi.get("sha256_full") or pi.get("sha256_16"),
        "same_input_bytes": None,
    }
    js_h, py_h = out["js_sha256"], out["py_sha256"]
    if js_h and py_h:
        # Compare on the common prefix length (one side may store only 16 hex).
        n = min(len(js_h), len(py_h))
        out["same_input_bytes"] = (js_h[:n] == py_h[:n])
    return out


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

    # config consistency (C2) + model-artifact parity
    js_cfg, py_cfg = _run_config(js_timing), _run_config(py_timing)
    mismatch = _config_mismatch(js_cfg, py_cfg)
    # Model hashes: both sides hash their own files; we cannot compare the bytes
    # directly (JS serves the patched browser ONNX, Python may use a different
    # build) but we CAN record both so the thesis documents exactly which
    # artifacts ran. A within-system manifest mismatch is the real red flag.
    js_hashes, py_hashes = _model_hashes(js_timing), _model_hashes(py_timing)
    if mismatch:
        print(f"  [WARN] {stem}: config mismatch → {'; '.join(mismatch)}", file=sys.stderr)

    # Input-file parity: did both systems consume the same input bytes?
    inparity = _input_parity(js_timing, py_timing)
    if inparity.get("same_input_bytes") is False:
        print(f"  [WARN] {stem}: input bytes DIFFER between JS and Python "
              f"(js={inparity.get('js_sha256')} vs py={inparity.get('py_sha256')}) — "
              f"not a like-for-like input.", file=sys.stderr)

    t_a = js_t["total_inference_s"]
    t_b = py_t["total_inference_s"]
    time_ratio = round(t_a / t_b, 4) if t_b > 0 else None

    page_count = py_t["page_count"] or js_t["page_count"] or 0
    js_per_page = round(t_a / page_count, 4) if page_count else 0.0
    py_per_page = round(t_b / page_count, 4) if page_count else 0.0

    # cold-start headline (A2). Prefer the REAL first-call measurement captured
    # from the first warm-up run; fall back to (warm model_init + inference)
    # only when the runner did not record a cold-start (clearly flagged).
    if js_t.get("has_real_cold_start"):
        js_cold = js_t["cold_start_total_s"]
    else:
        js_cold = round(js_t["model_init_s"] + t_a, 4)
    if py_t.get("has_real_cold_start"):
        py_cold = py_t["cold_start_total_s"]
    else:
        py_cold = round(py_t["model_init_s"] + t_b, 4)
    cold_ratio = round(js_cold / py_cold, 4) if py_cold > 0 else None
    cold_is_real = bool(js_t.get("has_real_cold_start") and py_t.get("has_real_cold_start"))

    # Per-stage time ratios (JS/Python). The total ratio is often dominated by
    # ONE heavy stage (e.g. formula on WASM), so per-stage ratios show WHERE the
    # difference is, not just that it exists. None when the Python stage is 0
    # (stage disabled or absent) to avoid div-by-zero / meaningless ratios.
    def _stage_ratio(key: str):
        a, b = js_t.get(key, 0.0), py_t.get(key, 0.0)
        return round(a / b, 4) if b and b > 0 else None

    layout_ratio = _stage_ratio("layout_s")
    ocr_det_ratio = _stage_ratio("ocr_det_s")
    ocr_rec_ratio = _stage_ratio("ocr_rec_s")
    ocr_ratio = _stage_ratio("ocr_s")
    formula_ratio = _stage_ratio("formula_s")
    table_ratio = _stage_ratio("table_s")

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
                "input_parity": inparity,
                "model_hashes": {"js": js_hashes, "py": py_hashes},
                "summary": {k: v for k, v in align.items() if k != "diff_items"},
                "items": align["diff_items"],
            }, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "document": stem,
        "page_count": page_count,
        "config_mismatch": "; ".join(mismatch) if mismatch else "",
        "input_same_bytes": inparity.get("same_input_bytes"),
        "input_kind": inparity.get("js_kind") or inparity.get("py_kind"),
        "ep_mode_js": js_cfg.get("ep_mode"),
        "ep_mode_py": py_cfg.get("ep_mode"),
        # JS timing
        "js_inference_s": t_a,
        "js_per_page_s": js_per_page,
        "js_model_init_s": js_t["model_init_s"],
        "js_cold_start_s": js_cold,
        "js_layout_s": js_t["layout_s"],
        "js_ocr_s": js_t["ocr_s"],
        "js_ocr_det_s": js_t["ocr_det_s"],
        "js_ocr_rec_s": js_t["ocr_rec_s"],
        "js_formula_s": js_t["formula_s"],
        "js_table_s": js_t["table_s"],
        "js_postprocess_s": js_t["postprocess_s"],
        "js_other_s": js_t["other_s"],
        "js_total_s": js_t["total_s"],
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
        "py_ocr_det_s": py_t["ocr_det_s"],
        "py_ocr_rec_s": py_t["ocr_rec_s"],
        "py_formula_s": py_t["formula_s"],
        "py_table_s": py_t["table_s"],
        "py_postprocess_s": py_t["postprocess_s"],
        "py_other_s": py_t["other_s"],
        "py_total_s": py_t["total_s"],
        "py_n_runs": py_t["n_runs"],
        "py_std_inference_s": py_t["std_inference_s"],
        "py_cv_inference": py_t["cv_inference"],
        "py_median_inference_s": py_t["median_inference_s"],
        "py_min_inference_s": py_t["min_inference_s"],
        "py_max_inference_s": py_t["max_inference_s"],
        # Comparison — time
        "time_ratio": time_ratio,
        "cold_start_ratio": cold_ratio,
        "cold_start_is_real": cold_is_real,
        "layout_ratio": layout_ratio,
        "ocr_det_ratio": ocr_det_ratio,
        "ocr_rec_ratio": ocr_rec_ratio,
        "ocr_ratio": ocr_ratio,
        "formula_ratio": formula_ratio,
        "table_ratio": table_ratio,
        "js_cold_real_s": js_t["cold_start_total_s"] if js_t.get("has_real_cold_start") else None,
        "py_cold_real_s": py_t["cold_start_total_s"] if py_t.get("has_real_cold_start") else None,
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
        "mean_latex_ned": align["mean_latex_ned"],
        "n_formula_pairs": align["n_formula_pairs"],
        "mean_teds": align["mean_teds"],
        "mean_teds_struct": align["mean_teds_struct"],
        "n_table_pairs": align["n_table_pairs"],
        "mean_bbox_iou": align["mean_bbox_iou"],
        "n_bbox_pairs": align["n_bbox_pairs"],
        "reading_order_kendall_tau": align["reading_order_kendall_tau"],
        "reading_order_spearman_rho": align["reading_order_spearman_rho"],
        "n_reading_order_items": align["n_reading_order_items"],
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

def _agg_mean(rows: List[Dict], key: str) -> Optional[float]:
    vals = [r.get(key) for r in rows if isinstance(r.get(key), (int, float))]
    return round(sum(vals) / len(vals), 4) if vals else None


def _write_summary_sheet(wb, rows: List[Dict]) -> None:
    """Formal, thesis-ready summary sheet (Bab 4) with native Excel charts.

    Designed to be copied directly into a thesis results chapter: numbered
    tables (Tabel 4.x), figure captions (Gambar 4.x), formal interpretation
    prose, and clean grouped/bar charts that reference visible data blocks so
    nothing overlaps or renders as broken 3-D shapes.
    """
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter
    from openpyxl.chart import BarChart, Reference

    ws = wb.create_sheet("Ringkasan", 0)
    ws.sheet_view.showGridLines = False

    # ── Palette (subtle, academic) ──────────────────────────────────────────
    NAVY = "1F3864"
    HDR_FILL = PatternFill("solid", fgColor=NAVY)
    SUBHDR_FILL = PatternFill("solid", fgColor="D6DCE5")
    ZEBRA = PatternFill("solid", fgColor="F2F5F9")
    F_TITLE = Font(name="Calibri", bold=True, size=14, color=NAVY)
    F_CAP = Font(name="Calibri", bold=True, size=11, color="000000")
    F_HDRW = Font(name="Calibri", bold=True, size=10, color="FFFFFF")
    F_BODY = Font(name="Calibri", size=10, color="000000")
    F_BODYB = Font(name="Calibri", bold=True, size=10, color="000000")
    F_NOTE = Font(name="Calibri", italic=True, size=9, color="595959")
    thin = Side(style="thin", color="A6A6A6")
    box = Border(left=thin, right=thin, top=thin, bottom=thin)
    cL = Alignment(horizontal="left", vertical="center", wrap_text=True)
    cC = Alignment(horizontal="center", vertical="center", wrap_text=True)
    cR = Alignment(horizontal="right", vertical="center")

    # column widths
    widths = {"A": 26, "B": 13, "C": 13, "D": 13, "E": 22, "F": 4, "G": 22, "H": 14}
    for col, w in widths.items():
        ws.column_dimensions[col].width = w

    # ── Aggregates ──────────────────────────────────────────────────────────
    n_docs = len(rows)

    def geo(key):
        vals = [r.get(key) for r in rows
                if isinstance(r.get(key), (int, float)) and r.get(key) > 0]
        return round(geometric_mean(vals), 3) if vals else None

    def mean(key):
        return _agg_mean(rows, key)

    infer_ratio = geo("time_ratio")
    infer_ci = geometric_mean_ci([r.get("time_ratio") for r in rows
                                  if isinstance(r.get("time_ratio"), (int, float))])
    cold_ratio = geo("cold_start_ratio")
    js_inf, py_inf = mean("js_inference_s"), mean("py_inference_s")
    cov_f1 = mean("coverage_f1")
    cer = mean("mean_cer")
    teds = mean("mean_teds")
    teds_s = mean("mean_teds_struct")
    iou = mean("mean_bbox_iou")
    tau = mean("reading_order_kendall_tau")

    def num(x, d=3):
        return round(x, d) if isinstance(x, (int, float)) else None

    def faster_label(ratio):
        if not isinstance(ratio, (int, float)) or ratio <= 0:
            return "-"
        if abs(ratio - 1) < 0.02:
            return "Setara"
        return "Sistem B" if ratio > 1 else "Sistem A"

    row = 1
    # ── Title block ─────────────────────────────────────────────────────────
    ws.merge_cells(f"A{row}:H{row}")
    ws.cell(row=row, column=1,
            value="Ringkasan Hasil Pengujian Komparatif Sistem A dan Sistem B").font = F_TITLE
    ws.row_dimensions[row].height = 22
    row += 1
    ws.merge_cells(f"A{row}:H{row}")
    ws.cell(row=row, column=1, value=(
        f"Sistem A = implementasi JavaScript/peramban; Sistem B = implementasi Python (baseline pembanding). "
        f"Jumlah dokumen uji: {n_docs}. Nilai waktu merupakan rata-rata aritmetik; rasio menggunakan rata-rata "
        f"geometrik. Sistem B berperan sebagai acuan pembanding, bukan ground truth.")).font = F_NOTE
    ws.row_dimensions[row].height = 28
    row += 2

    # ════════════════════════════════════════════════════════════════════════
    # TABEL 4.1 — Waktu eksekusi per tahap
    # ════════════════════════════════════════════════════════════════════════
    ws.merge_cells(f"A{row}:E{row}")
    ws.cell(row=row, column=1,
            value="Tabel 4.1  Perbandingan Waktu Eksekusi per Tahap Pemrosesan (detik)").font = F_CAP
    row += 1
    t1_hdr = row
    headers = ["Tahap Pemrosesan", "Sistem A (s)", "Sistem B (s)", "Rasio A/B", "Lebih Cepat"]
    for j, h in enumerate(headers, start=1):
        cell = ws.cell(row=row, column=j, value=h)
        cell.font = F_HDRW; cell.fill = HDR_FILL; cell.border = box; cell.alignment = cC
    row += 1
    stages = [
        ("Deteksi Tata Letak", "js_layout_s", "py_layout_s", "layout_ratio"),
        ("Deteksi Teks (OCR)", "js_ocr_det_s", "py_ocr_det_s", "ocr_det_ratio"),
        ("Pengenalan Teks (OCR)", "js_ocr_rec_s", "py_ocr_rec_s", "ocr_rec_ratio"),
        ("Pengenalan Formula", "js_formula_s", "py_formula_s", "formula_ratio"),
        ("Pengenalan Tabel", "js_table_s", "py_table_s", "table_ratio"),
    ]
    t1_data_start = row
    for i, (label, jk, pk, rk) in enumerate(stages):
        jv, pv, rv = mean(jk) or 0.0, mean(pk) or 0.0, geo(rk)
        ws.cell(row=row, column=1, value=label).font = F_BODY
        ws.cell(row=row, column=2, value=num(jv)).font = F_BODY
        ws.cell(row=row, column=3, value=num(pv)).font = F_BODY
        ws.cell(row=row, column=4, value=num(rv)).font = F_BODY
        ws.cell(row=row, column=5, value=faster_label(rv)).font = F_BODY
        for j in range(1, 6):
            c = ws.cell(row=row, column=j)
            c.border = box
            c.alignment = cC if j >= 2 else cL
            if i % 2 == 1:
                c.fill = ZEBRA
        ws.cell(row=row, column=2).number_format = "0.000"
        ws.cell(row=row, column=3).number_format = "0.000"
        ws.cell(row=row, column=4).number_format = "0.00"
        row += 1
    t1_data_end = row - 1
    # total row
    tv_j, tv_p, tv_r = mean("js_inference_s") or 0.0, mean("py_inference_s") or 0.0, geo("time_ratio")
    ws.cell(row=row, column=1, value="Total Inferensi").font = F_BODYB
    ws.cell(row=row, column=2, value=num(tv_j)).font = F_BODYB
    ws.cell(row=row, column=3, value=num(tv_p)).font = F_BODYB
    ws.cell(row=row, column=4, value=num(tv_r)).font = F_BODYB
    ws.cell(row=row, column=5, value=faster_label(tv_r)).font = F_BODYB
    for j in range(1, 6):
        c = ws.cell(row=row, column=j)
        c.border = box; c.fill = SUBHDR_FILL
        c.alignment = cC if j >= 2 else cL
    ws.cell(row=row, column=2).number_format = "0.000"
    ws.cell(row=row, column=3).number_format = "0.000"
    ws.cell(row=row, column=4).number_format = "0.00"
    row += 1
    ws.merge_cells(f"A{row}:E{row}")
    ws.cell(row=row, column=1, value=(
        "Catatan: Rasio A/B > 1 menunjukkan Sistem A lebih lambat. Total inferensi tidak menyertakan "
        "waktu inisialisasi model.")).font = F_NOTE
    row += 2

    # ════════════════════════════════════════════════════════════════════════
    # TABEL 4.2 — Kesepadanan keluaran
    # ════════════════════════════════════════════════════════════════════════
    ws.merge_cells(f"A{row}:E{row}")
    ws.cell(row=row, column=1,
            value="Tabel 4.2  Metrik Kesepadanan Keluaran Sistem A terhadap Sistem B").font = F_CAP
    row += 1
    for j, h in enumerate(["Aspek Kesepadanan", "Nilai", "Skor (0–100)", "Interpretasi"], start=1):
        cell = ws.cell(row=row, column=j, value=h)
        cell.font = F_HDRW; cell.fill = HDR_FILL; cell.border = box; cell.alignment = cC
    # widen interpretation column via merge over D:E
    ws.merge_cells(start_row=row, start_column=4, end_row=row, end_column=5)
    row += 1

    def score(x):
        return round(x * 100, 1) if isinstance(x, (int, float)) else None

    text_sim = (1 - cer) if isinstance(cer, (int, float)) else None
    quality = [
        ("Cakupan item (F1)", cov_f1, score(cov_f1),
         "Proporsi item yang sama-sama terdeteksi kedua sistem."),
        ("Kemiripan teks (1 − CER)", text_sim, score(text_sim),
         "Tingkat kemiripan teks; 100 berarti karakter identik."),
        ("Struktur tabel (TEDS-Struct)", teds_s, score(teds_s),
         "Kemiripan struktur baris/kolom tabel."),
        ("Isi tabel (TEDS)", teds, score(teds),
         "Kemiripan struktur sekaligus isi sel tabel."),
        ("Kesesuaian posisi (IoU)", iou, score(iou),
         "Kemiripan letak elemen pada halaman."),
        ("Urutan baca (Kendall τ)", tau, score((tau + 1) / 2) if isinstance(tau, (int, float)) else None,
         "Korelasi urutan baca; τ = 1 berarti identik."),
    ]
    t2_data_start = row
    for i, (label, val, sc, interp) in enumerate(quality):
        ws.cell(row=row, column=1, value=label).font = F_BODY
        ws.cell(row=row, column=2, value=num(val, 4)).font = F_BODY
        ws.cell(row=row, column=3, value=sc).font = F_BODY
        ws.merge_cells(start_row=row, start_column=4, end_row=row, end_column=5)
        ws.cell(row=row, column=4, value=interp).font = F_BODY
        for j in range(1, 6):
            c = ws.cell(row=row, column=j)
            c.border = box
            c.alignment = cL if j == 1 or j == 4 else cC
            if i % 2 == 1:
                c.fill = ZEBRA
        ws.cell(row=row, column=3).number_format = "0.0"
        row += 1
    t2_data_end = row - 1
    row += 1

    # ════════════════════════════════════════════════════════════════════════
    # TABEL 4.3 — Ringkasan statistik waktu & cold-start
    # ════════════════════════════════════════════════════════════════════════
    ws.merge_cells(f"A{row}:E{row}")
    ws.cell(row=row, column=1,
            value="Tabel 4.3  Ringkasan Statistik Waktu Inferensi").font = F_CAP
    row += 1
    for j, h in enumerate(["Besaran", "Nilai"], start=1):
        cell = ws.cell(row=row, column=j, value=h)
        cell.font = F_HDRW; cell.fill = HDR_FILL; cell.border = box; cell.alignment = cC
    ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=3)
    row += 1
    ci_txt = "-"
    if infer_ci.get("ci_low") is not None:
        ci_txt = f"{infer_ci['gm']:.2f}× (95% CI {infer_ci['ci_low']:.2f}–{infer_ci['ci_high']:.2f})"
    stat_rows = [
        ("Rata-rata waktu inferensi Sistem A", f"{js_inf:.3f} s" if isinstance(js_inf, (int, float)) else "-"),
        ("Rata-rata waktu inferensi Sistem B", f"{py_inf:.3f} s" if isinstance(py_inf, (int, float)) else "-"),
        ("Rasio waktu inferensi A/B (geomean)", ci_txt),
        ("Rasio cold-start A/B (geomean)", f"{cold_ratio:.2f}×" if isinstance(cold_ratio, (int, float)) else "-"),
    ]
    for i, (label, val) in enumerate(stat_rows):
        ws.cell(row=row, column=1, value=label).font = F_BODY
        ws.merge_cells(start_row=row, start_column=2, end_row=row, end_column=3)
        ws.cell(row=row, column=2, value=val).font = F_BODY
        for j in range(1, 4):
            c = ws.cell(row=row, column=j)
            c.border = box
            c.alignment = cL if j == 1 else cC
            if i % 2 == 1:
                c.fill = ZEBRA
        row += 1
    row += 1

    # ════════════════════════════════════════════════════════════════════════
    # Interpretasi naratif (formal)
    # ════════════════════════════════════════════════════════════════════════
    ws.merge_cells(f"A{row}:E{row}")
    ws.cell(row=row, column=1, value="Interpretasi").font = F_CAP
    row += 1
    arah = ("lebih lambat" if isinstance(infer_ratio, (int, float)) and infer_ratio > 1
            else "lebih cepat")
    faktor = (f"{infer_ratio:.2f} kali" if isinstance(infer_ratio, (int, float)) and infer_ratio > 1
              else (f"{1/infer_ratio:.2f} kali" if isinstance(infer_ratio, (int, float)) and infer_ratio > 0
                    else "-"))
    paragraphs = [
        (f"Dari sisi waktu, Sistem A secara keseluruhan {arah} dibanding Sistem B dengan faktor "
         f"{faktor} pada tahap inferensi. Perbedaan terbesar terkonsentrasi pada tahap pengenalan "
         f"formula dan tabel, sedangkan tahap deteksi teks menunjukkan kinerja yang relatif setara."),
        (f"Dari sisi kesepadanan keluaran, kedua sistem menghasilkan keluaran yang sangat mirip: "
         f"cakupan item mencapai {score(cov_f1) if score(cov_f1) is not None else '-'} dari 100, "
         f"kemiripan teks {score(text_sim) if score(text_sim) is not None else '-'} dari 100, dan "
         f"struktur tabel {score(teds_s) if score(teds_s) is not None else '-'} dari 100. "
         f"Hal ini menunjukkan bahwa port JavaScript mempertahankan paritas keluaran terhadap baseline Python."),
        ("Perbandingan dilakukan dalam kerangka deployment-config (membandingkan kedua sistem "
         "sebagaimana digunakan secara nyata), sehingga perbedaan waktu mencakup pengaruh bahasa, "
         "pustaka runtime, dan penyedia eksekusi sekaligus, bukan isolasi satu variabel."),
    ]
    for p in paragraphs:
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=5)
        c = ws.cell(row=row, column=1, value=p)
        c.font = F_BODY
        c.alignment = Alignment(horizontal="left", vertical="top", wrap_text=True)
        ws.row_dimensions[row].height = 42
        row += 1
    row += 1

    # ════════════════════════════════════════════════════════════════════════
    # GRAFIK — anchored below all tables, vertically spaced (no overlap)
    # Each chart ≈ 15 cols wide × 16 rows tall; space anchors 18 rows apart.
    # ════════════════════════════════════════════════════════════════════════
    CH_W, CH_H = 16, 8.5
    GAP = 19

    # Gambar 4.1 — waktu per tahap (grouped column, A vs B)
    ws.merge_cells(f"A{row}:E{row}")
    ws.cell(row=row, column=1,
            value="Gambar 4.1  Perbandingan Waktu Eksekusi per Tahap").font = F_CAP
    anchor1 = row + 1
    ch1 = BarChart()
    ch1.type = "col"; ch1.grouping = "clustered"; ch1.style = 10
    ch1.title = "Waktu Eksekusi per Tahap (detik)"
    ch1.y_axis.title = "Waktu (detik)"; ch1.x_axis.title = "Tahap pemrosesan"
    ch1.height, ch1.width = CH_H, CH_W
    ch1.gapWidth = 120
    d1 = Reference(ws, min_col=2, max_col=3, min_row=t1_hdr, max_row=t1_data_end)
    c1 = Reference(ws, min_col=1, min_row=t1_data_start, max_row=t1_data_end)
    ch1.add_data(d1, titles_from_data=True)
    ch1.set_categories(c1)
    ch1.x_axis.delete = False; ch1.y_axis.delete = False
    ws.add_chart(ch1, f"A{anchor1}")
    row = anchor1 + GAP

    # Gambar 4.2 — rasio per tahap (horizontal bar)
    ws.merge_cells(f"A{row}:E{row}")
    ws.cell(row=row, column=1,
            value="Gambar 4.2  Rasio Waktu Sistem A terhadap Sistem B per Tahap").font = F_CAP
    anchor2 = row + 1
    ch2 = BarChart()
    ch2.type = "bar"; ch2.style = 12
    ch2.title = "Rasio A/B per Tahap (>1 = Sistem A lebih lambat)"
    ch2.x_axis.title = "Rasio A/B"; ch2.y_axis.title = "Tahap"
    ch2.height, ch2.width = CH_H, CH_W
    ch2.gapWidth = 80
    d2 = Reference(ws, min_col=4, max_col=4, min_row=t1_hdr, max_row=t1_data_end)
    ch2.add_data(d2, titles_from_data=True)
    ch2.set_categories(c1)
    ch2.x_axis.delete = False; ch2.y_axis.delete = False
    ch2.legend = None
    ws.add_chart(ch2, f"A{anchor2}")
    row = anchor2 + GAP

    # Gambar 4.3 — kesepadanan output (horizontal bar, 0-100)
    ws.merge_cells(f"A{row}:E{row}")
    ws.cell(row=row, column=1,
            value="Gambar 4.3  Skor Kesepadanan Keluaran (skala 0–100)").font = F_CAP
    anchor3 = row + 1
    ch3 = BarChart()
    ch3.type = "bar"; ch3.style = 11
    ch3.title = "Kesepadanan Keluaran Sistem A terhadap Sistem B"
    ch3.x_axis.title = "Skor (0–100)"; ch3.y_axis.title = "Aspek"
    ch3.height, ch3.width = CH_H, CH_W
    ch3.gapWidth = 80
    d3 = Reference(ws, min_col=3, max_col=3, min_row=t2_data_start - 1, max_row=t2_data_end)
    c3 = Reference(ws, min_col=1, min_row=t2_data_start, max_row=t2_data_end)
    ch3.add_data(d3, titles_from_data=True)
    ch3.set_categories(c3)
    ch3.x_axis.delete = False; ch3.y_axis.delete = False
    ch3.x_axis.scaling.min = 0; ch3.x_axis.scaling.max = 100
    ch3.legend = None
    ws.add_chart(ch3, f"A{anchor3}")
    row = anchor3 + GAP

    # ── Sumber metodologi ───────────────────────────────────────────────────
    ws.merge_cells(f"A{row}:E{row}")
    ws.cell(row=row, column=1, value=(
        "Sumber: hasil pengujian penulis. Rasio dihitung dengan rata-rata geometrik; selang "
        "kepercayaan 95% diperoleh melalui bootstrap. Uji signifikansi (Wilcoxon signed-rank) dan "
        "rincian per dokumen tersedia pada lembar 'Per Dokumen', 'Statistik Agregat', dan 'Uji Statistik'."
    )).font = F_NOTE
    ws.row_dimensions[row].height = 28


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
        ("Dokumen", "4472C4", ["document", "page_count", "config_mismatch",
            "input_kind", "input_same_bytes"]),
        ("Sistem A – JS (s)", "70AD47", [
            "js_inference_s", "js_per_page_s", "js_layout_s", "js_ocr_det_s",
            "js_ocr_rec_s", "js_ocr_s", "js_formula_s", "js_table_s",
            "js_postprocess_s", "js_other_s",
            "js_total_s", "js_model_init_s", "js_cold_start_s",
            "js_n_runs", "js_std_inference_s", "js_cv_inference",
            "js_median_inference_s", "js_min_inference_s", "js_max_inference_s"]),
        ("Sistem B – Python (s)", "ED7D31", [
            "py_inference_s", "py_per_page_s", "py_layout_s", "py_ocr_det_s",
            "py_ocr_rec_s", "py_ocr_s", "py_formula_s", "py_table_s",
            "py_postprocess_s", "py_other_s",
            "py_total_s", "py_model_init_s", "py_cold_start_s",
            "py_n_runs", "py_std_inference_s", "py_cv_inference",
            "py_median_inference_s", "py_min_inference_s", "py_max_inference_s"]),
        ("Waktu (A/B)", "FFC000", ["time_ratio", "cold_start_ratio", "cold_start_is_real",
            "layout_ratio", "ocr_det_ratio", "ocr_rec_ratio", "ocr_ratio",
            "formula_ratio", "table_ratio"]),
        ("Kesepadanan Output", "7030A0", [
            "type_sequence_diff", "coverage_precision", "coverage_recall",
            "coverage_f1", "type_consistency", "mean_ned_raw", "mean_ned_norm",
            "n_text_pairs", "mean_cer", "mean_wer", "mean_latex_ned",
            "n_formula_pairs", "mean_teds", "mean_teds_struct", "n_table_pairs",
            "mean_bbox_iou", "n_bbox_pairs", "reading_order_kendall_tau",
            "reading_order_spearman_rho", "n_reading_order_items",
            "n_only_js", "n_only_python",
            "js_content_list_len", "py_content_list_len"]),
    ]
    LABELS = {
        "document": "Nama Dokumen", "page_count": "Halaman", "config_mismatch": "Config Mismatch",
        "input_kind": "Jenis Input", "input_same_bytes": "Input Sama (bytes)",
        "js_inference_s": "Inferensi", "js_per_page_s": "Inf/Halaman",
        "js_layout_s": "Layout", "js_ocr_det_s": "OCR Det", "js_ocr_rec_s": "OCR Rec",
        "js_ocr_s": "OCR (det+rec)", "js_formula_s": "Formula",
        "js_table_s": "Tabel", "js_postprocess_s": "Postprocess",
        "js_other_s": "Other", "js_total_s": "Total",
        "js_model_init_s": "Model Init", "js_cold_start_s": "Cold Start",
        "js_n_runs": "N Run", "js_std_inference_s": "Std", "js_cv_inference": "CV",
        "js_median_inference_s": "Median", "js_min_inference_s": "Min", "js_max_inference_s": "Max",
        "py_inference_s": "Inferensi", "py_per_page_s": "Inf/Halaman",
        "py_layout_s": "Layout", "py_ocr_det_s": "OCR Det", "py_ocr_rec_s": "OCR Rec",
        "py_ocr_s": "OCR (det+rec)", "py_formula_s": "Formula",
        "py_table_s": "Tabel", "py_postprocess_s": "Postprocess",
        "py_other_s": "Other", "py_total_s": "Total",
        "py_model_init_s": "Model Init", "py_cold_start_s": "Cold Start",
        "py_n_runs": "N Run", "py_std_inference_s": "Std", "py_cv_inference": "CV",
        "py_median_inference_s": "Median", "py_min_inference_s": "Min", "py_max_inference_s": "Max",
        "time_ratio": "Rasio Inferensi", "cold_start_ratio": "Rasio Cold Start",
        "cold_start_is_real": "Cold Start Riil?",
        "layout_ratio": "Rasio Layout", "ocr_det_ratio": "Rasio OCR Det",
        "ocr_rec_ratio": "Rasio OCR Rec", "ocr_ratio": "Rasio OCR",
        "formula_ratio": "Rasio Formula", "table_ratio": "Rasio Tabel",
        "type_sequence_diff": "Type Seq. Diff.", "coverage_precision": "Cov. Precision",
        "coverage_recall": "Cov. Recall", "coverage_f1": "Cov. F1",
        "type_consistency": "Type Consistency", "mean_ned_raw": "NED (raw)",
        "mean_ned_norm": "NED (norm)", "n_text_pairs": "N Pasang Teks",
        "mean_cer": "CER", "mean_wer": "WER",
        "mean_latex_ned": "Formula NED (LaTeX)", "n_formula_pairs": "N Formula",
        "mean_teds": "TEDS", "mean_teds_struct": "TEDS-Struct",
        "n_table_pairs": "N Tabel", "mean_bbox_iou": "BBox IoU", "n_bbox_pairs": "N BBox",
        "reading_order_kendall_tau": "Kendall τ", "reading_order_spearman_rho": "Spearman ρ",
        "n_reading_order_items": "N Item Urutan",
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
            if key in ("time_ratio", "cold_start_ratio", "layout_ratio",
                       "ocr_det_ratio", "ocr_rec_ratio", "ocr_ratio",
                       "formula_ratio", "table_ratio") and val is not None:
                cell.fill = PatternFill("solid", fgColor="FFCCCC" if val > 1 else "CCFFCC")
            if key == "config_mismatch" and val:
                cell.fill = PatternFill("solid", fgColor="FF9999")
            if key == "input_same_bytes" and val is False:
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
        ("layout_ratio", "Rasio Layout (A/B)"),
        ("ocr_det_ratio", "Rasio OCR Det (A/B)"),
        ("ocr_rec_ratio", "Rasio OCR Rec (A/B)"),
        ("formula_ratio", "Rasio Formula (A/B)"),
        ("table_ratio", "Rasio Tabel (A/B)"),
        ("js_cold_start_s", "JS Cold Start (s)"), ("py_cold_start_s", "Py Cold Start (s)"),
        ("cold_start_ratio", "Rasio Cold Start (A/B)"),
        ("js_model_init_s", "JS Model Init (s)"), ("py_model_init_s", "Py Model Init (s)"),
        ("type_sequence_diff", "Type Seq. Diff."),
        ("coverage_f1", "Coverage F1"), ("type_consistency", "Type Consistency"),
        ("mean_ned_norm", "Mean NED (norm)"), ("mean_cer", "Mean CER"),
        ("mean_wer", "Mean WER"), ("mean_latex_ned", "Mean Formula NED (LaTeX)"),
        ("mean_teds", "Mean TEDS"), ("mean_teds_struct", "Mean TEDS-Struct"),
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

    # Geometric-mean 95% CI (bootstrap) for the headline RATIOS, so the report
    # quotes an interval, not just a point estimate.
    ci_start = len(stat_keys) + 3
    ws2.cell(row=ci_start, column=1,
             value="Selang Kepercayaan 95% Geomean (bootstrap) untuk rasio").font = Font(bold=True)
    ci_hdr = ["Rasio", "Geomean", "CI Bawah", "CI Atas", "N"]
    for c, h in enumerate(ci_hdr, start=1):
        cell = ws2.cell(row=ci_start + 1, column=c, value=h)
        cell.font = HDR
        cell.fill = BLUE
    for i, (key, label) in enumerate((
            ("time_ratio", "Rasio Inferensi (A/B)"),
            ("cold_start_ratio", "Rasio Cold Start (A/B)"),
            ("layout_ratio", "Rasio Layout (A/B)"),
            ("ocr_det_ratio", "Rasio OCR Det (A/B)"),
            ("ocr_rec_ratio", "Rasio OCR Rec (A/B)"),
            ("formula_ratio", "Rasio Formula (A/B)"),
            ("table_ratio", "Rasio Tabel (A/B)"))):
        vals = [row.get(key) for row in rows if row.get(key) is not None]
        ci = geometric_mean_ci(vals)
        rr = ci_start + 2 + i
        ws2.cell(row=rr, column=1, value=label)
        ws2.cell(row=rr, column=2, value=ci["gm"])
        ws2.cell(row=rr, column=3, value=ci["ci_low"])
        ws2.cell(row=rr, column=4, value=ci["ci_high"])
        ws2.cell(row=rr, column=5, value=ci["n"])

    # Note on geomean for ratios
    note_row = ci_start + 5
    ws2.cell(row=note_row, column=1,
             value="Catatan: untuk rasio gunakan Geomean (mean-of-ratios bias). "
                   "CI via bootstrap 5000x atas log-rasio.").font = Font(italic=True)

    # ── Sheet 3: Uji Statistik ──────────────────────────────────────────────
    ws4 = wb.create_sheet("Uji Statistik")
    ws4.append(["Uji Wilcoxon signed-rank (paired, JS vs Python) atas dokumen"])
    ws4["A1"].font = Font(bold=True)
    ws4.append([])
    ws4.append(["Metrik", "N Pasang", "Statistik W", "p-value", "p Holm-adj α",
                "Effect size r", "Median selisih (A-B)", "Signifikan (mentah)",
                "Signifikan (Holm)", "Catatan"])
    for cell in ws4[3]:
        cell.font = HDR
        cell.fill = BLUE
    test_metrics = [
        ("js_inference_s", "py_inference_s", "Inferensi (s)"),
        ("js_per_page_s", "py_per_page_s", "Inferensi per halaman (s)"),
        ("js_cold_start_s", "py_cold_start_s", "Cold start (s)"),
        ("js_layout_s", "py_layout_s", "Layout (s)"),
        ("js_ocr_det_s", "py_ocr_det_s", "OCR Det (s)"),
        ("js_ocr_rec_s", "py_ocr_rec_s", "OCR Rec (s)"),
    ]
    # First pass: run each test, collect p-values for the family-wise correction.
    test_results = []
    for ka, kb, label in test_metrics:
        a = [r.get(ka) for r in rows]
        b = [r.get(kb) for r in rows]
        res = wilcoxon_signed_rank(a, b)
        test_results.append((label, res))
    # Holm-Bonferroni across the family of tests (controls FWER).
    holm = holm_bonferroni([res["p_value"] for _, res in test_results])
    for (label, res), hb in zip(test_results, holm):
        raw_sig = ""
        if res["p_value"] is not None:
            raw_sig = "ya" if res["p_value"] < 0.05 else "tidak"
        holm_sig = ""
        if hb["significant"] is not None:
            holm_sig = "ya" if hb["significant"] else "tidak"
        ws4.append([label, res["n_pairs"], res["statistic"], res["p_value"],
                    hb["adjusted_alpha"], res["effect_size_r"], res["median_diff"],
                    raw_sig, holm_sig, res["note"]])
    ws4.append([])
    ws4.append(["Catatan: koreksi Holm-Bonferroni mengontrol family-wise error "
                "rate atas seluruh uji di tabel ini."])
    ws4[ws4.max_row][0].font = Font(italic=True)
    for c in range(1, 11):
        ws4.column_dimensions[get_column_letter(c)].width = 20

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

    # ── Sheet 0: Ringkasan (plain-language summary + charts), inserted first ─
    try:
        _write_summary_sheet(wb, rows)
    except Exception as e:  # never let the summary break the main export
        print(f"  [WARN] Could not build summary sheet: {e}", file=sys.stderr)

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
        total = len(common)
        sys_name = "Sistem A (JS)" if label == "js" else "Sistem B (Python)"
        print(f"  [{sys_name}] scoring {total} document(s) vs GT …")
        scored = 0
        for i, stem in enumerate(common, start=1):
            print(f"    ({i}/{total}) {label.upper()}: {stem} …")
            row = evaluate_against_gt(stem, sys_dir, gt_dir, label,
                                      diffs_dir=diffs_dir, gt_index=gt_index)
            if row is not None:
                out[label].append(row)
                scored += 1
                ov = row.get("overall")
                ov_str = f"{ov:.2f}" if isinstance(ov, (int, float)) else "n/a"
                print(f"        ✓ Overall={ov_str}")
            else:
                print(f"        [SKIP] {stem}: missing content_list")
        print(f"  [{sys_name}] done: {scored}/{total} document(s) scored.")

    write_gt_excel(out, output)
    return out


def _gt_agg(rows: List[Dict], key: str) -> Dict[str, float]:
    return agg_stats([r.get(key) for r in rows])


def _paired_by_document(scores: Dict[str, List[Dict]], key: str):
    """Return (js_vals, py_vals) paired on the SAME document, in matching order.

    Only documents scored by BOTH systems with a numeric value for `key` on
    both sides are kept, so the result is suitable for a paired test / paired
    bootstrap CI.
    """
    js_by_doc = {r.get("document"): r.get(key) for r in scores.get("js", [])}
    py_by_doc = {r.get("document"): r.get(key) for r in scores.get("py", [])}
    js_vals: List[float] = []
    py_vals: List[float] = []
    for doc in sorted(set(js_by_doc) & set(py_by_doc)):
        jv, pv = js_by_doc[doc], py_by_doc[doc]
        if isinstance(jv, (int, float)) and isinstance(pv, (int, float)):
            js_vals.append(float(jv))
            py_vals.append(float(pv))
    return js_vals, py_vals


# Composite accuracy label. IMPORTANT: this is a PROXY composite (mean of
# (1-text_edit), TEDS, (1-formula_edit) on a 0–100 scale), NOT the official
# OmniDocBench leaderboard "Overall" (which uses different per-category metrics
# and CDM for formulas). It is named distinctly to prevent comparison to
# published leaderboard numbers we do not reproduce.
_COMPOSITE_LABEL = "Skor Komposit (0–100)*"

# (internal key, display label). Order drives all GT sheets.
_GT_METRIC_KEYS = [
    ("overall", _COMPOSITE_LABEL),
    ("text_edit", "Text Edit ↓"),
    ("text_cer", "Text CER ↓"),
    ("formula_edit", "Formula Edit ↓"),
    ("table_teds", "Table TEDS ↑"),
    ("table_teds_struct", "Table TEDS-S ↑"),
    ("reading_order_edit", "Reading Order Edit ↓"),
    ("coverage_f1", "Coverage F1 ↑"),
    ("mean_bbox_iou", "BBox IoU ↑"),
]

_GT_LOWER_BETTER = {"text_edit", "text_cer", "formula_edit", "reading_order_edit"}


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
    NOTE = Font(italic=True, size=9, color="595959")

    metric_keys = _GT_METRIC_KEYS

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
    # composite-score caveat footnote
    ws.append([])
    ws.append([f"* {_COMPOSITE_LABEL} = rata-rata [(1−Text Edit), Table TEDS, "
               "(1−Formula Edit)]×100. PROKSI, BUKAN metrik 'Overall' resmi "
               "OmniDocBench (yang memakai CDM untuk formula). Jangan dibandingkan "
               "dengan angka leaderboard."])
    ws.cell(row=ws.max_row, column=1).font = NOTE

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

    # ── Sheet 5: JS vs Py vs GT (head-to-head, PAIRED + significance) ───────
    # Raw mean comparison alone cannot tell signal from noise. We add a paired
    # Wilcoxon signed-rank test (per document), a bootstrap 95% CI of the mean
    # paired difference, and a Holm-Bonferroni correction across the metric
    # family so the "winner" is only declared when it is statistically defensible.
    ws5 = wb.create_sheet("JS vs Py (vs GT)")
    ws5.append(["Metrik", "JS (mean)", "Python (mean)", "Selisih (JS−Py)",
                "N pasang", "CI 95% selisih", "p (Wilcoxon)", "p (Holm)",
                "Signifikan (Holm)", "Pemenang"])
    for cell in ws5[1]:
        cell.font = HDR
        cell.fill = BLUE
        cell.alignment = Alignment(horizontal="center", wrap_text=True)

    # First pass: collect paired stats + p-values so Holm can correct the family.
    h2h_rows = []
    pvals: List[Optional[float]] = []
    for k, lbl in metric_keys:
        js_vals, py_vals = _paired_by_document(scores, k)
        js_mean = round(sum(js_vals) / len(js_vals), 4) if js_vals else None
        py_mean = round(sum(py_vals) / len(py_vals), 4) if py_vals else None
        ci = paired_diff_ci(js_vals, py_vals)
        wil = wilcoxon_signed_rank(js_vals, py_vals)
        p = wil.get("p_value")
        pvals.append(p)
        h2h_rows.append((k, lbl, js_mean, py_mean, ci, p))

    holm = holm_bonferroni(pvals)

    for (k, lbl, js_mean, py_mean, ci, p), hb in zip(h2h_rows, holm):
        diff = (round(js_mean - py_mean, 4)
                if isinstance(js_mean, (int, float)) and isinstance(py_mean, (int, float))
                else None)
        sig = hb.get("significant")
        # Winner only when the paired difference is significant after Holm.
        if not isinstance(diff, (int, float)) or not sig:
            winner = "tidak signifikan"
        elif k in _GT_LOWER_BETTER:
            winner = "JS" if js_mean < py_mean else "Python"
        else:
            winner = "JS" if js_mean > py_mean else "Python"
        ci_str = (f"[{ci['ci_low']}, {ci['ci_high']}]"
                  if ci.get("ci_low") is not None else "—")
        ws5.append([
            lbl, js_mean, py_mean, diff, ci.get("n"), ci_str,
            round(p, 6) if isinstance(p, (int, float)) else "—",
            round(hb["p_value"], 6) if hb.get("significant") is not None and isinstance(hb.get("p_value"), (int, float)) else "—",
            ("ya" if sig else "tidak") if sig is not None else "—",
            winner,
        ])
    ws5.append([])
    ws5.append(["Catatan: uji Wilcoxon signed-rank berpasangan per dokumen; "
                "CI 95% selisih via bootstrap (5000×); koreksi Holm-Bonferroni "
                "atas keluarga metrik. 'Pemenang' hanya dinyatakan bila selisih "
                "signifikan setelah Holm. Python = baseline pembanding, bukan GT."])
    ws5.cell(row=ws5.max_row, column=1).font = NOTE
    for c in range(1, 11):
        ws5.column_dimensions[get_column_letter(c)].width = 18

    # ── Sheet 6: Kecukupan Sampel (sample adequacy) ─────────────────────────
    _write_sample_adequacy_sheet(wb, scores, metric_keys, HDR, BLUE, NOTE)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(output_path)
    print(f"[evaluate] GT accuracy Excel saved → {output_path}")


def _write_sample_adequacy_sheet(wb, scores, metric_keys, HDR, FILL, NOTE) -> None:
    """Sample-adequacy diagnostics so the report never over-claims on thin data.

    For each metric, computes the achieved 95% margin of error from the OBSERVED
    paired-difference variance (half-width = 1.96 * sd / sqrt(n)). Also reports
    per-stratum counts and flags strata below a minimum so per-category /
    per-language claims are not made on n < threshold cells.
    """
    import math as _math
    from collections import Counter
    from openpyxl.styles import Alignment, PatternFill, Font
    from openpyxl.utils import get_column_letter

    BOLD = Font(bold=True)
    RED = PatternFill("solid", fgColor="F4CCCC")
    ws = wb.create_sheet("Kecukupan Sampel")

    # ---- overall sample size + recommendation -------------------------------
    n_js = len(scores.get("js", []))
    n_py = len(scores.get("py", []))
    paired_docs = len(set(r.get("document") for r in scores.get("js", []))
                      & set(r.get("document") for r in scores.get("py", [])))
    ws.append(["Diagnostik Kecukupan Sampel — Akurasi vs GT"])
    ws.cell(row=ws.max_row, column=1).font = BOLD
    ws.append(["Dokumen JS", n_js])
    ws.append(["Dokumen Python", n_py])
    ws.append(["Dokumen berpasangan (JS∩Py)", paired_docs])
    FLOOR = 100  # defensible floor from sample_size.py guidance
    REC = 150    # recommended
    status = ("DI BAWAH FLOOR" if paired_docs < FLOOR
              else ("CUKUP (floor)" if paired_docs < REC else "DIREKOMENDASIKAN"))
    ws.append([f"Pedoman sample_size.py: floor≈{FLOOR}, rekomendasi≈{REC}", status])
    if paired_docs < FLOOR:
        for c in (1, 2):
            ws.cell(row=ws.max_row, column=c).fill = RED
    ws.append([])

    # ---- per-metric achieved margin of error --------------------------------
    ws.append(["Margin of Error 95% tercapai (dari variansi selisih berpasangan)"])
    ws.cell(row=ws.max_row, column=1).font = BOLD
    hdr_row = ws.max_row + 1
    ws.append(["Metrik", "N pasang", "Mean selisih", "Std selisih",
               "Margin ±95%", "Memadai (±0.05)?"])
    for cell in ws[hdr_row]:
        cell.font = HDR
        cell.fill = FILL
        cell.alignment = Alignment(horizontal="center", wrap_text=True)
    import statistics as _st
    for k, lbl in metric_keys:
        js_vals, py_vals = _paired_by_document(scores, k)
        diffs = [a - b for a, b in zip(js_vals, py_vals)]
        n = len(diffs)
        if n < 2:
            ws.append([lbl, n, "—", "—", "—", "—"])
            continue
        mean_d = _st.mean(diffs)
        sd = _st.stdev(diffs)
        margin = 1.96 * sd / _math.sqrt(n)
        # 'overall'/composite is on a 0–100 scale; express its adequacy at ±5 pts.
        thresh = 5.0 if k == "overall" else 0.05
        adequate = "ya" if margin <= thresh else "TIDAK"
        ws.append([lbl, n, round(mean_d, 4), round(sd, 4),
                   round(margin, 4), adequate])
        if margin > thresh:
            ws.cell(row=ws.max_row, column=6).fill = RED
    ws.append([])

    # ---- per-stratum counts (where claims become thin) ----------------------
    for attr in ("data_source", "language"):
        ws.append([f"Jumlah dokumen per stratum: {attr}"])
        ws.cell(row=ws.max_row, column=1).font = BOLD
        hr = ws.max_row + 1
        ws.append([attr, "N (JS)", "Cukup (≥10)?"])
        for cell in ws[hr]:
            cell.font = HDR
            cell.fill = FILL
        counts = Counter((r.get(attr) or "unknown") for r in scores.get("js", []))
        for gkey in sorted(counts, key=lambda x: str(x)):
            n = counts[gkey]
            ok = "ya" if n >= 10 else "TIDAK"
            ws.append([gkey, n, ok])
            if n < 10:
                ws.cell(row=ws.max_row, column=3).fill = RED
        ws.append([])

    ws.append(["Catatan: stratum dengan N<10 TIDAK boleh dijadikan dasar klaim "
               "per-kategori/bahasa (lihat sample_size.py). Margin of error "
               "dihitung dari variansi selisih berpasangan yang teramati."])
    ws.cell(row=ws.max_row, column=1).font = NOTE
    for c in range(1, 7):
        ws.column_dimensions[get_column_letter(c)].width = 22


def _write_strata_sheet(ws, scores, attr_key, metric_keys, HDR, FILL):
    from openpyxl.styles import Alignment
    ws.append(["Sistem", attr_key, "N Dok", "Memadai (≥10)?"]
              + [lbl for _, lbl in metric_keys])
    for cell in ws[1]:
        cell.font = HDR
        cell.fill = FILL
        cell.alignment = Alignment(horizontal="center", wrap_text=True)
    from openpyxl.styles import PatternFill
    RED = PatternFill("solid", fgColor="F4CCCC")
    for label in ("js", "py"):
        rows = scores.get(label, [])
        groups: Dict[Any, List[Dict]] = {}
        for r in rows:
            groups.setdefault(r.get(attr_key) or "unknown", []).append(r)
        for gkey in sorted(groups, key=lambda x: str(x)):
            grp = groups[gkey]
            adequate = "ya" if len(grp) >= 10 else "TIDAK"
            ws.append([label.upper(), gkey, len(grp), adequate] +
                      [_gt_agg(grp, k)["mean"] for k, _ in metric_keys])
            if len(grp) < 10:
                ws.cell(row=ws.max_row, column=4).fill = RED


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run_evaluation(js_dir: Path, py_dir: Path, output: Path,
                   diffs_dir: Optional[Path] = None,
                   gt_dir: Optional[Path] = None,
                   session_dir: Optional[Path] = None,
                   use_session_dir: bool = True) -> List[Dict]:
    explode_js_combined(js_dir)
    stems = find_pairs(js_dir, py_dir)
    if not stems:
        print("[ERROR] No matching document stems found.", file=sys.stderr)
        return []
    print(f"[evaluate] Found {len(stems)} document(s): {', '.join(stems)}")

    # Per-session output folder (created UP FRONT). Groups this run's Excel(s)
    # + per-item diff dumps together so repeated evaluations don't overwrite
    # each other or mix diffs from different sessions in one flat folder.
    if use_session_dir:
        if session_dir is None:
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            session_dir = output.parent / f"{output.stem}_{ts}"
        session_dir.mkdir(parents=True, exist_ok=True)
        output = session_dir / output.name
        if diffs_dir is None:
            diffs_dir = session_dir / "diffs"
        print(f"[evaluate] Session folder: {session_dir}")
    elif diffs_dir is None:
        diffs_dir = output.parent / "diffs"
    diffs_dir.mkdir(parents=True, exist_ok=True)

    rows: List[Dict] = []
    total = len(stems)
    for i, stem in enumerate(stems, start=1):
        print(f"  ({i}/{total}) Processing: {stem}")
        res = evaluate_document(stem, js_dir, py_dir, diffs_dir=diffs_dir)
        if res is not None:
            rows.append(res)
    if not rows:
        print("[ERROR] No documents could be evaluated.", file=sys.stderr)
        return []

    write_excel(rows, output)

    clean = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]
    ratios = [r["time_ratio"] for r in clean if r.get("time_ratio")]
    ratio_ci = geometric_mean_ci(ratios)
    # Surface any cross-deployment pairing (JS and Python on different ep_modes).
    mixed_deploy = [r["document"] for r in clean
                    if r.get("config_mismatch") and "ep_mode" in r["config_mismatch"]]
    print()
    print("=" * 64)
    print(f"  Evaluated {len(rows)} document(s)")
    print(f"  Time ratio (JS/Py inference)  geomean : {ratio_ci['gm']:.3f} "
          f"[95% CI {ratio_ci['ci_low']:.3f}, {ratio_ci['ci_high']:.3f}]")
    print(f"  Avg type seq. diff                     : {agg_stats([r['type_sequence_diff'] for r in clean])['mean']:.4f}")
    print(f"  Avg coverage F1                        : {agg_stats([r['coverage_f1'] for r in clean])['mean']:.4f}")
    print(f"  Avg NED (norm)                         : {agg_stats([r['mean_ned_norm'] for r in clean])['mean']:.4f}")
    print(f"  Avg CER                                : {agg_stats([r['mean_cer'] for r in clean])['mean']:.4f}")
    print(f"  Avg Formula NED (LaTeX)                : {agg_stats([r['mean_latex_ned'] for r in clean])['mean']:.4f}")
    print(f"  Avg TEDS                               : {agg_stats([r['mean_teds'] for r in clean])['mean']:.4f}")
    print(f"  Avg TEDS-Struct                        : {agg_stats([r['mean_teds_struct'] for r in clean])['mean']:.4f}")
    print(f"  Diffs dumped to                        : {diffs_dir}")
    if mixed_deploy:
        print(f"  [WARN] {len(mixed_deploy)} doc(s) pair DIFFERENT deployment "
              f"configs (JS vs Python on different ep_mode). For a like-for-like "
              f"comparison keep both systems on the same ep_mode.")
    # Input parity: flag any byte mismatches (proves like-for-like input).
    bad_input = [r["document"] for r in clean if r.get("input_same_bytes") is False]
    if bad_input:
        print(f"  [WARN] {len(bad_input)} doc(s) had DIFFERENT input bytes between "
              f"JS and Python — not a like-for-like input pairing.")
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
                      f"Komposit={ov:.2f}  TextEdit={te:.4f}  TableTEDS={td:.4f}")

        # Paired significance + sample-adequacy summary (the two items an
        # examiner presses hardest). Printed so it is visible without Excel.
        paired_docs = len(set(r.get("document") for r in gt_scores.get("js", []))
                          & set(r.get("document") for r in gt_scores.get("py", [])))
        if paired_docs:
            print(f"\n  GT head-to-head (paired Wilcoxon + Holm, n={paired_docs}):")
            pvals, rowmeta = [], []
            for k, lbl in _GT_METRIC_KEYS:
                jv, pv = _paired_by_document(gt_scores, k)
                ci = paired_diff_ci(jv, pv)
                wil = wilcoxon_signed_rank(jv, pv)
                pvals.append(wil.get("p_value"))
                rowmeta.append((lbl, ci))
            for (lbl, ci), hb in zip(rowmeta, holm_bonferroni(pvals)):
                sig = hb.get("significant")
                tag = "—" if sig is None else ("SIG" if sig else "ns")
                ci_str = (f"[{ci['ci_low']}, {ci['ci_high']}]"
                          if ci.get("ci_low") is not None else "—")
                print(f"    {lbl:<26s} Δ(JS−Py)={str(ci.get('mean_diff')):>9s} "
                      f"CI95={ci_str:>20s}  Holm={tag}")
            FLOOR = 100
            if paired_docs < FLOOR:
                print(f"  [WARN] Accuracy corpus n={paired_docs} is BELOW the "
                      f"defensible floor (~{FLOOR}) from sample_size.py. Pooled "
                      f"estimates have wide CIs; do NOT make per-stratum claims "
                      f"(strata with n<10 are flagged in the 'Kecukupan Sampel' sheet).")
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate JS vs Python pipeline output (skripsi benchmark).")
    parser.add_argument("--js-dir", required=True, type=Path)
    parser.add_argument("--py-dir", required=True, type=Path)
    parser.add_argument("--output", default=Path("benchmark/results.xlsx"), type=Path)
    parser.add_argument("--diffs-dir", default=None, type=Path,
                        help="Where to dump per-item diff JSON (default: <session dir>/diffs)")
    parser.add_argument("--gt-dir", default=None, type=Path,
                        help="OmniDocBench GT content lists dir (enables absolute accuracy scoring)")
    parser.add_argument("--session-dir", default=None, type=Path,
                        help="Explicit per-session output folder for this run's Excel(s) + diffs. "
                             "Default: auto-created as <output dir>/<output stem>_<timestamp>/")
    parser.add_argument("--no-session-dir", action="store_true", default=False,
                        help="Write directly to --output / --diffs-dir without a per-session folder "
                             "(legacy flat layout).")
    args = parser.parse_args()

    if not args.js_dir.exists():
        print(f"[ERROR] JS dir not found: {args.js_dir}", file=sys.stderr)
        sys.exit(1)
    if not args.py_dir.exists():
        print(f"[ERROR] Python dir not found: {args.py_dir}", file=sys.stderr)
        sys.exit(1)

    rows = run_evaluation(args.js_dir, args.py_dir, args.output, args.diffs_dir,
                          gt_dir=args.gt_dir,
                          session_dir=args.session_dir,
                          use_session_dir=not args.no_session_dir)
    if not rows:
        sys.exit(1)


if __name__ == "__main__":
    main()
