"""
demo/demo_batch.py
==================
Batch runner Python untuk benchmark skripsi.

Memproses semua PDF di folder demo/pdfs secara antre, menghasilkan:
  - <output_dir>/<stem>/auto/<stem>_timing.json       (unified timing)
  - <output_dir>/<stem>/auto/<stem>_content_list.json (untuk evaluasi)
  - <output_dir>/<stem>/auto/<stem>.md
  - <output_dir>/<stem>/auto/<stem>_middle.json
  - <output_dir>/<stem>/auto/<stem>_model.json

Setelah selesai, semua _timing.json dan _content_list.json disalin ke
  benchmark/py_results/<stem>_timing.json
  benchmark/py_results/<stem>_content_list.json
agar langsung bisa dibaca oleh benchmark/evaluate.py.

Cara pakai:
  rtk python -m demo.demo_batch
  rtk python -m demo.demo_batch --pdfs demo/pdfs --repeat 3
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import sys
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from dotenv import load_dotenv

load_dotenv()

from loguru import logger  # noqa: E402

from rapid_doc.data.data_reader_writer import FileBasedDataWriter  # noqa: E402
from rapid_doc.utils.enum_class import MakeMode  # noqa: E402
from rapid_doc.utils.config_reader import get_processing_window_size  # noqa: E402
from rapid_doc.cli.common import (  # noqa: E402
    convert_pdf_bytes_to_bytes_by_pypdfium2,
    prepare_env,
    read_fn,
)
from rapid_doc.backend.pipeline.pipeline_analyze import (  # noqa: E402
    doc_analyze as pipeline_doc_analyze,
    ModelSingleton,
)
from rapid_doc.backend.pipeline.pipeline_middle_json_mkcontent import (  # noqa: E402
    union_make as pipeline_union_make,
)
from rapid_doc.backend.pipeline.model_json_to_middle_json import (  # noqa: E402
    result_to_middle_json as pipeline_result_to_middle_json,
)

# Reuse parity config from demo_run
from demo.demo_run import build_parity_config  # noqa: E402


# ---------------------------------------------------------------------------
# Timing recorder (same as demo_run.py)
# ---------------------------------------------------------------------------

class TimingRecorder:
    def __init__(self, filename: str) -> None:
        self.filename = filename
        self.stages: Dict[str, float] = {}
        self.batches: List[Dict[str, Any]] = []
        self._t_start = time.perf_counter()
        self._page_count: Optional[int] = None

    @contextmanager
    def stage(self, name: str) -> Iterator[None]:
        t0 = time.perf_counter()
        try:
            yield
        finally:
            elapsed = time.perf_counter() - t0
            self.stages[name] = self.stages.get(name, 0.0) + elapsed

    @contextmanager
    def batch(self, batch_idx: int, pages: int) -> Iterator[Dict[str, float]]:
        record: Dict[str, float] = {"batch_idx": batch_idx, "pages": pages}
        t0 = time.perf_counter()
        try:
            yield record
        finally:
            record["wall_clock"] = time.perf_counter() - t0
            self.batches.append(record)

    def set_page_count(self, n: int) -> None:
        self._page_count = n

    def finalize(self) -> Dict[str, Any]:
        total = time.perf_counter() - self._t_start
        return {
            "filename": self.filename,
            "page_count": self._page_count,
            "total_seconds": round(total, 4),
            "stages": {k: round(v, 4) for k, v in self.stages.items()},
            "batches": [
                {**b, **{k: round(v, 4) for k, v in b.items() if isinstance(v, float)}}
                for b in self.batches
            ],
        }


# ---------------------------------------------------------------------------
# Unified timing format (matches JS export)
# ---------------------------------------------------------------------------

def build_unified_timing(raw: Dict[str, Any], stats: Optional[Dict] = None) -> Dict[str, Any]:
    """
    Convert raw TimingRecorder output to the unified timing schema.
    model_init is stored but EXCLUDED from total_inference_s.
    stats: optional dict with n, std, median, min, max over repeated runs.
    """
    stages = raw.get("stages", {})
    batches = raw.get("batches", [])

    layout_s = stages.get("layout_s", 0.0)
    ocr_det_s = stages.get("ocr_det_s", stages.get("ocr_s", 0.0))
    ocr_rec_s = stages.get("ocr_rec_s", 0.0)
    ocr_s = ocr_det_s + ocr_rec_s
    formula_s = stages.get("formula_s", 0.0)
    table_s = stages.get("table_s", 0.0)
    model_init_s = stages.get("model_init", 0.0)
    # postprocess = lightweight middle-json / markdown / content-list build only.
    # (OCR-rec inference is now counted under ocr_rec, not here.)
    postprocess_s = (
        sum(b.get("middle_json", 0.0) for b in batches)
        + stages.get("make_markdown", 0.0)
        + stages.get("make_content_list", 0.0)
    )
    inference_s = layout_s + ocr_s + formula_s + table_s
    total_s = raw.get("total_seconds", 0.0)

    # Reconciliation: everything explicitly attributed vs the wall-clock total.
    # Anything left over (read_pdf_bytes, build_config, prepare_env, PDF
    # rasterization inside doc_analyze, dump_*_json, GC, etc.) is reported as
    # other_s so the per-stage breakdown ALWAYS sums to total_s.
    attributed_s = model_init_s + inference_s + postprocess_s
    other_s = max(0.0, round(total_s - attributed_s, 4))

    result = {
        "filename": raw["filename"],
        "page_count": raw.get("page_count"),
        # Seconds (primary)
        "total_s": total_s,
        "model_init_s": model_init_s,  # stored but excluded from inference
        "layout_s": round(layout_s, 4),
        "ocr_det_s": round(ocr_det_s, 4),
        "ocr_rec_s": round(ocr_rec_s, 4),
        "ocr_s": round(ocr_s, 4),
        "formula_s": round(formula_s, 4),
        "table_s": round(table_s, 4),
        "postprocess_s": round(postprocess_s, 4),
        "other_s": other_s,
        "total_inference_s": round(inference_s, 4),
        # Milliseconds (secondary)
        "total_ms": round(total_s * 1000, 1),
        "model_init_ms": round(model_init_s * 1000, 1),
        "layout_ms": round(layout_s * 1000, 1),
        "ocr_det_ms": round(ocr_det_s * 1000, 1),
        "ocr_rec_ms": round(ocr_rec_s * 1000, 1),
        "ocr_ms": round(ocr_s * 1000, 1),
        "formula_ms": round(formula_s * 1000, 1),
        "table_ms": round(table_s * 1000, 1),
        "postprocessing_ms": round(postprocess_s * 1000, 1),
        "other_ms": round(other_s * 1000, 1),
    }
    if stats:
        result["stats"] = stats
    return result


# ---------------------------------------------------------------------------
# Single-file pipeline runner
# ---------------------------------------------------------------------------

def run_one_file(
    pdf_path: Path,
    output_dir: Path,
    parse_method: str = "auto",
    p_formula_enable: bool = True,
    p_table_enable: bool = True,
    ep_mode: str = "accelerated",
    audit_outputs: bool = True,
) -> Optional[Dict[str, Any]]:
    """Process one PDF. Returns unified timing dict or None on error."""
    file_name = pdf_path.stem
    timing = TimingRecorder(filename=pdf_path.name)

    try:
        with timing.stage("read_pdf_bytes"):
            pdf_bytes = read_fn(pdf_path)

        with timing.stage("build_config"):
            layout_config, ocr_config, formula_config, table_config, checkbox_config, image_config = (
                build_parity_config(ep_mode=ep_mode)
            )

        with timing.stage("prepare_env"):
            local_image_dir, local_md_dir = prepare_env(str(output_dir), file_name, parse_method)
            image_writer = FileBasedDataWriter(local_image_dir)
            md_writer = FileBasedDataWriter(local_md_dir)

        pdf_pages_batch = get_processing_window_size(default=64)

        # Pre-warm models (isolate model_init from inference)
        with timing.stage("model_init"):
            ModelSingleton().get_model(
                lang=None,
                formula_enable=p_formula_enable,
                table_enable=p_table_enable,
                layout_config=layout_config,
                ocr_config=ocr_config,
                formula_config=formula_config,
                table_config=table_config,
            )

        middle_json_list: Optional[Dict] = None
        model_json_acc: List[Any] = []
        finished = False
        tmp_start_page_id = 0
        batch_idx = 0

        # Accumulate per-stage inference times across batches
        acc_layout = 0.0
        acc_ocr_det = 0.0
        acc_ocr_rec = 0.0
        acc_formula = 0.0
        acc_table = 0.0

        while not finished:
            with timing.batch(batch_idx, pages=0) as batch_record:
                t_infer = time.perf_counter()
                (
                    infer_results,
                    all_image_lists,
                    all_page_dicts,
                    lang_list,
                    ocr_enabled_list,
                    file_end_list,
                ) = pipeline_doc_analyze(
                    [pdf_bytes],
                    parse_method=parse_method,
                    formula_enable=p_formula_enable,
                    table_enable=p_table_enable,
                    layout_config=layout_config,
                    ocr_config=ocr_config,
                    formula_config=formula_config,
                    table_config=table_config,
                    checkbox_config=checkbox_config,
                    start_page_id=tmp_start_page_id,
                    end_page_id=None,
                    pdf_pages_batch=pdf_pages_batch,
                )
                batch_record["doc_analyze"] = round(time.perf_counter() - t_infer, 4)

                model_list = infer_results[0]
                batch_record["pages"] = len(model_list)

                # Extract per-stage timings attached by batch_analyze.py.__call__
                # Keys: layout, ocr_det, ocr_rec, formula, table (seconds).
                # OCR is split: det (detection) + rec (recognition); both inference.
                stage_t = getattr(model_list, "_stage_timings", None)
                if stage_t:
                    acc_layout += stage_t.get("layout", 0.0)
                    # back-compat: older runs used a single "ocr" key for det
                    acc_ocr_det += stage_t.get("ocr_det", stage_t.get("ocr", 0.0))
                    acc_ocr_rec += stage_t.get("ocr_rec", stage_t.get("postprocessing", 0.0))
                    acc_formula += stage_t.get("formula", 0.0)
                    acc_table += stage_t.get("table", 0.0)

                if audit_outputs:
                    import copy
                    model_json_acc.extend(copy.deepcopy(model_list))

                t_mj = time.perf_counter()
                tmp_middle_json = pipeline_result_to_middle_json(
                    model_list,
                    all_image_lists[0],
                    all_page_dicts[0],
                    image_writer,
                    lang_list[0],
                    ocr_enabled_list[0],
                    p_formula_enable,
                    ocr_config=ocr_config,
                    image_config=image_config,
                    batch_idx=batch_idx,
                    pdf_pages_batch=pdf_pages_batch,
                )
                batch_record["middle_json"] = round(time.perf_counter() - t_mj, 4)

                if middle_json_list is None:
                    middle_json_list = tmp_middle_json
                else:
                    middle_json_list["pdf_info"].extend(tmp_middle_json["pdf_info"])

                finished = bool(file_end_list[0]) or not model_list

            tmp_start_page_id += pdf_pages_batch
            batch_idx += 1

        assert middle_json_list is not None
        pdf_info = middle_json_list["pdf_info"]
        timing.set_page_count(len(pdf_info))

        image_dir_basename = os.path.basename(local_image_dir)

        if audit_outputs:
            with timing.stage("make_markdown"):
                md_content = pipeline_union_make(pdf_info, MakeMode.MM_MD, image_dir_basename)
                md_writer.write_string(f"{file_name}.md", md_content)

        with timing.stage("make_content_list"):
            content_list = pipeline_union_make(pdf_info, MakeMode.CONTENT_LIST, image_dir_basename)
            md_writer.write_string(
                f"{file_name}_content_list.json",
                json.dumps(content_list, ensure_ascii=False, indent=2),
            )

        if audit_outputs:
            with timing.stage("dump_middle_json"):
                md_writer.write_string(
                    f"{file_name}_middle.json",
                    json.dumps(middle_json_list, ensure_ascii=False, indent=2),
                )

            with timing.stage("dump_model_json"):
                md_writer.write_string(
                    f"{file_name}_model.json",
                    json.dumps(model_json_acc, ensure_ascii=False, indent=2),
                )

        # Store per-stage inference times in timing stages dict
        timing.stages["layout_s"] = round(acc_layout, 4)
        timing.stages["ocr_det_s"] = round(acc_ocr_det, 4)
        timing.stages["ocr_rec_s"] = round(acc_ocr_rec, 4)
        timing.stages["ocr_s"] = round(acc_ocr_det + acc_ocr_rec, 4)
        timing.stages["formula_s"] = round(acc_formula, 4)
        timing.stages["table_s"] = round(acc_table, 4)
        timing.stages["reading_order_s"] = 0.0  # not separately measured

        raw_timing = timing.finalize()
        unified = build_unified_timing(raw_timing)

        # Write timing JSON
        md_writer.write_string(
            f"{file_name}_timing.json",
            json.dumps(unified, ensure_ascii=False, indent=2),
        )

        logger.info(f"Output dir: {local_md_dir}")
        return unified

    except Exception as e:
        logger.exception(f"Failed to process {pdf_path.name}: {e}")
        return None


# ---------------------------------------------------------------------------
# Batch runner
# ---------------------------------------------------------------------------

def collect_runtime_metadata() -> Dict[str, Any]:
    try:
        import onnxruntime as ort
        ort_version = ort.__version__
        ort_providers = ort.get_available_providers()
    except Exception:
        ort_version = None
        ort_providers = []
    try:
        from importlib.metadata import version as _v
        rapid_doc_version = _v("rapid-doc")
    except Exception:
        rapid_doc_version = None
    return {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor() or None,
        "cpu_count": os.cpu_count(),
        "device_mode": os.getenv("MINERU_DEVICE_MODE"),
        "rapid_models_dir": os.getenv("RAPID_MODELS_DIR"),
        "ort_version": ort_version,
        "ort_providers": ort_providers,
        "rapid_doc_version": rapid_doc_version,
    }


def resolve_real_eps(formula_enable: bool, table_enable: bool,
                     ep_mode: str = "accelerated") -> Dict[str, str]:
    """Best-effort resolution of the execution provider actually used per model.

    ORT silently falls back to CPU when a requested EP (e.g. DirectML) is not
    available. We cross-check the requested config against the providers ORT
    reports as available so the report does not claim DML when it ran on CPU.

    When ep_mode == "cpu" every model is pinned to CPU (the CPU-only
    deployment configuration), so we report CPU across the board.
    """
    try:
        import onnxruntime as ort
        available = set(ort.get_available_providers())
    except Exception:
        available = set()

    device_mode = (os.getenv("MINERU_DEVICE_MODE") or "").lower()

    def gpu_ep() -> str:
        if ep_mode == "cpu":
            return "CPUExecutionProvider"
        if device_mode == "cuda" and "CUDAExecutionProvider" in available:
            return "CUDAExecutionProvider"
        if "DmlExecutionProvider" in available:
            return "DmlExecutionProvider"
        return "CPUExecutionProvider(fallback)"

    return {
        # layout + OCR request GPU (DML/CUDA) in build_parity_config
        "layout": gpu_ep(),
        "ocr": gpu_ep(),
        # formula + table are pinned to CPU for WASM parity
        "formula": "CPUExecutionProvider" if formula_enable else "disabled",
        "table": "CPUExecutionProvider" if table_enable else "disabled",
        "available_providers": sorted(available),
        "ep_mode": ep_mode,
    }


def hash_model_files() -> Dict[str, Any]:
    """SHA-256 (first 16 hex chars) of the ONNX model files actually on disk.

    Recorded in provenance so the report can PROVE both systems used the same
    model artifacts (same opset / quantization). Without this, a divergence in
    accuracy could silently be a model-mismatch confound rather than a port bug.
    """
    models_dir = os.getenv("RAPID_MODELS_DIR")
    out: Dict[str, Any] = {"models_dir": models_dir, "files": {}}
    if not models_dir:
        out["note"] = "RAPID_MODELS_DIR not set; cannot hash model files."
        return out
    root = Path(models_dir)
    if not root.exists():
        out["note"] = f"models dir does not exist: {models_dir}"
        return out
    try:
        for p in sorted(root.rglob("*.onnx")):
            try:
                h = hashlib.sha256()
                with p.open("rb") as fh:
                    for chunk in iter(lambda: fh.read(1 << 20), b""):
                        h.update(chunk)
                rel = str(p.relative_to(root))
                out["files"][rel] = {
                    "sha256_16": h.hexdigest()[:16],
                    "size_bytes": p.stat().st_size,
                }
            except Exception as e:  # pragma: no cover
                out["files"][str(p)] = {"error": str(e)}
    except Exception as e:  # pragma: no cover
        out["note"] = f"hashing failed: {e}"
    return out


def hash_input_file(path: Path) -> Dict[str, Any]:
    """SHA-256 of an input document, plus its kind.

    Recorded per document so the report can PROVE both systems consumed the
    same input bytes (a clean parity proof for the paired comparison).
    """
    out: Dict[str, Any] = {"name": path.name, "kind": "other"}
    ext = path.suffix.lower()
    if ext in (".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff", ".tif", ".gif", ".jp2"):
        out["kind"] = "image"
    elif ext == ".pdf":
        out["kind"] = "pdf"
    try:
        h = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        digest = h.hexdigest()
        out["sha256_16"] = digest[:16]
        out["sha256_full"] = digest
        out["size_bytes"] = path.stat().st_size
    except Exception as e:  # pragma: no cover
        out["error"] = str(e)
    return out


def content_stability(runs_content: List[Any]) -> Dict[str, Any]:
    """Check whether repeated runs produced identical content.

    Returns the count of distinct outputs and the max pairwise type-sequence
    difference, so non-determinism across runs is reported rather than assumed
    away (the 'last run == all runs' assumption is verified, not trusted)."""
    if not runs_content:
        return {"n_runs_with_content": 0, "identical": True, "distinct_outputs": 0}

    def type_seq(cl):
        return tuple(it.get("type", "?") for it in (cl or []) if it.get("type") != "discarded")

    seqs = [type_seq(cl) for cl in runs_content]
    distinct = len(set(seqs))
    serialized = {json.dumps(cl, ensure_ascii=False, sort_keys=True) for cl in runs_content}
    return {
        "n_runs_with_content": len(runs_content),
        "identical": len(serialized) == 1,
        "distinct_type_sequences": distinct,
        "distinct_outputs": len(serialized),
    }


def run_batch(
    pdf_paths: List[Path],
    output_dir: Path,
    benchmark_dir: Path,
    parse_method: str = "auto",
    formula_enable: bool = True,
    table_enable: bool = False,
    repeat: int = 1,
    warmup: int = 1,
    ep_mode: str = "accelerated",
    audit_provenance: bool = True,
    check_content_stability: bool = True,
    audit_outputs: bool = True,
) -> None:
    """Process all PDFs, repeat N times, copy mean results to benchmark_dir.

    warmup is the NUMBER of warm-up runs (excluded from steady-state stats but
    the FIRST warm-up run's timing is preserved separately as the cold-start
    measurement — for the browser this includes JIT/shader compilation and, on
    a cold cache, model download).
    """
    benchmark_dir.mkdir(parents=True, exist_ok=True)
    metadata = collect_runtime_metadata()
    metadata["benchmark_mode"] = "strict" if audit_provenance and audit_outputs else "final"
    metadata["model_hashes"] = (
        hash_model_files() if audit_provenance
        else {"skipped": True, "reason": "benchmark_mode=final"}
    )
    real_eps = resolve_real_eps(formula_enable, table_enable, ep_mode)
    run_config = {
        "parse_method": parse_method,
        "formula_enable": formula_enable,
        "table_enable": table_enable,
        "repeat": repeat,
        "warmup_runs": warmup,
        "warmup_excluded": warmup > 0,
        "ep_mode": ep_mode,
        "execution_provider": metadata.get("device_mode") or ("cpu" if ep_mode == "cpu" else "directml/cpu"),
        "real_eps": real_eps,
    }
    logger.info(f"EP mode: {ep_mode} | Real EPs (per model): {real_eps}")

    # Per-file: list of unified timing dicts (one per run, warmup excluded)
    file_runs: Dict[str, List[Dict]] = {p.stem: [] for p in pdf_paths}
    file_cold: Dict[str, Optional[Dict]] = {p.stem: None for p in pdf_paths}
    file_content_lists: Dict[str, Any] = {}
    file_run_contents: Dict[str, List[Any]] = {p.stem: [] for p in pdf_paths}
    overall_start = time.perf_counter()

    total_runs = len(pdf_paths) * (repeat + warmup)
    done_runs = 0

    for pdf_path in pdf_paths:
        stem = pdf_path.stem
        runs_for_file = repeat + warmup

        for run_idx in range(runs_for_file):
            is_warmup = run_idx < warmup
            if is_warmup:
                run_label = f"warm-up {run_idx + 1}/{warmup}"
            else:
                run_label = f"run {run_idx - warmup + 1}/{repeat}"
            logger.info(f"  {pdf_path.name} — {run_label}")

            record = run_one_file(
                pdf_path, output_dir,
                parse_method=parse_method,
                p_formula_enable=formula_enable,
                p_table_enable=table_enable,
                ep_mode=ep_mode,
                audit_outputs=audit_outputs,
            )
            done_runs += 1

            if record is not None and not is_warmup:
                file_runs[stem].append(record)
                # Capture this run's content_list to verify cross-run stability
                src_dir = output_dir / stem / "auto"
                cl_path = src_dir / f"{stem}_content_list.json"
                if cl_path.exists():
                    try:
                        cl_data = json.loads(cl_path.read_text(encoding="utf-8"))
                        file_content_lists[stem] = cl_data  # last run wins for export
                        if check_content_stability:
                            file_run_contents[stem].append(cl_data)
                    except Exception:
                        pass
            elif is_warmup:
                # Preserve the FIRST warm-up run as the cold-start measurement.
                if run_idx == 0 and record is not None:
                    file_cold[stem] = record
                logger.info(f"    {run_label} done (excluded from steady-state stats)")

    overall_wall = time.perf_counter() - overall_start

    # Build mean timing per file and copy to benchmark_dir
    for pdf_path in pdf_paths:
        stem = pdf_path.stem
        runs = file_runs[stem]
        if not runs:
            logger.warning(f"No valid runs for {stem}")
            continue

        # Compute mean over runs
        def mean_field(key):
            vals = [r.get(key, 0.0) for r in runs if r.get(key) is not None]
            return round(sum(vals) / len(vals), 4) if vals else 0.0

        import statistics as _stats
        inference_vals = [r.get("total_inference_s", 0.0) for r in runs]
        total_vals = [r.get("total_s", 0.0) for r in runs]

        # Cold-start measurement (first warm-up run): real first-call latency,
        # including JIT / graph optimization. Reported separately, NOT folded
        # into steady-state stats. None when no warm-up was run.
        cold = file_cold.get(stem)
        cold_block = None
        if cold is not None:
            cold_block = {
                "total_s": cold.get("total_s", 0.0),
                "model_init_s": cold.get("model_init_s", 0.0),
                "total_inference_s": cold.get("total_inference_s", 0.0),
                "cold_start_total_s": round(
                    (cold.get("model_init_s", 0.0) or 0.0)
                    + (cold.get("total_inference_s", 0.0) or 0.0), 4),
            }

        mean_timing = {
            "filename": pdf_path.name,
            "page_count": runs[0].get("page_count"),
            "total_s": mean_field("total_s"),
            "model_init_s": mean_field("model_init_s"),
            "layout_s": mean_field("layout_s"),
            "ocr_det_s": mean_field("ocr_det_s"),
            "ocr_rec_s": mean_field("ocr_rec_s"),
            "ocr_s": mean_field("ocr_s"),
            "formula_s": mean_field("formula_s"),
            "table_s": mean_field("table_s"),
            "postprocess_s": mean_field("postprocess_s"),
            "other_s": mean_field("other_s"),
            "total_inference_s": mean_field("total_inference_s"),
            "total_ms": round(mean_field("total_s") * 1000, 1),
            "model_init_ms": round(mean_field("model_init_s") * 1000, 1),
            "layout_ms": round(mean_field("layout_s") * 1000, 1),
            "ocr_det_ms": round(mean_field("ocr_det_s") * 1000, 1),
            "ocr_rec_ms": round(mean_field("ocr_rec_s") * 1000, 1),
            "ocr_ms": round(mean_field("ocr_s") * 1000, 1),
            "formula_ms": round(mean_field("formula_s") * 1000, 1),
            "table_ms": round(mean_field("table_s") * 1000, 1),
            "postprocessing_ms": round(mean_field("postprocess_s") * 1000, 1),
            "other_ms": round(mean_field("other_s") * 1000, 1),
            # Cold-start (first-call) measurement, kept distinct from warm stats
            "cold_start": cold_block,
            # Per-run breakdown
            "runs": [{"run": i + 1, **r} for i, r in enumerate(runs)],
            # Statistics (for evaluate.py)
            "stats": {
                "n": len(runs),
                "mean_total_s": round(_stats.mean(total_vals), 4),
                "median_total_s": round(_stats.median(total_vals), 4),
                "std_total_s": round(_stats.stdev(total_vals) if len(total_vals) > 1 else 0.0, 4),
                "min_total_s": round(min(total_vals), 4),
                "max_total_s": round(max(total_vals), 4),
                "mean_inference_s": round(_stats.mean(inference_vals), 4),
                "median_inference_s": round(_stats.median(inference_vals), 4),
                "std_inference_s": round(_stats.stdev(inference_vals) if len(inference_vals) > 1 else 0.0, 4),
                "min_inference_s": round(min(inference_vals), 4),
                "max_inference_s": round(max(inference_vals), 4),
            },
            # Reproducibility + parity provenance
            "run_config": run_config,
            "metadata": metadata,
            "input_file": (
                hash_input_file(pdf_path) if audit_provenance
                else {"name": pdf_path.name, "kind": "image" if pdf_path.suffix.lower() in (".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff", ".tif", ".gif", ".jp2") else "pdf" if pdf_path.suffix.lower() == ".pdf" else "other", "hash_skipped": True}
            ),
            "content_stability": (
                content_stability(file_run_contents.get(stem, []))
                if check_content_stability
                else {"skipped": True, "reason": "benchmark_mode=final"}
            ),
        }

        cs = mean_timing["content_stability"]
        if not cs.get("identical", True):
            logger.warning(
                f"  {stem}: content differs across runs "
                f"(distinct_outputs={cs.get('distinct_outputs')}, "
                f"distinct_type_seqs={cs.get('distinct_type_sequences')})")

        # Write to benchmark_dir
        timing_path = benchmark_dir / f"{stem}_timing.json"
        timing_path.write_text(json.dumps(mean_timing, ensure_ascii=False, indent=2), encoding="utf-8")

        cl = file_content_lists.get(stem, [])
        cl_path = benchmark_dir / f"{stem}_content_list.json"
        cl_path.write_text(json.dumps(cl, ensure_ascii=False, indent=2), encoding="utf-8")

        logger.info(f"  {stem}: mean_inference={mean_timing['total_inference_s']:.2f}s "
                    f"(n={len(runs)}, std={mean_timing['stats']['std_inference_s']:.3f}s)")

    summary = {
        "metadata": metadata,
        "run_config": run_config,
        "totals": {
            "files_processed": len(pdf_paths),
            "repeat": repeat,
            "warmup_runs": warmup,
            "ep_mode": ep_mode,
            "wall_clock_s": round(overall_wall, 4),
        },
    }
    summary_path = benchmark_dir / "py_batch_summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Batch summary → {summary_path}")

    print()
    print("=" * 60)
    print(f" Python batch complete — {len(pdf_paths)} file(s), {repeat} run(s) each")
    print(f" Total wall clock: {overall_wall:.1f}s")
    print("=" * 60)


def maybe_run_evaluation(js_dir: Path, py_dir: Path, output: Path) -> None:
    """Auto-run the evaluator if matching JS results already exist, so the
    Excel is ready immediately after a Python batch. Skips quietly otherwise."""
    try:
        from benchmark.evaluate import run_evaluation
    except Exception as e:
        logger.warning(f"Could not import evaluator ({e}); skipping auto-evaluate.")
        return
    if not js_dir.exists() or not any(js_dir.glob("*_timing.json")) \
            and not any(js_dir.glob("benchmark_js_*.json")):
        logger.info(f"No JS results in {js_dir} yet — skipping auto-evaluate. "
                    f"Run evaluate manually once JS results are present.")
        return
    logger.info("JS results found — running evaluation to build Excel…")
    run_evaluation(js_dir, py_dir, output)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="RapidDoc Python batch benchmark runner.")
    parser.add_argument("--pdfs", type=Path, default=Path("demo/pdfs"),
                        help="Folder of input files OR a single file path. Supports "
                             "PDF and images (png/jpg/jpeg/bmp/webp/tiff/gif/jp2).")
    parser.add_argument("--output", type=Path, default=Path("demo/output"),
                        help="Pipeline output dir (default: demo/output)")
    parser.add_argument("--benchmark-dir", type=Path, default=Path("benchmark/py_results"),
                        help="Where to copy timing + content_list JSONs (default: benchmark/py_results)")
    parser.add_argument("--parse-method", default="auto",
                        choices=["auto", "ocr", "txt"],
                        help="PDF parse method (default: auto)")
    parser.add_argument("--formula", action="store_true", default=False,
                        help="Enable formula recognition (default: off)")
    parser.add_argument("--table", action="store_true", default=False,
                        help="Enable table recognition (default: off)")
    parser.add_argument("--repeat", type=int, default=10,
                        help="Number of measured runs per file (default: 10; "
                             "the timing-corpus recommendation in sample_size.py)")
    parser.add_argument("--warmup", type=int, default=2,
                        help="Number of warm-up runs (default: 2; excluded from "
                             "steady-state stats, first one kept as cold-start)")
    parser.add_argument("--no-warmup", action="store_true", default=False,
                        help="Skip warm-up entirely (sets --warmup 0)")
    parser.add_argument("--ep-mode", default="accelerated",
                        choices=["accelerated", "cpu"],
                        help="Deployment configuration to benchmark: 'accelerated' "
                             "(layout+OCR on DirectML — the realistic GPU deployment, "
                             "Windows analogue of JS WebGPU) or 'cpu' (all models on "
                             "CPU — the CPU-only deployment, paired with JS WASM). "
                             "Each is a self-consistent deployment-config comparison; "
                             "keep both systems on the same mode. Default: accelerated")
    parser.add_argument("--js-dir", type=Path, default=Path("benchmark/js_results"),
                        help="JS results dir for auto-evaluation (default: benchmark/js_results)")
    parser.add_argument("--excel", type=Path, default=Path("benchmark/results.xlsx"),
                        help="Excel output path for auto-evaluation (default: benchmark/results.xlsx)")
    parser.add_argument("--benchmark-mode", choices=("strict", "final"), default="strict",
                        help="strict records hashes, content-stability, markdown, middle JSON, "
                             "and model JSON for audit. final skips those extra audit artifacts "
                             "for timing runs where compute overhead must be minimized.")
    parser.add_argument("--no-evaluate", action="store_true", default=False,
                        help="Do not auto-run the evaluator after the batch")
    args = parser.parse_args()

    # Accept a single file path OR a directory; support PDF + image inputs.
    INPUT_EXTS = (".pdf", ".png", ".jpg", ".jpeg", ".bmp", ".webp",
                  ".tiff", ".tif", ".gif", ".jp2")
    if args.pdfs.is_file():
        pdf_paths = [args.pdfs]
    else:
        pdf_paths = sorted(
            p for p in args.pdfs.glob("*")
            if p.suffix.lower() in INPUT_EXTS)
    if not pdf_paths:
        logger.error(f"No PDF/image files found in {args.pdfs}")
        sys.exit(1)

    warmup_runs = 0 if args.no_warmup else max(0, args.warmup)

    logger.info(f"Found {len(pdf_paths)} file(s): {[p.name for p in pdf_paths]}")
    logger.info(f"EP mode: {args.ep_mode}, Formula: {args.formula}, Table: {args.table}, "
                f"Repeat: {args.repeat}, Warmup: {warmup_runs}, "
                f"Benchmark mode: {args.benchmark_mode}")

    run_batch(
        pdf_paths=pdf_paths,
        output_dir=args.output,
        benchmark_dir=args.benchmark_dir,
        parse_method=args.parse_method,
        formula_enable=args.formula,
        table_enable=args.table,
        repeat=args.repeat,
        warmup=warmup_runs,
        ep_mode=args.ep_mode,
        audit_provenance=args.benchmark_mode == "strict",
        check_content_stability=args.benchmark_mode == "strict",
        audit_outputs=args.benchmark_mode == "strict",
    )

    if not args.no_evaluate:
        maybe_run_evaluation(args.js_dir, args.benchmark_dir, args.excel)
