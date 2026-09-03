# Porting Decisions — PRESERVE / ADAPT / INTRODUCE

> Setiap `rapid_doc/*.js` memiliki `PORTING NOTE` header dengan asal `python/rapid_doc/*.py`. Satu file/komponen bisa multi-kategori.

Keputusan porting lintas runtime (Python native-local → browser-local) diklasifikasikan sebagai:

- **PRESERVE** — tujuan & mekanisme inti dipertahankan (algoritma / param / kontrak tanpa perubahan substantif)
- **ADAPT** — tujuan tetap, mekanisme berubah (API / pustaka / representasi / graf / provider)
- **INTRODUCE** — mekanisme baru tanpa padanan baseline (cache, mutex, windowed, lifecycle)

---

## PRESERVE — 14 keputusan

| ID | Keputusan | Catatan |
|----|-----------|---------|
| PRS-01 | Orientasi klasifikasi 0/90/180/270 | Threshold & label dipertahankan |
| PRS-02 | Layout detection PP-DocLayout V2 (Plus-L optional) | Arsitektur & NMS dipertahankan |
| PRS-03 | OCR det/rec split (PP-OCRv5) | Dua model terpisah dipertahankan |
| PRS-04 | Formula PP-FormulaNet Plus-S | Tokenizer & post-proc dipertahankan |
| PRS-05 | Tabel SLANet-Plus + UNet hybrid | Hybrid pipeline dipertahankan |
| PRS-06 | Reading order XY-Cut | Algoritma & heuristik dipertahankan |
| PRS-07 | Middle JSON hierarki (`pdf_info` per page) | Struktur nested dipertahankan |
| PRS-08 | Paragraph merge (`para_split`) | Aturan gap & merge dipertahankan |
| PRS-09 | Box geometry (x0,y0,x1,y1) | Semantik koordinat dipertahankan (ADP-28/29 untuk numerik) |
| PRS-10 | Confidence & type taxonomy | Taksonomi layout dipertahankan |
| PRS-11 | **Content List sebagai kontrak evaluator** | Kontrak output evaluator dipertahankan |
| PRS-12 | ModelSingleton cache semantics | Cache per-config dipertahankan (JS: IndexedDB, Py: dict) |
| PRS-13 | Pipeline stage order | Urutan inferensi dipertahankan |
| PRS-14 | Error handling (skip empty, warn) | Semantik warn/skip dipertahankan |

*Batas: sumber config disesuaikan, batching = detail runtime (bukan PRESERVE murni).*

---

## ADAPT — 30 keputusan (kelompok terbesar)

| ID | Area | Python → JS |
|----|------|-------------|
| ADP-02 | Path | `Path` / `os.path` → `File` API (no filesystem) |
| ADP-03 | DataWriter | `FileBasedDataWriter` → `MemoryDataWriter` (Map in-memory) |
| ADP-04 | PDF | `pypdfium2` / `pymupdf` → `pdf-lib` + `PDF.js` (`PDFDocument.copyPages`, `getDocument`) |
| ADP-05 | Image | `PIL` / `cv2` → `OffscreenCanvas` + `OpenCV.js`; RGBA→BGR konversi |
| ADP-06 | DataReader | `FileBasedDataReader` → browser stub `ArrayBuffer` |
| ADP-07 | Config load | `OmegaConf.load(YAML)` → `fetch` + `js-yaml` + line parser |
| ADP-08 | Hash | `hashlib.sha256` → `SubtleCrypto.digest` |
| ADP-09 | Deepcopy | `copy.deepcopy` → `structuredClone` |
| ADP-10 | YAML | `yaml.safe_load` → manual key:value parser |
| ADP-11 | Import | `importlib.import_module` → ES modules |
| ADP-12 | Layout EP | DirectML (Py) → **WebGPU** (JS) |
| ADP-13 | OCR EP | DirectML (Py, `EngineConfig.onnxruntime.use_dml`) → **WebGPU** (JS, `use_webgpu`) |
| ADP-14 | Formula/Table EP | CPU (Py) → **WASM** (JS, `Loop` autoregressive, hardcoded CPU) |
| ADP-15 | Batching | `pdf_pages_batch=64` → **windowed processing** + akumulasi per window (`tmp_start_page_id`, `pdf_info.extend`) |
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
| **ADP-26** | **Graf patch** | **PP-DocLayout & SLANet Plus operator & tensor shape disesuaikan** — patch retains fidelity |
| ADP-27 | Preprocess | `Normalize` / `Resize` → Canvas ops |
| ADP-28 | Rounding | `Math.round` dilarang → `bankerRound` (ESLint `no-math-round-bbox`) |
| ADP-29 | Trunc | `int()` → `intTrunc` |
| ADP-30 | Draw bbox | `draw_layout_bbox` PIL → Canvas |

---

## INTRODUCE — 5 keputusan (browser-only)

| ID | Mekanisme | Alasan |
|----|-----------|--------|
| INT-01 | Asset manifest (`model_url_map.js` ~30 entri) | Browser butuh URL + integrity manifest |
| INT-02 | IndexedDB cache (`rapiddoc_model_cache`, 150 MB) | Persist model antar sesi (Py: dict memory) |
| INT-03 | Chunking adapter (sub-PDF windowed) | Hindari OOM browser untuk dokumen panjang |
| INT-04 | Shared GPU mutex (`acquireGlobalGpu()`) | ORT WebGPU tidak thread-safe |
| INT-05 | Explicit cleanup (`cv.Mat.delete()`, `tensor.dispose()`) | VRAM/GPU lifecycle browser |

Plus: `yieldToBrowser()` cooperative yielding, `engineReset()` flush VRAM, device-lost recovery.

---

## Batas Tidak Dipindahkan

> **Bukan kegagalan porting** — komponen upstream yang tidak relevan untuk browser-local DIP:

- `backend/office` (DOCX/PPTX/XLSX converter via `office_analyze`)
- `model/docx`, `model/pptx`, `model/xlsx` converters
- `data/data_reader_writer` S3 / HTTP reader
- `model/custom/paddleocr_vl` (VL custom)
- `utils` office-specific (`office_converter`, S3)
- Rendering stempel & beberapa post-proc office

Alasan: pipeline `Content List` sebagai kontrak sudah mencakup keluaran terstruktur yang dievaluasi; office path tidak diuji di OmniDocBench.

---

## Traceability

- Setiap `rapid_doc/**/*.js` header `PORTING NOTE` menyebut ID PRS/ADP/INT & file `.py` asal.
- Perubahan graf (ADP-26) terdokumentasi di `rapid_doc/model/layout/...` & `table/...` patch notes.
- Numerik: `bankerRound`/`intTrunc` di `rapid_doc/utils/math_utils.js` + ESLint rule `tooling/no-math-round-bbox.js`.

*Fidelity tinggi tidak menjamin akurasi/waktu yang setara — gap di layout “lainnya”, formula bottleneck R2.44.*
