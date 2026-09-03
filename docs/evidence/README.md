# Evidence — Evaluation Results (OmniDocBench v1.6, Sept 2026)

This folder archives the **stratified evaluation workbooks** that back the numbers in the root `README.md` benchmark tables and in `benchmark/README.md`.

**Provenance:**
- **Population:** OmniDocBench v1.6 — 1651 pages, 10 `data_source` types, 5 `layout` types, 5 `language` types
- **Sample:** `data_source × language` stratified, seed **42**, min **3/stratum**, largest-remainder rounding — **N=350 output** + **N=50 timing subset** (3 warm-up +10 measurement runs)
- **Generator:** `benchmark/evaluate.py` (openpyxl, Wilcoxon paired + Holm per family, bootstrap 5000 seed 42, geometric mean, rank-biserial)
- **Environment:** i5-4690 / RX 580 8GB / Win10 19045 / Chrome **148.0.7778.216** / ORT Web **1.24.3** vs DirectML **1.24.4** / OpenCV.js 4.10.0 — WASM for formula+table, WebGPU for layout/OCR
- **Manifest:** `sample_manifest.json` (seed 42) — archived conceptually; stratification proof in `Komposisi kategori dokumen per tata letak.csv` (stratified counts). Full `py_results/` + `js_results/` `run_config`/`metadata`/`content_stability` embedded.
- **Generated:** 2026-09-02, report modes `accuracy_final` / `timing_final`

| File | Sheets | Purpose | Key numbers |
|---|---|---|---|
| `results_accuracy_final.xlsx` (204 KB) | Summary, Per Document (350×81), Aggregate Stats (38×7), Statistical Tests (11×10), Content List Diff (351×17) | **Port-fidelity** JS↔Py (Py as baseline, not GT) | Coverage F1 **0.9528**, TypeCons 0.9971, TEDS **0.9069**/Struct **0.9504**, IoU **0.9021**, Kendall **0.9428** |
| `results_accuracy_final_gt_accuracy.xlsx` (108 KB) | Summary per System, Per Category (21×17), Per Language (11×17), JS vs Py (vs GT), Sample Adequacy (40×6) | **Accuracy** vs OmniDocBench GT — source of README composite | **Proxy composite 71.6933 (JS) vs 74.2855 (Py)** Δ -2.59 CI [-3.94;-1.28] p 8e-06, Text Edit 0.2679 vs 0.2380, TEDS 0.7275 vs 0.7385 ns, Formula Edit 0.454 vs 0.440 ns |
| `results_timing.xlsx` (46 KB) | Same 5 as accuracy_final | **Timing** | **7.5785 s vs 3.8105 s**, georatio **1.804** CI [1.645;1.998], CV 1.02% vs 2.27% |

**Derived CSVs** (from `reanalysis.py`):
- `Hasil berpasangan per dokumen.csv` (350 rows) — paired per-doc GT scores (source for JS vs Py sheet)
- `Hasil akurasi/port-fidelity/waktu per tata letak.csv` — per-layout means
- `Komposisi kategori dokumen per tata letak.csv` — stratification proof

**Metrics note:** Formula Edit = normalized LaTeX edit distance (CDM proxy; CDM needs TeX Live — see `benchmark/README.md`), **proxy composite ≠ official Overall** `((1−TextEdit)×100+TEDS+CDM)/3`.

**Reproducibility:** `pip install -e ./python && pip install -r benchmark/requirements.txt && PYTHONPATH=python python -m benchmark.omnidocbench --gt-json ./omnidocbench/OmniDocBench.json --out-dir benchmark/omnidocbench_gt && python -m benchmark.sampler --accuracy-n 350 --timing-n 50 --seed 42 ... && PYTHONPATH=python python -m demo.demo_batch ... && python -m benchmark.evaluate ...` — see `benchmark/README.md` Prerequisites & Methodology Notes + main `README.md` Dataset section.
