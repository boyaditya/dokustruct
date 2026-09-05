# DokuStruct

![version](https://img.shields.io/badge/version-0.1.0-blue) ![python](https://img.shields.io/badge/python-0.9.4-green) ![mineru](https://img.shields.io/badge/mineru-2.6.4-lightgrey) ![license](https://img.shields.io/badge/license-Apache--2.0-blue) ![tests](https://img.shields.io/badge/tests-240%20passing-brightgreen)

DokuStruct runs document extraction in your browser. Drop a PDF and get Markdown and JSON. Text, tables and math are found on your device. Nothing is uploaded.

It is a direct port of [RapidDoc](https://github.com/RapidAI/RapidDoc) (from [MinerU](https://github.com/opendatalab/MinerU)) to JavaScript. All parsing runs locally with ONNX Runtime Web.

This is my Computer Science thesis. I kept the Python as a reference and rewrote `rapid_doc` file by file so behavior stays the same. Each JS file has a short note at the top.

Thesis: Implementasi dan Evaluasi Pipeline Document Image Parsing Berbasis Browser-Local. S1 Ilmu Komputer, Universitas Pendidikan Indonesia, 2026. Boy Aditya Rohmaulana 2203488.

## Why

Many documents are still scanned PDFs with tables, math and multi-column layout. Linear text extraction loses the structure. Server side needs upload and network. Native local needs install and setup. I wanted to see if the full pipeline can run where the file already is, in the browser, using WebAssembly, WebGPU and ONNX Runtime Web, then measure how close it stays to the Python version.

This repo is the artifact and the measurement.

## What it does

* OCR with PP-OCRv5. Reads text and keeps order.
* Layout with PP-DocLayout V2, V3 and Plus L.
* Math as LaTeX with PP-FormulaNet Plus S and M.
* Tables with SLANet-Plus and UNet.
* Orientation fix, batch files, and export to Markdown and JSON.
* Works offline after the first model download.

## Demo

[Open the app](https://dokustruct.vercel.app)

![demo](samples/02-layout.png)

Models are cached in IndexedDB after first load. Core is about 285 MB. With formulas it is about 550 MB. Next loads start from cache.

---

## Quick start

```bash
git clone https://github.com/boyaditya/dokustruct.git
cd dokustruct
npm install
npm run dev
# http://localhost:5173
```

Build and preview:

```bash
npm run build
npm run preview
```

Tests and lint:

```bash
npm test
npm run lint
```

---

## How it works

```
PDF or image
  -> page slicing
  -> layout
  -> OCR
  -> formula and table
  -> reading order
  -> Markdown
```

Large PDFs are split into small windows. The app yields between windows so the UI stays responsive. WebGPU is used when available, otherwise WASM.

```
rapid_doc/        # JS port, 187 files
  backend/pipeline/  # pipeline and batching
  model/             # OCR, layout, formula, table
  utils/             # PDF, image, geometry helpers
  index.js

ui/               # app, vanilla JS
  app.js
  state/ render/ linking/ history/

python/           # small reference copy, 272 files
  rapid_doc/      # same shape as JS
  demo/           # bench runners

benchmark/        # scoring and sampling
tests/            # 240 tests
```

Each module in `rapid_doc` has a matching file in `python/rapid_doc` with the same interface. The header in each JS file says what stayed, what changed for the browser, and what is new.

More notes: `docs/porting-decisions.md` and `docs/technical-insights.md`.

### Scope

Built and tested as a thesis artifact, not a product:

* Pipeline covers orientation, layout, OCR, formula, table, reading order and Markdown. No new models, weights or datasets.
* RapidDoc 0.9.4 is the baseline. Python is not treated as ground truth, OmniDocBench is.
* Same raster images for both systems. Corpus is 350 pages for output and 50 for timing.
* Proxy metrics where official OmniDocBench evaluators need TeX Live. Time is a deployment comparison, not a language claim.
* Tested on one device, one OS and one browser. No usability or security audit.

### Using it as a library

```js
import { docAnalyze } from './rapid_doc/index.js';

const pdfBytes = await file.arrayBuffer();
const { markdown, contentList } = await docAnalyze(pdfBytes, {
  formula_enable: true,
  table_enable: true,
});
```

### Browser notes

Chrome 121+ with WebGPU is fastest. Firefox and Safari fall back to WASM. Large PDFs may be heavy on mobile. The app needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` for `SharedArrayBuffer`. See `vercel.json`.

### Limits

Not a new model. Same pretrained weights as Python, so accuracy is close but not identical. Speed is slower in the browser, most on formulas and tables. Very large or scanned low-res PDFs can miss layout.

---

## Tech stack

ONNX Runtime Web 1.24.3 with WASM and WebGPU. PDF.js 4.5 and pdf-lib. KaTeX 0.16 and Marked 14. OpenCV.js 4.10. Vite 7 and Vitest 4.

---

## Benchmark

Tested on OmniDocBench v1.6, 1651 pages. I sampled 350 pages for output and 50 for timing, seed 42, stratified by source and language.

Port fidelity, JS vs Python, N=350:

| Metric | Mean | Median | N |
| :--- | :--- | :--- | :--- |
| Coverage F1 | 0.9528 | 1.0000 | 350 |
| Type consistency | 0.9971 | 1.0000 | 350 |
| Text similarity | 0.8814 | 1.0000 | 344 |
| Formula similarity | 0.8888 | 1.0000 | 67 |
| TEDS / TEDS-Struct | 0.9069 / 0.9504 | 1.0000 | 105 |
| BBox IoU | 0.9021 | 0.9626 | 349 |
| Kendall tau | 0.9428 | 1.0000 | 332 |

Accuracy vs OmniDocBench, proxy composite, N=348:

| Metric | JS | Python | diff |
| :--- | :--- | :--- | :--- |
| Proxy composite | 71.69 | 74.29 | -2.59 |
| Text Edit | 0.268 | 0.238 | +0.030 |
| Formula Edit | 0.454 | 0.440 | ns |
| Table TEDS | 0.728 | 0.739 | ns |

Time, N=50, mean:

|  | JS | Python | ratio |
| :--- | :--- | :--- | :--- |
| Total | 7.58s | 3.81s | 1.80x |

Formula is the slowest part. Details and the full workbook are in `docs/evidence` and `benchmark/README.md`. Formula score is normalized LaTeX edit distance, not official CDM.

The three evaluations are separate: port fidelity to Python, accuracy to OmniDocBench, and time on the same device. High fidelity does not automatically mean high accuracy.

### Reproduce

`python/` is a small copy, about 3 MB, enough to run the benchmark.

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -e ./python
pip install -r benchmark/requirements.txt
python -c "import rapid_doc; print(rapid_doc.__version__)"
```

The two runners are `python/demo/demo_batch.py` and `demo_run.py`.

```bash
PYTHONPATH=python python -m demo.demo_batch --pdfs path/to/pdfs --repeat 10 --warmup 2 --formula --table
node benchmark/js_supervised_runner.mjs --help
```

To get OmniDocBench, download from Hugging Face `opendatalab/OmniDocBench` or OpenDataLab. About 1.6 GB. Then:

```bash
python -m benchmark.omnidocbench --gt-json ./omnidocbench/OmniDocBench.json --out-dir benchmark/omnidocbench_gt
python -m benchmark.sampler --index benchmark/omnidocbench_gt/omnidocbench_index.json --images ./omnidocbench/images --out-dir benchmark/sample --accuracy-n 200 --timing-n 30 --seed 42
python -m benchmark.evaluate --js-dir benchmark/js_results --py-dir benchmark/py_results --gt-dir benchmark/omnidocbench_gt --output benchmark/results.xlsx
```

Full steps and sample size notes are in `benchmark/README.md`.

---

## License

Derivative of MinerU and RapidDoc. AGPL YOLO models were replaced with PP-StructureV3 ONNX models.

Apache 2.0, see `LICENSE`.

## Credits

MinerU, RapidDoc, PaddleOCR, RapidOCR, ONNX Runtime. Built solo for my Computer Science thesis. If it helps, star it. If it breaks, open an issue.
