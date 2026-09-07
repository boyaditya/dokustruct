# Porting Decisions — PRESERVE / ADAPT / INTRODUCE

> Every `rapid_doc/*.js` has a `PORTING NOTE` header citing the origin `python/rapid_doc/*.py`. One file/component can belong to multiple categories.

Porting decisions across runtime (Python native-local → browser-local) are classified as:

- **PRESERVE** — core intent and mechanism preserved (algorithm / params / contract without substantive change)
- **ADAPT** — intent preserved, mechanism changed (API / library / representation / graph / provider)
- **INTRODUCE** — new mechanism with no baseline counterpart (cache, mutex, windowed, lifecycle)

---

## PRESERVE — 14 decisions

| ID | Decision | Note |
|----|----------|------|
| PRS-01 | Orientation classification 0/90/180/270 | Threshold and labels preserved |
| PRS-02 | Layout detection PP-DocLayout V2 (Plus-L optional) | Architecture and NMS preserved |
| PRS-03 | OCR det/rec split (PP-OCRv5) | Two separate models preserved |
| PRS-04 | Formula PP-FormulaNet Plus-S | Tokenizer and post-processing preserved |
| PRS-05 | Table SLANet-Plus + UNet hybrid | Hybrid pipeline preserved |
| PRS-06 | Reading order XY-Cut | Algorithm and heuristics preserved |
| PRS-07 | Middle JSON hierarchy (`pdf_info` per page) | Nested structure preserved |
| PRS-08 | Paragraph merge (`para_split`) | Gap and merge rules preserved |
| PRS-09 | Box geometry (x0,y0,x1,y1) | Coordinate semantics preserved (ADP-28/29 for numerics) |
| PRS-10 | Confidence and type taxonomy | Layout taxonomy preserved |
| PRS-11 | **Content List as evaluator contract** | Evaluator output contract preserved |
| PRS-12 | ModelSingleton cache semantics | Per-config cache preserved (JS: IndexedDB, Py: dict) |
| PRS-13 | Pipeline stage order | Inference order preserved |
| PRS-14 | Error handling (skip empty, warn) | Warn/skip semantics preserved |

*Boundary: config source adapted, batching is runtime detail (not pure PRESERVE).*

---

## ADAPT — 30 decisions (largest group)

| ID | Area | Python → JS |
|----|------|-------------|
| ADP-02 | Path | `Path` / `os.path` → `File` API (no filesystem) |
| ADP-03 | DataWriter | `FileBasedDataWriter` → `MemoryDataWriter` (in-memory Map) |
| ADP-04 | PDF | `pypdfium2` / `pymupdf` → `pdf-lib` + `PDF.js` (`PDFDocument.copyPages`, `getDocument`) |
| ADP-05 | Image | `PIL` / `cv2` → `OffscreenCanvas` + `OpenCV.js`; RGBA→BGR conversion |
| ADP-06 | DataReader | `FileBasedDataReader` → browser stub `ArrayBuffer` |
| ADP-07 | Config load | `OmegaConf.load(YAML)` → `fetch` + `js-yaml` + line parser |
| ADP-08 | Hash | `hashlib.sha256` → `SubtleCrypto.digest` |
| ADP-09 | Deepcopy | `copy.deepcopy` → `structuredClone` |
| ADP-10 | YAML | `yaml.safe_load` → manual key:value parser |
| ADP-11 | Import | `importlib.import_module` → ES modules |
| ADP-12 | Layout EP | DirectML (Py) → **WebGPU** (JS) |
| ADP-13 | OCR EP | DirectML (Py, `EngineConfig.onnxruntime.use_dml`) → **WebGPU** (JS, `use_webgpu`) |
| ADP-14 | Formula/Table EP | CPU (Py) → **WASM** (JS, `Loop` autoregressive, hardcoded CPU) |
| ADP-15 | Batching | `pdf_pages_batch=64` → **windowed processing** + per-window accumulation (`tmp_start_page_id`, `pdf_info.extend`) |
| ADP-16 | Env | `os.getenv` → hardcoded constants |
| ADP-17 | Platform | `platform.system()` → `navigator.platform` |
| ADP-18 | Threading | `threading.Lock` → stub (single-threaded) |
| ADP-19 | CLI | `argparse` filesystem CLI → no-op stubs |
| ADP-20 | Office | `office_analyze` → not ported (out of scope) |
| ADP-21 | Asset path | `RAPID_MODELS_DIR` → `model_url_map.js` manifest + IndexedDB |
| ADP-22 | Model URL | HF CDN + fallback `/models` |
| ADP-23 | Math round | `round()` half-even → `bankerRound` (ADP-28) |
| ADP-24 | Int trunc | `int()` trunc toward zero → `Math.trunc` / `intTrunc` (ADP-29) |
| ADP-25 | BigInt | `int64` tensor → `Float64` (JS BigInt64Array limitation, ADP-25) |
| **ADP-26** | **Graph patch** | **PP-DocLayout & SLANet Plus operator & tensor shape adjustments** — patch retains fidelity |
| ADP-27 | Preprocess | `Normalize` / `Resize` → Canvas ops |
| ADP-28 | Rounding | `Math.round` forbidden → `bankerRound` (ESLint `no-math-round-bbox`) |
| ADP-29 | Trunc | `int()` → `intTrunc` |
| ADP-30 | Draw bbox | `draw_layout_bbox` PIL → Canvas |

---

## INTRODUCE — 5 decisions (browser-only)

| ID | Mechanism | Reason |
|----|-----------|--------|
| INT-01 | Asset manifest (`model_url_map.js` ~30 entries) | Browser needs URL + integrity manifest |
| INT-02 | IndexedDB cache (`rapiddoc_model_cache`, 150 MB) | Persist models across sessions (Py: in-memory dict) |
| INT-03 | Chunking adapter (sub-PDF windowed) | Avoid browser OOM for long documents |
| INT-04 | Shared GPU mutex (`acquireGlobalGpu()`) | ORT WebGPU is not thread-safe |
| INT-05 | Explicit cleanup (`cv.Mat.delete()`, `tensor.dispose()`) | VRAM/GPU lifecycle in browser |

Plus: `yieldToBrowser()` cooperative yielding, `engineReset()` VRAM flush, device-lost recovery.

---

## Out of Scope

> **Not a porting failure** — upstream components irrelevant for browser-local document image parsing:

- `backend/office` (DOCX/PPTX/XLSX converter via `office_analyze`)
- `model/docx`, `model/pptx`, `model/xlsx` converters
- `data/data_reader_writer` S3 / HTTP reader
- `model/custom/paddleocr_vl` (VL custom)
- `utils` office-specific (`office_converter`, S3)
- Stamp rendering and some office post-processing

Reason: `Content List` pipeline contract already covers the structured output evaluated; office path is not tested on OmniDocBench.

---

## Traceability

- Every `rapid_doc/**/*.js` header `PORTING NOTE` cites PRS/ADP/INT IDs and origin `.py` file.
- Graph changes (ADP-26) documented in `rapid_doc/model/layout/...` and `table/...` patch notes.
- Numerics: `bankerRound`/`intTrunc` in `rapid_doc/utils/math_utils.js` + ESLint rule `tooling/no-math-round-bbox.js`.

*High fidelity does not guarantee equivalent accuracy or timing — gap in "other" layout, formula bottleneck ~2.44×.*
