# DokuStruct — Document Intelligence in Your Browser

![version](https://img.shields.io/badge/version-0.1.0-blue) ![python](https://img.shields.io/badge/python-0.9.4-green) ![mineru](https://img.shields.io/badge/mineru-2.6.4-lightgrey) ![demo](https://img.shields.io/badge/demo-live-brightgreen) ![license](https://img.shields.io/badge/license-Apache--2.0-blue) ![tests](https://img.shields.io/badge/tests-241%20passing-brightgreen)

**DokuStruct** is a browser-native document intelligence engine that performs OCR, layout analysis, formula recognition, table recognition, and reading order recovery — entirely client-side using ONNX Runtime Web. No server, no upload, no installation.

This project is a **JavaScript port** of [RapidDoc](https://github.com/RapidAI/RapidDoc) (itself adapted from [MinerU](https://github.com/opendatalab/MinerU)), bringing the full document parsing pipeline to the browser via WebAssembly + WebGPU.

> Privacy-first: your documents never leave the browser. All models run locally via WASM or WebGPU.

---

## Features

- **OCR Recognition** — PP-OCRv5 (detection + recognition + classification)
- **Layout Analysis** — PP-DocLayout V2/V3/Plus-L (with built-in reading order)
- **Formula Recognition** — PP-FormulaNet Plus (S/M variants, WebGPU accelerated)
- **Table Recognition** — SLANet-Plus + UNet hybrid pipeline
- **Reading Order Recovery** — XY-cut based layout parsing
- **Seal/Stamp Detection** — Optional seal text detection
- **Document Orientation** — 90°/270° auto-correction
- **Export** — Markdown, HTML, DOCX with formatting preserved
- **Batch Processing** — Multiple documents in sequence, windowed to avoid OOM
- **100% Browser-Based** — Models run via ONNX Runtime Web (WASM + WebGPU)

---

## Demo

[Try the live demo →](https://dokustruct.vercel.app)

*Models are downloaded to your browser's IndexedDB on first use — core ~285 MB (layout V2 + OCR + table + orientation) + optional formula +233 MB (S) / +594 MB (M). First load ~320 MB (core) or ~550 MB (with Formula S); subsequent loads use cached models.*

---

## Quick Start

```bash
git clone https://github.com/boyaditya/dokustruct.git
cd dokustruct

# Install dependencies
npm install

# Start dev server
npm run dev
# → http://localhost:5173
```

### Production Build

```bash
npm run build
npm run preview
```

### Testing & Linting

```bash
npm test         # unit + property tests (Vitest)
npm run lint     # ESLint (rapid_doc/, ui/) incl. bbox rounding rule
```

---

## Architecture

```
PDF/Image → page slicing → layout detection (PP-DocLayout)
                            → OCR (PP-OCRv5: det + rec)
                            → formula recognition (PP-FormulaNet Plus)
                            → table recognition (SLANet-Plus + UNet)
                            → reading order (XY-cut)
                            → orientation correction
                            → content assembly → Markdown/HTML export
```

```
rapid_doc/           ← JS source (browser port, 187 files)
├── backend/pipeline/   — Analysis pipeline, batching, model orchestration (12)
├── model/              — Model wrappers: OCR / layout / formula / table / reading_order (128)
├── utils/              — PDF, image, geometry, OCR, config helpers (43)
├── cli/ + data/        — CLI stubs + MemoryDataWriter
└── index.js + version.js — Public barrel + version

ui/                 ← Frontend SPA (vanilla JS, 26 files)
├── app.js           — Main entry point (5.5k lines)
├── state/              — Central state management
├── render/             — Rendering subsystem (actions, connectors, styling)
├── lifecycle/          — Lifecycle (disposerChain, listenerBag)
├── linking/            — Viewer↔markdown bidirectional linking (4)
├── history/            — History list & IndexedDB storage (3)
├── utils/              — pipelineAdapter, exportUtils, xlsxWriter (3)
├── perf/               — Performance (rafCoalescer, virtualization)
└── styles/             — Application styles

python/             ← Python reference (porting canon, 272 files)
├── rapid_doc/          — Original Python package (same structure as JS, 267 files)
├── demo/               — Reproducible batch runners (demo_batch.py, demo_run.py)
├── pyproject.toml      — Dependencies (pip install -e ./python)
└── LICENSE             — Apache 2.0 (upstream)

benchmark/          ← Evaluation framework (14 files)
│   evaluate.py / metrics.py / alignment.py — scoring + 4-sheet Excel
│   sampler.py / sample_size.py — stratified sampling (N=350, seed 42)
│   omnidocbench.py — GT conversion
│   js_supervised_runner.mjs — headless JS runner
└── README.md       — full methodology (geomean, bootstrap CI, Wilcoxon)

tests/              ← 17 test files (12 unit + 5 properties, 241 tests)
tooling/            ← ESLint custom rule (no-math-round-bbox)
docs/plans/         ← VRAM chunking design doc
public/             ← Vendored runtimes (opencv.js, ort wasm)
```

The JS port maintains **behavioral parity** with the Python reference. Each module in `rapid_doc/` has a corresponding `.py` file in `python/rapid_doc/` with the same interface contract, documented in per-file `PORTING NOTE` headers.

### Runtime Insights

- **Providers are configured, not observed** — layout dynamically picks WebGPU/WASM, OCR/orientation follow the UI toggle, formula (PP-FormulaNet Plus, `Loop`) and table (SLANet) are intentionally WASM-only and ignore the WebGPU toggle. “WebGPU selected” means configured for 3/5 groups, not observed per-session.
- **Three coordinate spaces** — rendered pixels (model) → PDF points (Middle JSON) → per-mille 0–1000 (`content_list`). Always annotate which space a box is in.
- **Three chunking levels** — L1 adapter chunk (8 pages, browser-only, OOM guard, `engineReset` between chunks) → L2 engine window (4 WASM / 2 WebGPU) → L3 stage batch per model. Sequential with `yieldToBrowser()` (`scheduler.yield` → `MessageChannel`), not parallel.
- **Two caches + LRU** — IndexedDB `rapiddoc_model_cache` (core ~285 MB, persistent) vs. in-memory `ModelSingleton` sessions + LRU 12-entry `memoryCache` (~500 MB cap). `engineReset()` clears the latter and flushes WebGPU `releaseGpuDevice()` — only way to return pooled buffers.
- **Graphs patched offline** — `ceil_mode` removal + shape fixes (ADP-26); `sha256` tracks patched bytes (24 assets, verified via SubtleCrypto **before** cache on both UI and `DownloadFile` hot paths).
- **Explicit lifecycle** — `cv.Mat.delete()` / `tensor.dispose()` / `session.release()` required; `deviceLost` skips `release()`, global mutex `acquireGlobalGpu()` serializes `session.run()`.

See `docs/porting-decisions.md` and `docs/technical-insights.md` for full traces.

### Usage as Library

```js
import { docAnalyze } from './rapid_doc/index.js';

const pdfBytes = await file.arrayBuffer();
const { markdown, contentList, modelJson } = await docAnalyze(pdfBytes, {
  formula_enable: true,
  table_enable: true,
});
// markdown → rendered via KaTeX/Marked; contentList → JSON assay
```

### Browser Support

| Browser | Engine | Status | Notes |
|---|---|---|---|
| Chrome 121+ / Edge 121+ | WebGPU | ✅ Accelerated | Recommended; requires HTTPS + COOP/COEP headers |
| Firefox 115+ | WASM | ✅ Fallback | `SharedArrayBuffer` needs `about:config` tweak on some builds |
| Safari 17.4+ | WASM | ✅ Fallback | No WebGPU yet; WASM threaded via COOP/COEP |
| Mobile Chrome/Safari | WASM | ⚠️ Limited | Large PDFs may OOM; windowed processing helps |

*Requires `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` (see `vercel.json` + `vite.config.js`). WebGPU device-lost → auto-reload & resume from IndexedDB.*

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **ML Inference** | [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (v1.24.3) — WASM + WebGPU |
| **Rendering** | [PDF.js](https://github.com/mozilla/pdf.js) (v4.5.136) + [pdf-lib](https://github.com/Hopding/pdf-lib) (v1.17.1), [KaTeX](https://katex.org/) (v0.16.25), [Marked](https://marked.js.org/) (v14.1) |
| **Build** | [Vite](https://vitejs.dev/) (v7.3) + [Vitest](https://vitest.dev/) (v4.1) |
| **Computer Vision** | [OpenCV.js](https://docs.opencv.org/) (v4.10) |
| **OCR Assets** | `js-yaml` (v4.1), `franc-min` (v6.2), `jszip` (v3.10) |
| **Deploy** | [Vercel](https://vercel.com/) (COOP/COEP headers for SharedArrayBuffer) |

---

## Benchmark — OmniDocBench v1.6

On [OmniDocBench](https://github.com/opendatalab/OmniDocBench) (1651 pages, 10 types, 5 layouts, 5 langs) DokuStruct was evaluated with **stratified sampling N=350 (output) / N=50 (timing), seed 42, `data_source × language`, min 3/stratum**. Evaluation separates **port-fidelity → accuracy vs annotations → processing time**.

> **Metrics note** — Formula Edit is **normalized LaTeX edit distance** (not official CDM, which needs TeX Live + ImageMagick), and the composite is **proxy composite ≠ official Overall**.

### Port-fidelity — DokuStruct (JS) vs RapidDoc Python 0.9.4 — N=350

| Metric | Mean | Median | N |
|--------|:----:|:------:|:-:|
| **Coverage F1** | **0.9528** | 1.0000 | 350 |
| **Type Consistency** | 0.9971 | 1.0000 | 350 |
| **Text similarity** (1−NED) | 0.8814 | 1.0000 | 344 |
| **Formula similarity** | 0.8888 | 1.0000 | 67 |
| **TEDS** / **TEDS-Struct** | 0.9069 / **0.9504** | 1.0000 / 1.0000 | 105 |
| **BBox IoU** | **0.9021** | 0.9626 | 349 |
| **Kendall τ** (reading order) | **0.9428** | 1.0000 | 332 |

*High fidelity overall, but not uniform — gap concentrates in “other layouts” (F1 0.8902, IoU 0.7882). Wilcoxon Holm per family. Harder tail: Coverage <0.8 on 21 pages.*

### Accuracy vs OmniDocBench annotations — N=350→valid 348

| Metric | DokuStruct (JS) | RapidDoc Python | Δ (JS−Py) | 95% CI | p (Holm) |
|--------|:---------------:|:---------------:|:---------:|:------:|:--------:|
| **Proxy composite** (0-100) ↑ | **71.6933** | **74.2855** | **-2.5922** | **[-3.94;-1.28]** | **8e-06 Py** |
| Text Edit ↓ | 0.2679 | 0.2380 | +0.0299 | [0.013;0.047] | <0.001 Py |
| CER ↓ | 0.5794 | 0.4920 | +0.0874 | — | <0.001 Py |
| Formula Edit ↓ | 0.4540 | 0.4397 | +0.0143 | [0.000;0.037] | 0.22 ns |
| Table TEDS ↑ | 0.7275 | 0.7385 | -0.0110 | [-0.049;0.024] | 0.85 ns |
| TEDS-Struct ↑ | 0.8103 | 0.8224 | -0.0121 | — | 0.85 ns |
| Read Order Edit ↓ | 0.0349 | 0.0167 | +0.0182 | [0.009;0.022] | 8e-06 Py |
| Coverage ↑ | 0.8323 | 0.8451 | -0.0128 | — | 0.002 Py |
| BBox IoU ↑ | 0.7642 | 0.7959 | -0.0317 | — | <0.001 Py |

*Not significant: Formula Edit, TEDS — high fidelity does not guarantee accuracy (Spearman 0.112). Per-page win composite 122 vs 205 (21 tie).*

### Processing time — Chrome 148 / ORT Web 1.24.3 vs DirectML 1.24.4, i5-4690 + RX 580, Win10

| | DokuStruct (JS) | RapidDoc (Py) | Ratio (geomean) | 95% CI | p |
|---|:-------------:|:-------------:|:---------------:|:------:|:-:|
| **Mean total inference** (layout+det+rec+formula+table, N=50) | **7.5785 s** | **3.8105 s** | **1.804** | [1.645;1.998] | <0.001 |
| Median | 3.9622 s | 2.3724 s | 1.67 (median ratio) | — | — |
| Per-stage R (formula **2.44** N14, table 2.06 N15, layout 2.04, det 1.32, rec 1.35) — formula bottleneck |
| CV median | 1.02% | 2.27% | stable (3 warm-up +10 runs) | — | — |

*3 warm-up excluded, model cache verified (`content_stability`), bootstrap 5000 seed 42, Wilcoxon paired + Holm per family. Cold-start asset download reported separately.*

> Full workbook + `sample_manifest.json` (seed 42) archived in [`docs/evidence/`](./docs/evidence/). Details: [benchmark/README.md](./benchmark/README.md).

### Reproducibility — Python reference

The `python/` directory is a **minimal reproducible subset** of the upstream RapidDoc Python package — only what is needed to re-run the benchmark. Heavy assets (`demo/images`, `demo/pdfs`, `docker/`, `docs/`, `tests/`, `chunker/`) were omitted to keep the repo lean (~3 MB vs ~47 MB full).

```bash
# 1. Create env (Python 3.10–3.13)
python -m venv .venv && source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -e ./python          # installs rapid-doc + deps from python/pyproject.toml
pip install -r benchmark/requirements.txt  # openpyxl, scipy, numpy (Excel + stats)
# Optional: GPU acceleration on Windows
pip install -e "./python[cpu]"   # onnxruntime + openvino (CPU)
# pip install -e "./python[gpu]" # onnxruntime-gpu + torch (CUDA)

# 2. Verify import
python -c "import rapid_doc; print(rapid_doc.__version__)"
```

The two batch runners used in the benchmark are shipped as `python/demo/demo_batch.py` and `python/demo/demo_run.py` (JS-parity EP config: layout+OCR → DirectML/WebGPU, formula+table → CPU/WASM). Run via:

```bash
# PYTHONPATH must include python/ so `demo` is importable, or install as above and run as module
PYTHONPATH=python python -m demo.demo_batch --pdfs path/to/pdfs --repeat 10 --warmup 2 --formula --table
# Equivalent headless JS runner (benchmark.html automation)
node benchmark/js_supervised_runner.mjs --help
```

### Dataset — Fetching OmniDocBench

Evaluation ground truth is [OmniDocBench](https://github.com/opendatalab/OmniDocBench) (CVPR 2025) — 1651 pages, 10 types, 5 languages. Images + `OmniDocBench.json` are hosted on **Hugging Face** and **OpenDataLab**. You do **not** need the full 1651 pages for a valid report — the framework supports stratified sampling (e.g. N=350) — but the fetch steps below give you the complete source.

**Size:** ~1.6 GB (images ~1.5 GB + JSON ~15 MB). Download once, cache locally.

#### Option A — Hugging Face (recommended, resumable)

```bash
pip install huggingface_hub

# Download full dataset to ./omnidocbench/
huggingface-cli download opendatalab/OmniDocBench --repo-type dataset \
  --local-dir ./omnidocbench --local-dir-use-symlinks False

# Layout after download:
#   ./omnidocbench/OmniDocBench.json   (~15 MB, 1651 pages)
#   ./omnidocbench/images/*.jpg        (1651 images)
ls ./omnidocbench/OmniDocBench.json ./omnidocbench/images | head
```

> Alternative: `git lfs` clone — `git clone https://huggingface.co/datasets/opendatalab/OmniDocBench`

#### Option B — OpenDataLab

Browse/download at [opendatalab.com/OpenDataLab/OmniDocBench](https://opendatalab.com/OpenDataLab/OmniDocBench) (requires free account), or via CLI:

```bash
pip install openxlab
openxlab dataset get --dataset-repo OpenDataLab/OmniDocBench --target-path ./omnidocbench
```

#### After download — wire into the benchmark

```bash
# 1. Convert GT JSON → per-page content_list + attribute index (for stratification)
python -m benchmark.omnidocbench --gt-json ./omnidocbench/OmniDocBench.json \
  --out-dir benchmark/omnidocbench_gt
# → benchmark/omnidocbench_gt/omnidocbench_index.json + per-page *.json

# 2. Create stratified corpora (example: 200 accuracy + 30 timing, seed 42)
python -m benchmark.sampler \
  --index benchmark/omnidocbench_gt/omnidocbench_index.json \
  --images ./omnidocbench/images \
  --out-dir benchmark/sample \
  --accuracy-n 200 --timing-n 30 --min-per-stratum 3 --seed 42
# → benchmark/sample/accuracy_images/ (200) + timing_images/ (30) + sample_manifest.json

# 3. Run both systems on the SAME images (see Reproducibility above), then evaluate
python -m benchmark.evaluate \
  --js-dir benchmark/js_results --py-dir benchmark/py_results \
  --gt-dir benchmark/omnidocbench_gt --output benchmark/results.xlsx

# No GT? JS↔Python parity only (no download needed):
python -m benchmark.evaluate --js-dir benchmark/js_results --py-dir benchmark/py_results
```

> The published results in [`docs/evidence/`](./docs/evidence/) were produced with `N=350` stratified by `data_source × language` (seed 42). To reproduce the exact numbers, use `--accuracy-n 350 --timing-n 50` and reuse `docs/evidence/sample_manifest.json` if available. Full methodology, sample-size rationale, and per-stratum CIs: [benchmark/README.md](./benchmark/README.md).

---

## Project Context

DokuStruct explores whether a full Python document parsing pipeline can be brought to the browser with behavioral parity — including numerical parity of bounding-box geometry, WebGPU/WASM runtime equivalence, and empirical benchmarking against the Python baseline.

The port uses a systematic **PRESERVE / ADAPT / INTRODUCE** strategy for each module (see `docs/porting-decisions.md` and per-file `PORTING NOTE` headers) and is evaluated on three dimensions: port-fidelity, accuracy vs annotations, and processing time. Additional audit notes on providers, chunking levels, coordinate spaces, caches and lifecycle are in `docs/technical-insights.md`.

For implementation traceability, each `rapid_doc/` module has a `PORTING NOTE` header mapping to `python/rapid_doc/`.

---

## License

This project is a derivative of [MinerU](https://github.com/opendatalab/MinerU) and [RapidDoc](https://github.com/RapidAI/RapidDoc).
The original YOLO models (AGPL-licensed) have been removed and replaced with PP-StructureV3 series ONNX models.

Licensed under **Apache 2.0** — see [LICENSE](./LICENSE).

---

## Acknowledgments

- [MinerU](https://github.com/opendatalab/MinerU) — Original document parsing framework
- [RapidDoc](https://github.com/RapidAI/RapidDoc) — Python reference implementation
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) — Models (PP-StructureV3 series)
- [RapidOCR](https://github.com/RapidAI/RapidOCR) — OCR engine components
- [ONNX Runtime](https://github.com/microsoft/onnxruntime) — Cross-platform ML inference
