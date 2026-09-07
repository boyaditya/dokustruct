# AGENTS.md — DokuStruct

DokuStruct is a JavaScript port of RapidDoc (Python) to the browser. This is a Computer Science thesis artifact. Source chain: MinerU 2.6.4 → RapidDoc 0.9.4 → DokuStruct 0.1.0. Repository name is DokuStruct, legacy alias RapidDoc-JS.

## Repository structure

```
rapid_doc/        JS port, 188 files. Each file has a PORTING NOTE header.
python/rapid_doc/ Python reference, canonical. Do not modify. Minimal subset 267 files.
ui/               Vanilla JS single-page app, 24 files. App on top, docs below.
benchmark/        Evaluation, 4-sheet Excel workbook and stats.
docs/             porting-decisions.md, technical-insights.md, evidence/
public/           Static assets (opencv.wasm, samples).
tests/            Vitest suite, 240 tests.
tooling/          ESLint rules, including no-math-round-bbox.
```

One JS file can belong to multiple porting categories. Counts: PRESERVE 14, ADAPT 30, INTRODUCE 5. See `docs/porting-decisions.md`.

## Branding and storage

* Product surface uses DokuStruct: title, UI, new keys `dokustruct_*`.
* Engine uses `rapid_doc` and `rapiddoc`: folder, ESLint `rapiddoc/*`, globals `__RAPIDDOC_*`.
* Do not rename `rapiddoc_model_cache` (IndexedDB, ~150 MB, core ~285 MB, with formulas ~550 MB) and `rapiddoc_resume` / `RapidDocResume` (fallback migration in `pipelineAdapter` and `app.js`).

## What was ported and what changed

**Runtime**
ONNX Runtime Python → ONNX Runtime Web. WASM (threaded) or WebGPU. `OrtInferSession` → `static async create(cfg)`. WebGPU requires a global mutex `acquireGlobalGpu()` because `session.run()` is not concurrent. Includes `device lost` recovery specific to browsers.

**PDF**
pypdfium2 → pdf-lib + PDF.js. `convertPdfBytesToBytesByPypdfium2` becomes `PDFDocument.copyPages()`. `prepareEnv` is no-op. `readFn(path)` returns null; input comes from File API. Large PDFs are windowed via `pdfPagesBatch` to avoid OOM. `pdf-lib` page slicing pre-splits chunks to avoid repeated full-document parses.

**Image**
PIL + OpenCV Python → OffscreenCanvas + OpenCV.js (4.10). `pageToImage` → Canvas, `imageToBytes` → Uint8Array. `createImageBitmap` + `OffscreenCanvas` for image-to-PDF conversion.

**I/O**
`FileBasedDataWriter` → `MemoryDataWriter` (in-memory Map). `FileBasedDataReader` stub reads from buffer. `path_utils.py` is no-op.

**Models and assets**
Manifest `rapid_doc/utils/model_url_map.js` (~30 ONNX models, 24 with sha256). Downloads to IndexedDB, Hugging Face CDN with `/models` fallback. `hashlib.sha256` → `SubtleCrypto.digest` (verified before cache write on both `DownloadFile` and UI hot paths). `OmegaConf.load()` → `fetch` + `js-yaml` + manual line parser.

**OS and environment**
`os.getenv()` → constants. `platform.system()` → `navigator.platform`. `threading.Lock()` → stub. `argparse` CLI → no-op stubs. Office path (`backend/office`, `model/docx/pptx/xlsx`) not ported.

**Post-processing**
`deepcopy` → `structuredClone`. `yaml.safe_load` → manual parser. `importlib` → ES modules.

## Numeric parity

Box coordinates use `bankerRound` and `intTrunc` from `rapid_doc/utils/math_utils.js`, not `Math.round()`. `Math.round()` is half-up; Python `int()` truncates toward zero and `round()` is half-even. ESLint rule `no-math-round-bbox` forbids `Math.round()` in bbox files. `BigInt64Array` → `Float64` conversion is explicit (JS BigInt limitation).

## Pipeline

```
PDF -> slicing -> layout PP-DocLayout (V2/V3/Plus-L)
                 -> OCR PP-OCRv5 det + rec
                 -> formula PP-FormulaNet Plus S/M
                 -> table SLANet-Plus + UNet
                 -> reading order XY-cut (enhanced)
                 -> orientation (0/90/180/270)
                 -> Markdown / Content List / Middle JSON
```

All models are cached per config via `ModelSingleton` / `AtomModelSingleton`, mirroring `ModelSingleton._models` in Python. Shared GPU mutex serializes WebGPU runs. Cached asset bytes survive `engineReset()`; in-memory sessions and LRU `memoryCache` (~500 MB cap, 12 entries) do not.

Browser additions: `yieldToBrowser()` (scheduler.yield → MessageChannel → setTimeout) keeps UI responsive, `engineReset()` flushes WebGPU VRAM and revokes object URLs.

Three chunking levels:
* **L1 adapter chunk** (8 pages, `pipelineAdapter`, browser-only, `engineReset` between chunks)
* **L2 engine window** (`PDF_PAGES_BATCH` 4 WASM / 2 WebGPU)
* **L3 stage batch** (`layout 4/1`, `det 4/1`, `rec 4-6`, `formula 1-2`)

Three coordinate spaces: rendered pixels (model output), PDF points (`pdf_info` / `page_size`), per-mille 0–1000 (`content_list` via `unionMake`).

## Python reference vs JS

| Aspect | Python 0.9.4 | JS 0.1.0 |
|---|---|---|
| Runtime | CPython + ORT 1.24.4 | ORT Web 1.24.3 WASM/WebGPU |
| PDF | pypdfium2 | pdf-lib + PDF.js 4.5 |
| Image | PIL + OpenCV | Canvas + OpenCV.js 4.10 |
| I/O | filesystem | File API + IndexedDB |
| GPU | DirectML layout/OCR, CPU formula/table | WebGPU layout/OCR, WASM formula/table |
| Config | YAML | JS object |
| CLI | full | stub |
| MinerU | 2.6.4 | 2.6.4 |
| OmniDocBench | v1.6 1651 pages | v1.6 N=350/50 seed 42 |
| Tested | Win10 i5-4690 + RX 580, DirectML | Chrome 148, ORT Web 1.24.3, OpenCV.js 4.10 |

## Benchmark

OmniDocBench v1.6 ground truth, `data_source × language` stratified, seed 42, min 3/stratum, largest-remainder. Three separate tracks:

* **Port fidelity JS vs Py (N=350, Py as baseline, not GT):** Coverage F1 0.9528, Type consistency 0.9971, Text similarity 0.8814, Formula similarity 0.8888, TEDS 0.9069 / TEDS-Struct 0.9504, BBox IoU 0.9021, Kendall tau 0.9428.
* **Accuracy vs annotation (N=348, proxy composite, not official Overall CDM):** JS 71.69 vs Py 74.29, diff -2.59 CI [-3.94, -1.28] p 8e-06. Proxy = normalized LaTeX edit + Text Edit + TEDS. Formula and TEDS differences ns.
* **Timing (N=50, 3 warmup +10 runs, geomean):** 7.58 s JS vs 3.81 s Py, geo ratio 1.80 CI [1.645, 1.998], CV 1.02% vs 2.27%. Formula is bottleneck (2.44×).

Framework in `benchmark/` with 4-sheet Excel, bootstrap 5000 seed 42, Wilcoxon paired + Holm, rank-biserial. Workbook and `sample_manifest.json` concept archived in `docs/evidence/` (stratification proof CSV, paired per-doc CSV, per-layout CSVs).

See `benchmark/README.md` for prerequisites, GT mode, sampler, and sample-size notes, and `docs/evidence/README.md` for file map.

## UI (current)

* **Single page:** `has-below` + `below-app`. App `100vh` on top, docs below. `vercel.json` and `vite.config` set `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` for `SharedArrayBuffer`.
* **Layout:** Sidebar `276px` (collapsible to `60px`), main `minmax(0,1fr) + 300px` settings pane on desktop, single column on `≤900px`. Header without eyebrow, footer `DokuStruct 0.1.0 · RapidDoc 0.9.4`.
* **Dropzone:** `min 140px`, dashed `1.5px var(--border-strong)`, `18px` radius, centered. File card is single-file horizontal: `44×44` thumb, `13px` name (ellipsis) + `11px` size, `28px` eye preview icon, `22px` remove `x` (hover). Sample gallery below dropzone.
* **Sample gallery:** 4 cards, native minimal style (no gradients). `01-formula.png` (Formula, Math → LaTeX, formula on / table off, ~234 MB), `02-table.jpg` (Table, wired + structure, table on, ~40 MB), `03-book-scan.pdf` (Book scan, PDF 8 pages, both off), `04-mixed.png` (Mixed, text + formula + table, both on, ~274 MB). Auto-enables the required model via `SAMPLE_PRESETS` and shows English toast with size; `pane-hint` (`about this project`) is blue `var(--primary)` pill inside `setup-input-pane`.
* **History:** `History` header with count pill. Each item `32×32` icon, `12.5px` name, `11px` meta, badges `9px` pill (`Formula`/`Table`) with `var(--panel)` bg, `16px` height, `max 50%` each, `nowrap` → uniform `64px` card, `hover` shows `22px` delete. No extra height when badges wrap.
* **Toast / loading indicator:** White card `var(--white)`, `1px var(--border-light)`, `8px` radius, `12.5px 500`, `shadow 0 6px 20px`, centered bottom `18px`, no dark backdrop, no dot, no left border. Complements blue `pane-hint`.
* **Settings pane:** `300px`, `dokustruct_*` keys, toggles for Formula/Table, advanced selects for OCR/layout/formula/table models and execution provider. `asset-gate` shows `rapiddoc_model_cache` status.
* **Viewer:** `viewer-pane` + `markdown-pane` split with `9px` handle, `40px` toolbar rows, timing strip, `page-stack` with `layout-overlay` and merge connectors.

## Notes for agents

1. Look for `PORTING NOTE` in each `.js` before changing logic. When in doubt, check the same `.py` in `python/rapid_doc/`. Do not modify Python; it is canonical.
2. DokuStruct branding, but do not rename legacy cache and resume keys.
3. Boxes use `bankerRound`/`intTrunc`, not `Math.round()`.
4. GPU: `ModelSingleton` + `ort_runtime.js` share a device; check `deviceLost` and global mutex. `engineReset()` is the only way to return pooled WebGPU buffers.
5. Benchmark is v1.6, proxy is not official Overall; CDM proxy is normalized LaTeX edit distance.
6. UI is single page: `has-below` + `below-app`, app `100vh`, docs below. Sample gallery auto-enables models; history badges are part of card contract.
7. This file is a summary. Details are in code and per-file `PORTING NOTE`.
