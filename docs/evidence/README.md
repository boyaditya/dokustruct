# Evidence — Evaluation Results (OmniDocBench v1.6, September 2026)

This folder archives the stratified evaluation workbooks that support the numbers in the root `README.md` and `benchmark/README.md`.

## Provenance

- **Population:** OmniDocBench v1.6 — 1,651 pages, 10 `data_source` types, 5 `layout` types, 5 `language` types.
- **Sampling:** `data_source × language` stratified, seed **42**, minimum **3 per stratum**, largest-remainder rounding — **N=350 output** + **N=50 timing subset** (3 warm-up + 10 measured runs).
- **Generator:** `benchmark/evaluate.py` (openpyxl, Wilcoxon paired + Holm correction per family, bootstrap 5,000, seed 42, geometric mean, rank-biserial correlation).
- **Environment:** Intel i5-4690 / AMD RX 580 8 GB / Windows 10 19045 / Chrome **148.0.7778.216** / ONNX Runtime Web **1.24.3** vs DirectML **1.24.4** / OpenCV.js 4.10.0 — WASM for formula and table, WebGPU for layout and OCR.
- **Manifest:** `sample_manifest.json` (seed 42) archived conceptually; stratification proof in `Document category composition by layout.csv`. Full `py_results/` and `js_results/` with `run_config` / `metadata` / `content_stability` are embedded in the workbooks.
- **Generated:** 2026-09-02, report modes `accuracy_final` and `timing_final`.

## Workbooks

| File | Sheets | Purpose | Key figures |
|------|--------|---------|-------------|
| `results_accuracy_final.xlsx` (204 KB) | Summary, Per Document (350×81), Aggregate Stats (38×7), Statistical Tests (11×10), Content List Diff (351×17) | **Port fidelity** JS vs Python (Python as baseline, not ground truth) | Coverage F1 **0.9528**, Type consistency 0.9971, TEDS **0.9069** / TEDS-Struct **0.9504**, BBox IoU **0.9021**, Kendall tau **0.9428** |
| `results_accuracy_final_gt_accuracy.xlsx` (108 KB) | Summary per System, Per Category (21×17), Per Language (11×17), JS vs Py (vs ground truth), Sample Adequacy (40×6) | **Accuracy** vs OmniDocBench ground truth — source of README composite | **Proxy composite 71.69 (JS) vs 74.29 (Py)**, Δ -2.59 CI [-3.94, -1.28] p 8e-06, Text Edit 0.268 vs 0.238, TEDS 0.728 vs 0.739 ns, Formula Edit 0.454 vs 0.440 ns |
| `results_timing.xlsx` (46 KB) | Same 5 sheets as accuracy | **Timing** (geomean, 50 pages, 10 runs) | **7.58 s vs 3.81 s**, geometric mean ratio **1.80** CI [1.645, 1.998], CV 1.02% vs 2.27%, formula bottleneck ~2.44× |

## Derived CSVs

Exported from the workbooks for quick inspection:

- `Paired results per document.csv` (350 rows) — paired per-document ground-truth scores, source for the JS vs Py sheet.
- `Accuracy by layout.csv` — mean scores aggregated by layout type.
- `Port fidelity by layout.csv` — port fidelity means by layout type.
- `Timing by layout.csv` — timing means by layout type.
- `Document category composition by layout.csv` — stratified sample counts by `layout` and `data_source`, proof of stratification.

## Metrics

- **Coverage F1, Type consistency, BBox IoU, Kendall tau:** layout and reading-order fidelity.
- **Text similarity:** normalized edit distance on extracted text.
- **TEDS / TEDS-Struct:** table structure and content similarity.
- **Formula similarity:** normalized LaTeX edit distance. This is a **proxy for CDM**; the official CDM requires TeX Live. See `benchmark/README.md`.
- **Proxy composite:** `(1 - TextEdit) × 100` averaged with TEDS and the formula proxy. This is **not the official Overall** CDM score `((1-TextEdit)×100+TEDS+CDM)/3`.

## Reproducibility

Full steps, prerequisites, and sample-size notes are in `benchmark/README.md` and the root `README.md` Dataset section. Minimal reproduction:

```bash
pip install -e ./python
pip install -r benchmark/requirements.txt
PYTHONPATH=python python -m benchmark.omnidocbench --gt-json ./omnidocbench/OmniDocBench.json --out-dir benchmark/omnidocbench_gt
python -m benchmark.sampler --accuracy-n 350 --timing-n 50 --seed 42 --index benchmark/omnidocbench_gt/omnidocbench_index.json --images ./omnidocbench/images --out-dir benchmark/sample
PYTHONPATH=python python -m demo.demo_batch --pdfs benchmark/sample/accuracy_images --out-dir benchmark/py_results --formula --table
# JS: run via benchmark/js_supervised_runner.mjs or the browser app, then:
python -m benchmark.evaluate --js-dir benchmark/js_results --py-dir benchmark/py_results --gt-dir benchmark/omnidocbench_gt --output benchmark/results.xlsx
```

The three evaluations are independent: port fidelity (JS vs Python), accuracy (system vs ground truth), and timing (same device). High fidelity does not automatically imply high accuracy.
