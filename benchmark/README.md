# Benchmark — Comparative Evaluation: JS (Browser) vs Python

Empirical evaluation of **System A (JS/browser)** vs **System B (Python)** — the
Python reference implementation (`python/rapid_doc/`). After a run, data is
processed directly into Excel (`results.xlsx`) plus a per-item diff dump for
auditing — for both JS and Python.

> **New to running an experiment?** Start with the workflow below. This document
> is the general metric & workflow reference; methodology rationale is in the
> `Methodology Notes` section below.

## Metrics

### Timing
- `total_inference_s` (layout+ocr+formula+table), `model_init` EXCLUDED from inference
- T_A / T_B ratio per document + aggregated **geometric mean** (avoids mean-of-ratios bias)
  with **95% bootstrap confidence intervals**
- **Per-page inference** (s/page) to control for document length
- **True cold start** = first-call latency of the first warm-up run (JIT/shader
  compile; in the browser with a cold cache this includes weight download),
  reported as a separate headline metric
- Coefficient of Variation (CV = std/mean) as a stability indicator
- **Wilcoxon signed-rank test** (paired, JS vs Python) + effect size (rank-biserial)
  + **Holm-Bonferroni correction** for multiple comparisons
- **Two deployment configs** compared equivalently across systems:
  `accelerated` (WebGPU↔DirectML) and `cpu` (WASM↔CPU). Framed as
  "System A vs System B as deployed", not runtime/EP isolation

### Output Parity (per-page alignment, content-aware)
- **Type Sequence Difference** — structural difference of the type sequence
- **Coverage precision / recall / F1** — explicitly captures missing / extra items
- **Mean NED raw & normalized** (Unicode NFC + whitespace collapse)
- **CER / WER** — text error rate (reference = Python)
- **TEDS** — Tree-Edit-Distance Similarity for HTML table structure
- **Mean bbox IoU** — positional agreement of matched items
- **Reading order correlation** — Kendall τ and Spearman ρ

> Methodological honesty note: Python is treated as the *reference baseline*,
> not ground truth. Metrics measure **divergence of the JS port from the
> baseline**, not absolute correctness. Absolute accuracy requires manual
> ground-truth annotations (see OmniDocBench mode below).

## Workflow

```
Input: identical document set for both systems

System A (JS)                          System B (Python)
─────────────────────────────         ─────────────────────────────
1. Open /benchmark.html                1. Run the Python reference batch
2. Drop all documents                     → writes to benchmark/py_results/
3. Set repeat count (≥10 advised)      2. IF JS results already exist in
4. Start Benchmark                         benchmark/js_results/, evaluation
5. Export Results:                         runs automatically → results.xlsx
   - benchmark_js_*.json (combined)
   - <stem>_timing.json, <stem>_content_list.json
   - benchmark_js_*.xlsx (standalone JS Excel, ready to use)
6. Move JSON files to benchmark/js_results/
```

Full evaluation (JS↔Python):
```bash
python -m benchmark.evaluate \
    --js-dir benchmark/js_results \
    --py-dir benchmark/py_results \
    --output benchmark/results.xlsx
```

Recommended order: run the JS side first (put results in `js_results/`), then
run the Python batch — evaluation triggers automatically at the end. No extra
manual steps needed.

## Prerequisites

```bash
# Node 22+, Python 3.10–3.13
pip install -e ./python                    # rapid-doc + runtime deps (from python/pyproject.toml)
pip install -r benchmark/requirements.txt  # openpyxl, scipy, numpy (Excel + stats)
npx playwright install chromium             # for js_supervised_runner.mjs
# Model download on first run: core ~285 MB, +Formula S ~520 MB (cached in IndexedDB)
# See main README "Reproducibility" + "Dataset — Fetching OmniDocBench" for full setup
```

> Completed evaluation workbooks archived in `docs/evidence/`.

## Commands

```bash
# Python batch — 10 runs + 2 warm-ups (accelerated/DirectML), auto-evaluate
# (prefix PYTHONPATH=python if you installed via pip install -e ./python, else if demo is on PYTHONPATH)
PYTHONPATH=python python -m demo.demo_batch --repeat 10 --warmup 2 --formula --table

# CPU-only deployment config (all models CPU), paired with JS WASM
PYTHONPATH=python python -m demo.demo_batch --repeat 10 --ep-mode cpu --formula --table

# Without auto-evaluation
PYTHONPATH=python python -m demo.demo_batch --repeat 10 --no-evaluate

# Manual evaluation
python -m benchmark.evaluate --js-dir benchmark/js_results --py-dir benchmark/py_results

# Metric unit tests
python -m benchmark.test_metrics
```

`benchmark.evaluate` automatically splits the combined `benchmark_js_*.json`
from `--js-dir` into `<stem>_timing.json` + `<stem>_content_list.json`, so you
can simply drop the combined JS export as-is.

> Python batch runners are shipped in this repo as `python/demo/demo_batch.py` + `demo_run.py`
> (minimal subset — ~55 KB, no `demo/images` payload). Install via `pip install -e ./python`
> then run with `PYTHONPATH=python python -m demo.demo_batch ...`. See main [README](../README.md#reproducibility--python-reference) for the full setup.

## Output

| File | Contents |
|---|---|
| `benchmark/results.xlsx` | 4 sheets: Per Document, Aggregate Statistics (+geomean), Statistical Tests (Wilcoxon), Content List Diff |
| `benchmark/diffs/<stem>_diff.json` | Per-item dump: match/only-JS/only-Py + both systems' text + NED/CER/IoU/TEDS per item |
| `benchmark/py_results/*` | Python timing + content_list (embeds run_config, metadata, content_stability) |
| `benchmark/js_results/*` | JS timing + content_list + standalone JS Excel |

## Provenance & Reproducibility (embedded automatically)

Every `_timing.json` stores:
- `run_config`: parse_method, formula/table enablement, repeat count, and **real_eps per model**
  (Python verifies DML vs CPU-fallback; JS records webgpu/wasm per model)
- `metadata`: platform, ORT version, GPU adapter + limits (JS), cross-origin-isolated,
  WASM thread count, cpu_count
- `content_stability`: verifies whether N runs produce identical output
  (the "all runs are identical" assumption is tested, not trusted)

`evaluate.py` compares JS vs Python `run_config` and flags
**config mismatch** (in red in the Excel) when formula/table/parse_method differ,
so output differences are not misattributed.

## OmniDocBench Mode (absolute accuracy vs ground truth)

Beyond JS↔Python comparison, the system can be scored against the
[OmniDocBench](https://github.com/opendatalab/OmniDocBench) (CVPR 2025) ground
truth: 1651 pages, 10 document types, 5 languages, high-quality manual
annotations. This closes the "Python is a baseline, not truth" gap — accuracy
is now measured absolutely.

```bash
# 1. Fetch the dataset (see main README "Dataset — Fetching OmniDocBench" for
#    HuggingFace / OpenDataLab CLI commands; ~1.6 GB to ./omnidocbench/)
#    After fetch you have ./omnidocbench/OmniDocBench.json + ./omnidocbench/images/*.jpg

# 2. Convert GT JSON → per-page content_list (+ attribute index for stratification)
python -m benchmark.omnidocbench --gt-json ./omnidocbench/OmniDocBench.json \
    --out-dir benchmark/omnidocbench_gt

# 3. Run both systems on the same images (JS via benchmark.html, Python via demo_batch)
#    File stems must match image_path in GT (e.g. academic_001).

# 4. Evaluate in GT mode → produces results.xlsx (JS↔Py) AND
#    results_gt_accuracy.xlsx (absolute accuracy, per-category, per-language)
python -m benchmark.evaluate \
    --js-dir benchmark/js_results --py-dir benchmark/py_results \
    --gt-dir benchmark/omnidocbench_gt --output benchmark/results.xlsx
```

GT metrics (sheet `results_gt_accuracy.xlsx`): **Proxy composite** (proxy for OmniDocBench Overall — **mean of available components per page**, not official Overall `((1−TextEdit)×100+TEDS+CDM)/3`; Formula = normalized LaTeX edit distance, not CDM), Text Edit, Text CER, Formula Edit, Table TEDS / TEDS-Struct, Reading Order Edit, Coverage F1, BBox IoU — broken down **per document type** and **per language**, plus JS vs Python head-to-head.

### Stratified sampling — 350 accuracy / 50 timing (no need for 1651 pages × 10 runs)

Running all 1651 pages × 10 runs × 2 systems is not feasible on a single
machine, and **not required**. Accuracy is deterministic per system (proven by
`content_stability`), so 1 run suffices; only **timing** needs repeats. The
dataset is therefore split into two corpora via `benchmark/sampler.py`:

| Corpus | Evaluated (v1.6) | General suggested | Runs/system | Purpose |
|---|---|---|---|---|
| **Accuracy** | **350 pages** (seed 42, `data_source×language`, min 3/stratum) | 150–250 pages | 1 | quality metrics vs GT, stratified by type+language |
| **Timing** | **50 pages** (subset of 350, 3 warm-up +10 runs) | 20–40 pages | ≥10 + warmup | timing metrics, needs repeats |

*Environment example: i5-4690 / RX 580 8GB / Win10 / Chrome 148 / ORT Web 1.24.3 vs DirectML 1.24.4 / OpenCV.js 4.10.0, WASM for formula+table, WebGPU for layout/OCR.*

Sampling: **proportional stratified** (per `data_source` × `language`), with a
**minimum per stratum** so rare types (e.g. handwritten, exam) are not lost,
**largest-remainder rounding** for exact sizes, and a **fixed seed** for
reproducibility. The sample manifest (`sample_manifest.json`) is saved for
reporting.

```bash
# 1. Convert GT first (produces omnidocbench_index.json for stratification)
python -m benchmark.omnidocbench --gt-json ./omnidocbench/OmniDocBench.json \
    --out-dir benchmark/omnidocbench_gt

# 2. Sample + copy images to a ready-to-process folder
#    Full (N=350/50): --accuracy-n 350 --timing-n 50
#    Smaller example:  --accuracy-n 200 --timing-n 30
python -m benchmark.sampler \
    --index benchmark/omnidocbench_gt/omnidocbench_index.json \
    --images ./omnidocbench/images \
    --out-dir benchmark/sample \
    --accuracy-n 350 --timing-n 50 --min-per-stratum 3 --seed 42
# → benchmark/sample/accuracy_images/  (350 images, 1 run)
# → benchmark/sample/timing_images/    (50 images, 10 runs)
# → benchmark/sample/sample_manifest.json  (lock & archive in docs/evidence/)

# 3a. ACCURACY — both systems, 1 run (formula+table ON), score vs GT
PYTHONPATH=python python -m demo.demo_batch --pdfs benchmark/sample/accuracy_images \
    --benchmark-dir benchmark/py_accuracy --repeat 1 --no-warmup --formula --table --no-evaluate
#    (JS: drop accuracy_images into benchmark.html, repeat=1, export to benchmark/js_accuracy)
python -m benchmark.evaluate --js-dir benchmark/js_accuracy \
    --py-dir benchmark/py_accuracy --gt-dir benchmark/omnidocbench_gt \
    --manifest benchmark/sample/sample_manifest.json --manifest-split accuracy \
    --report-mode accuracy_final \
    --output benchmark/results_accuracy.xlsx

# 3b. TIMING — both systems, 10 runs + warmup, on a small subset
PYTHONPATH=python python -m demo.demo_batch --pdfs benchmark/sample/timing_images \
    --benchmark-dir benchmark/py_timing --repeat 10 --warmup 2 \
    --benchmark-mode final --formula --table --no-evaluate
#    (JS: open benchmark.html?benchmarkMode=final, drop timing_images,
#     repeat=10, warmup=2, export to benchmark/js_timing)
python -m benchmark.evaluate --js-dir benchmark/js_timing \
    --py-dir benchmark/py_timing \
    --manifest benchmark/sample/sample_manifest.json --manifest-split timing \
    --report-mode timing_final --output benchmark/results_timing.xlsx
```

Reporting: accuracy as per-stratum mean + 95% CI; timing as mean/median
+ CV + Wilcoxon test. State explicitly that this is a **stratified random
sample (fixed seed)** — an estimate over the 1651-page population, not a full
census leaderboard.

### What is the minimum valid sample size?

There is no single magic number — the minimum depends on metric variance, the
margin of error, and how many strata you want to report separately. Use
`benchmark/sample_size.py` to compute it; don't guess.

**Sample sizes with finite population correction (N=1651, 95% CI):**

| Level | n accuracy | Statistical basis |
|---|---|---|
| **Minimum floor** | **100** | worst-case CI overall ±9.5%; realistic (edit-dist) ±0.03; >CLT n=30; per-stratum ~8 |
| **Suggested** | **150–200** | realistic CI ±0.02; per-stratum 10–20 + per-category CI |
| **Strong** | **300–350** | meets ±5% even for worst-case (proportion) metrics |

Important: OCR metrics (edit distance, TEDS) usually have **low variance**, so
a small n often already yields a narrow CI. The binding constraint is usually
**per-stratum** (so each document type × language has ≥10–15).

**Timing corpus** (separate): 15–30 documents × ≥10 repeats. Minimum ~15
documents for adequate power in the paired Wilcoxon test.

**Rigorous approach (recommended): pilot first, measure variance, then size.**

```bash
# 1. Small pilot: take ~30 samples, run both systems, score vs GT
python -m benchmark.sampler --index benchmark/omnidocbench_gt/omnidocbench_index.json \
    --images path/to/images --out-dir benchmark/pilot --accuracy-n 30 --timing-n 10 --seed 42
#    (process the pilot in both systems → benchmark/js_pilot, benchmark/py_pilot)
python -m benchmark.evaluate --js-dir benchmark/js_pilot --py-dir benchmark/py_pilot \
    --gt-dir benchmark/omnidocbench_gt --output benchmark/pilot_results.xlsx

# 2. Compute the required n from the pilot's actual std (target margin ±0.03)
python -m benchmark.sample_size --pilot benchmark/pilot_results_gt_accuracy.xlsx --margin 0.03

# 3. Theory table (no data) for methodology justification
python -m benchmark.sample_size --population 1651 --confidence 0.95
```

Pilot mode reads each metric's std from the pilot results, then reports the
**required n** to reach the target margin — that number is what you use as
`--accuracy-n` in the full run. This is defensible: the sample size is computed
from measured variance, not picked arbitrarily.

> **Documented deviation**: the official OmniDocBench formula metric is **CDM**
> (TeX Live + ImageMagick + Ghostscript) and Overall is `((1−TextEdit)×100+TEDS+CDM)/3`. Because CDM is
> heavyweight and not relevant for a browser port, formulas are scored with
> **normalized-LaTeX edit distance** as a proxy and the composite is **Skor Komposit Proksi** (mean of
> available components per page). State this so full parity with the official leaderboard is not claimed. v1.6, not v1.5.

## Methodology Notes

- **Deployment-config framing (not variable isolation)**: the default
  comparison (`accelerated`) is an *end-to-end deployment configuration*
  (browser-native WebGPU/WASM vs Python-native DirectML/CPU). Framed as
  "System A vs B as deployed", NOT language/runtime/EP isolation. A CPU-only
  deployment is also available: `--ep-mode cpu` (Python) + WASM (JS) → WASM↔CPU.
  `evaluate.py` flags when JS & Python ran in different ep_modes
  (not an equivalent deployment pair).
- **Model init is excluded** from inference because after warm-up BOTH systems
  use model caches (`ModelSingleton._models` persists across runs in Python;
  VRAM cache in JS). **NOT** because "Python reloads every run" (that claim is
  false). True cold-start is reported separately from the first warm-up run.
- **Warm-up runs** are excluded from statistics (JIT, cache misses, driver init).
- **Geometric mean** for ratios; mean-of-ratios is statistically biased.
- **n ≥ 5** suggested; report CV + Wilcoxon test, not just the mean.
- Document environmental conditions (back-to-back runs, power plan, idle GPU,
  temperature).
- Stratify the dataset (text-heavy, formula, table, scan vs born-digital,
  language) and report per-category, not just overall.
