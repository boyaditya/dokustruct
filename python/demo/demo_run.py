"""
RapidDoc Python pipeline runner — JS-parity execution provider configuration
plus per-stage timing instrumentation for benchmark/skripsi reporting.

Per-model EP mapping (matches JS defaults in rapid_doc/model/**/provider_config.js):

    Layout  PP-DocLayoutV2          → DirectML       (JS: WebGPU)
    OCR     PP-OCRv5 det+rec        → DirectML       (JS: WebGPU; rapidocr supports DML via engine_cfg.use_dml)
    Formula PP-FormulaNet_plus-S    → CPU            (JS: WASM, ONNX `Loop` autoregressive)
    Table   UNET + SLANET_PLUS      → CPU            (JS: WASM, hardcoded)

Notes on EP choices:
- DirectML is the Windows-native GPU EP that ONNXRuntime exposes for
  non-CUDA hardware. It is the closest analogue to the JS WebGPU path
  and works across vendors (AMD / Intel / Nvidia).
- CUDA can be used instead by installing onnxruntime-gpu and setting
  MINERU_DEVICE_MODE=cuda; this overrides the layout/OCR DML config.
- Formula and table run on CPU because the JS reference path runs them
  on WASM (no GPU acceleration available there).

Timing output:
    <output_dir>/<file_stem>/auto/<file_stem>_timing.json
    plus a console summary at end of run.

Run (from workspace root, so the `demo` package is importable):
    rtk python -m demo.demo_run
    .venv\Scripts\python.exe -m demo.demo_run
"""

from __future__ import annotations

import copy
import json
import os
import platform
import sys
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterator, List

from dotenv import load_dotenv

# Load .env first so MINERU_DEVICE_MODE / RAPID_MODELS_DIR take effect before rapid_doc imports.
load_dotenv()

# Lazy imports after env vars are set.
from loguru import logger  # noqa: E402

from rapid_doc.data.data_reader_writer import FileBasedDataWriter  # noqa: E402
from rapid_doc.utils.draw_bbox import draw_layout_bbox, draw_span_bbox  # noqa: E402
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
from rapid_doc.backend.pipeline.pipeline_middle_json_mkcontent import union_make as pipeline_union_make  # noqa: E402
from rapid_doc.backend.pipeline.model_json_to_middle_json import (  # noqa: E402
    result_to_middle_json as pipeline_result_to_middle_json,
)


# ─── Timing helpers ──────────────────────────────────────────────────────────


class TimingRecorder:
    """Collects per-stage durations for a single file run.

    Each stage is recorded once or accumulated across multiple invocations
    (e.g. per-batch infer and middle_json calls). Output is JSON-serialisable.
    """

    def __init__(self, filename: str) -> None:
        self.filename: str = filename
        self.stages: Dict[str, float] = {}
        self.batches: List[Dict[str, Any]] = []
        self._t_start: float = time.perf_counter()
        self._page_count: int | None = None

    @contextmanager
    def stage(self, name: str) -> Iterator[None]:
        """Time a single named stage. Adds to existing key if called multiple times."""
        t0 = time.perf_counter()
        try:
            yield
        finally:
            elapsed = time.perf_counter() - t0
            self.stages[name] = self.stages.get(name, 0.0) + elapsed

    @contextmanager
    def batch(self, batch_idx: int, pages: int) -> Iterator[Dict[str, float]]:
        """Time a single page-batch. Yields a dict the caller can mutate
        to record sub-stage timings (doc_analyze, middle_json)."""
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


def collect_runtime_metadata() -> Dict[str, Any]:
    """Capture environment info for benchmark reproducibility."""
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
        "device_mode": os.getenv("MINERU_DEVICE_MODE"),
        "rapid_models_dir": os.getenv("RAPID_MODELS_DIR"),
        "ort_version": ort_version,
        "ort_providers": ort_providers,
        "rapid_doc_version": rapid_doc_version,
    }


# ─── Parity config (matches JS defaults) ─────────────────────────────────────


def build_parity_config(ep_mode: str = "accelerated"):
    """Return (layout, ocr, formula, table, checkbox, image) configs.

    ep_mode selects which DEPLOYMENT CONFIGURATION is benchmarked. The study
    compares the two systems *as they are realistically deployed*, not the
    JS-vs-Python language/runtime in isolation. Each ep_mode is a legitimate,
    self-consistent deployment scenario:

      - "accelerated" (default): the realistic per-platform deployment —
        layout + OCR on DirectML (GPU), formula + table on CPU. This is the
        Windows-native analogue of the JS WebGPU deployment and the HEADLINE
        comparison.
      - "cpu": the CPU-only deployment — ALL models on CPU. The comparable
        Python deployment when no GPU/DirectML is available, paired against the
        JS WASM deployment.

    Both modes are reported as deployment-configuration comparisons (System A
    as deployed vs System B as deployed). We do NOT claim to isolate "runtime"
    from "GPU backend"; the EP is part of the deployment under test.
    """
    from rapidocr import EngineType as OCREngineType, OCRVersion
    from rapid_doc.model.layout.rapid_layout_self import ModelType as LayoutModelType
    from rapid_doc.model.formula.rapid_formula_self import (
        ModelType as FormulaModelType,
        EngineType as FormulaEngineType,
    )
    from rapid_doc.model.table.rapid_table_self import (
        ModelType as TableModelType,
        EngineType as TableEngineType,
    )

    use_gpu = ep_mode != "cpu"

    layout_config = {
        "model_type": LayoutModelType.PP_DOCLAYOUTV2,
        "engine_cfg": {"use_dml": use_gpu},
    }
    ocr_config = {
        "engine_type": OCREngineType.ONNXRUNTIME,
        "Det.engine_type": OCREngineType.ONNXRUNTIME,
        "Rec.engine_type": OCREngineType.ONNXRUNTIME,
        "Det.ocr_version": OCRVersion.PPOCRV5,
        "Rec.ocr_version": OCRVersion.PPOCRV5,
        # DirectML EP toggle, applied to the shared EngineConfig.onnxruntime block.
        # Set once → DML enabled for det, cls, and rec sessions in rapidocr.
        "EngineConfig.onnxruntime.use_dml": use_gpu,
    }
    formula_config = {
        "model_type": FormulaModelType.PP_FORMULANET_PLUS_S,
        "engine_type": FormulaEngineType.ONNXRUNTIME,
        "engine_cfg": {"use_cuda": False, "use_dml": False, "use_cann": False},
    }
    table_config = {
        "model_type": TableModelType.UNET_SLANET_PLUS,
        "engine_type": TableEngineType.ONNXRUNTIME,
        "engine_cfg": {"use_cuda": False, "use_dml": False, "use_cann": False},
    }
    checkbox_config: Dict[str, Any] = {}
    image_config: Dict[str, Any] = {}
    return layout_config, ocr_config, formula_config, table_config, checkbox_config, image_config


# ─── Instrumented per-file pipeline runner ───────────────────────────────────


def run_one_file(
    pdf_path: Path,
    output_dir: Path,
    parse_method: str = "auto",
    p_formula_enable: bool = True,
    p_table_enable: bool = True,
    f_make_md_mode=MakeMode.MM_MD,
) -> Dict[str, Any]:
    """Process a single PDF/image, recording per-stage timings.

    Returns the timing record (also written to disk).
    """
    file_name = pdf_path.stem
    timing = TimingRecorder(filename=pdf_path.name)

    # Stage: read PDF bytes from disk
    with timing.stage("read_pdf_bytes"):
        pdf_bytes = read_fn(pdf_path)

    # Stage: build configs and prepare output dir
    with timing.stage("build_config"):
        layout_config, ocr_config, formula_config, table_config, checkbox_config, image_config = (
            build_parity_config()
        )
    with timing.stage("prepare_env"):
        local_image_dir, local_md_dir = prepare_env(str(output_dir), file_name, parse_method)
        image_writer = FileBasedDataWriter(local_image_dir)
        md_writer = FileBasedDataWriter(local_md_dir)

    pdf_pages_batch = get_processing_window_size(default=64)

    # Pre-warm models so we can isolate model_init time from per-batch inference time.
    # ModelSingleton caches the constructed pipeline by config hash; subsequent
    # doc_analyze calls with the same configs reuse the cached model and skip init.
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

    # Per-batch loop. doc_analyze now reuses the warmed model.
    middle_json_list: Dict[str, Any] | None = None
    model_json_acc: List[Any] = []
    finished = False
    tmp_start_page_id = 0
    batch_idx = 0

    while not finished:
        # Use a placeholder for actual page count; will overwrite once we know.
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

            t_mj = time.perf_counter()
            model_list = infer_results[0]
            batch_record["pages"] = len(model_list)
            model_json_acc.extend(copy.deepcopy(model_list))

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

    assert middle_json_list is not None, "Pipeline produced no output"
    pdf_info = middle_json_list["pdf_info"]
    timing.set_page_count(len(pdf_info))

    # Output stages
    with timing.stage("draw_layout_bbox"):
        draw_layout_bbox(pdf_info, pdf_bytes, local_md_dir, f"{file_name}_layout.pdf")
    with timing.stage("draw_span_bbox"):
        draw_span_bbox(pdf_info, pdf_bytes, local_md_dir, f"{file_name}_span.pdf")
    with timing.stage("dump_origin_pdf"):
        md_writer.write(f"{file_name}_origin.pdf", pdf_bytes)

    image_dir_basename = os.path.basename(local_image_dir)
    with timing.stage("make_markdown"):
        md_content = pipeline_union_make(pdf_info, f_make_md_mode, image_dir_basename)
        md_writer.write_string(f"{file_name}.md", md_content)
    with timing.stage("make_content_list"):
        content_list = pipeline_union_make(pdf_info, MakeMode.CONTENT_LIST, image_dir_basename)
        md_writer.write_string(
            f"{file_name}_content_list.json",
            json.dumps(content_list, ensure_ascii=False, indent=4),
        )
    with timing.stage("dump_middle_json"):
        md_writer.write_string(
            f"{file_name}_middle.json",
            json.dumps(middle_json_list, ensure_ascii=False, indent=4),
        )
    with timing.stage("dump_model_json"):
        md_writer.write_string(
            f"{file_name}_model.json",
            json.dumps(model_json_acc, ensure_ascii=False, indent=4),
        )

    # Persist timing record next to the other outputs
    record = timing.finalize()
    md_writer.write_string(
        f"{file_name}_timing.json",
        json.dumps(record, ensure_ascii=False, indent=2),
    )
    logger.info(f"local output dir is {local_md_dir}")
    return record


# ─── Entry point ─────────────────────────────────────────────────────────────


def print_summary(metadata: Dict[str, Any], records: List[Dict[str, Any]]) -> None:
    print()
    print("=" * 70)
    print(" RapidDoc Python pipeline timing summary")
    print("=" * 70)
    print(f" Timestamp        : {metadata['timestamp']}")
    print(f" Platform         : {metadata['platform']}")
    print(f" Python           : {metadata['python']}")
    print(f" rapid-doc        : {metadata['rapid_doc_version']}")
    print(f" onnxruntime      : {metadata['ort_version']}")
    print(f" Providers        : {metadata['ort_providers']}")
    print(f" MINERU_DEVICE    : {metadata['device_mode']}")
    print("-" * 70)
    for rec in records:
        print(f" {rec['filename']}  ({rec['page_count']} pages, total {rec['total_seconds']:.2f}s)")
        for name, secs in rec["stages"].items():
            print(f"   {name:<40s} {secs:>8.3f} s")
        if rec["batches"]:
            print(f"   batches: {len(rec['batches'])}")
            for b in rec["batches"]:
                print(
                    f"     batch {b['batch_idx']:<2d} pages={b['pages']:<3d} "
                    f"doc_analyze={b.get('doc_analyze', 0):>6.2f}s  "
                    f"middle_json={b.get('middle_json', 0):>5.2f}s  "
                    f"wall={b.get('wall_clock', 0):>6.2f}s"
                )
        print()
    print("=" * 70)


if __name__ == "__main__":
    import onnxruntime as ort

    metadata = collect_runtime_metadata()
    logger.info(f"ONNXRuntime: {ort.__version__}, providers: {ort.get_available_providers()}")
    logger.info(f"MINERU_DEVICE_MODE = {os.getenv('MINERU_DEVICE_MODE')!r}")
    logger.info(f"RAPID_MODELS_DIR   = {os.getenv('RAPID_MODELS_DIR')!r}")

    base_dir = Path(__file__).resolve().parent
    output_dir = base_dir / "output"

    sample = base_dir / "pdfs" / "book_en_6.Complex.Analysis.-.Elias.M..Stein_page_205.png"
    if not sample.exists():
        candidates = sorted((base_dir / "pdfs").glob("*.pdf"))
        if not candidates:
            raise SystemExit(f"No PDF samples found under {base_dir / 'pdfs'}")
        sample = candidates[0]

    logger.info(f"Using sample: {sample}")

    records: List[Dict[str, Any]] = []
    overall_start = time.perf_counter()
    record = run_one_file(sample, output_dir)
    records.append(record)
    overall_wall = time.perf_counter() - overall_start

    summary = {
        "metadata": metadata,
        "files": records,
        "totals": {
            "files_processed": len(records),
            "total_pages": sum(r.get("page_count") or 0 for r in records),
            "wall_clock": round(overall_wall, 4),
        },
    }
    summary_path = output_dir / "timing_summary.json"
    output_dir.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"Aggregated timing written to {summary_path}")

    print_summary(metadata, records)
