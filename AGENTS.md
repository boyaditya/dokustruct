# AGENTS.md — DokuStruct (RapidDoc-JS) Porting Overview

Proyek ini adalah **port JavaScript** dari [RapidDoc Python](https://github.com/RapidAI/RapidDoc) ke lingkungan browser — artefak thesis project. Rantai sumber: `MinerU (OpenDataLab) 2.6.4 → RapidDoc (RapidAI, Python) 0.9.4 → DokuStruct (ini, browser) 0.1.0`. Branding repo = **DokuStruct** (alias **RapidDoc-JS** di commit history).

---

## Ringkasan Porting

Seluruh `rapid_doc/` di porting file-per-file dari `python/rapid_doc/`. Kode Python yang menjadi referensi masih disertakan dalam repository sebagai `python/rapid_doc/` — bukan sebagai dependency, melainkan sebagai kanon untuk menjaga paritas perilaku. `python/` adalah **subset reproduksibel minimal** (272 files: `rapid_doc/` 267 + `demo/demo_batch.py` & `demo_run.py` 55 KB + `pyproject.toml` + `LICENSE`); demo images/docker/tests/chunker tidak dibawa.

Setiap file `.js` memiliki `PORTING NOTE` di header yang mendokumentasikan asal file `.py` dan keputusan adaptasi (PRESERVE / ADAPT / INTRODUCE — 14/30/5, lihat `docs/porting-decisions.md`). Satu file bisa multi-kategori.

### Konvensi Penamaan

- **Permukaan produk = DokuStruct**: judul halaman, branding UI, key storage/baru (`dokustruct_*`), logger default.
- **Engine internals = rapid_doc/rapiddoc**: folder modul `rapid_doc/`, plugin ESLint `rapiddoc/*`, globals `__RAPIDDOC_*`, key cache lama yang dibaca untuk migrasi.
- **Jangan rename** `rapiddoc_model_cache` (IndexedDB cache model 150MB — rename mengorbankan cache user) dan key legacy `rapiddoc_resume`/`RapidDocResume` (dibaca sebagai fallback migrasi di pipelineAdapter/app.js).

---

## Keputusan & Adaptasi Porting

### Runtime Inference

- **ONNX Runtime Web** sebagai pengganti ONNX Runtime Python. Model dijalankan via WASM (threaded) atau WebGPU.
- Konfigurasi execution provider (WebGPU vs WASM) setara dengan mekanisme `OrtInferSession` Python, diadaptasi ke pola `static async create(cfg)`.
- GPU mutex global (`acquireGlobalGpu()`) — ORT WebGPU tidak bisa menjalankan `session.run()` konkuren, berbeda dari Python yang thread-safe.
- Device lost recovery — mekanisme khusus browser yang tidak ada di Python.

### PDF Handling

- **pdf-lib** + **PDF.js** sebagai pengganti pypdfium2 (binding native C).
- `convertPdfBytesToBytesByPypdfium2` → slicing halaman via `PDFDocument.copyPages()`.
- `prepareEnv(outputDir)` → no-op; filesystem tidak ada di browser.
- `readFn(path)` → return `null`; input file dari File API.
- **Windowed processing** (`pdfPagesBatch`) — membagi PDF besar agar tidak OOM.

### Image Processing

- **OffscreenCanvas** + **OpenCV.js** sebagai pengganti PIL/Pillow + OpenCV Python.
- `pageToImage(page, dpi)` — konversi halaman PDF ke Canvas, bukan `PIL.Image`.
- `imageToBytes(canvas)` — Canvas → `Uint8Array`, bukan `PIL.Image.save()`.

### Data I/O

- `FileBasedDataWriter` → **MemoryDataWriter** (menyimpan output di Map in-memory, bukan filesystem).
- `FileBasedDataReader` → browser stub yang membaca dari array buffer.
- Tidak ada path operations; `path_utils.py` di-port sebagai no-op.

### Model & Assets

- **Asset manifest** (`model_url_map.js`) — ~30 entri ONNX model (layout, OCR, formula, table, orientation), di-download ke IndexedDB.
- Model disimpan di **HuggingFace CDN**, fallback ke `/models` lokal.
- `hashlib.sha256` → `SubtleCrypto.digest` untuk verifikasi integritas.
- `OmegaConf.load()` → `fetch` + `js-yaml` untuk loading konfigurasi.

### Environment & OS

- `os.getenv()` → hardcoded constants (tidak ada env vars di browser).
- `platform.system()` → `navigator.platform` untuk deteksi OS.
- Threading primitives (`threading.Lock()`) → stub object (single-threaded JS).

### Post-processing

- `deepcopy` → `structuredClone`.
- `yaml.safe_load` → `fetch` + YAML line parser manual (basic key:value).
- `importlib.import_module` → tidak relevan; ES module system menggantikan.

---

## Paritas Numerik

- **Banker's rounding** (`bankerRound` dari `math_utils.js`) menggantikan `Math.round()` untuk koordinat bounding box — menyamai perilaku `int()` Python.
- ESLint **custom rule** `no-math-round-bbox` melarang `Math.round()` di file bbox-heavy (post_process, pre_process, xycut, layout, dll).
- Semua operasi geometri box di-port dengan preservasi presisi.

---

## Arsitektur Pipeline

Pipeline mengikuti pola yang sama dengan Python:

```
PDF → page slicing → layout detection (PP-DocLayout)
                     → OCR (PP-OCRv5: det + rec)
                     → formula detection (PP-FormulaNet Plus)
                     → table recognition (SLANet-Plus + UNet)
                     → reading order (XY-cut)
                     → orientation classification
                     → content assembly → markdown output
```

**Singleton pattern** (`ModelSingleton`) — semua model di-cache per konfigurasi, setara dengan Python `ModelSingleton._models` dict.

Ekstra JS:
- `yieldToBrowser()` — cooperative yielding agar UI tetap responsif.
- `engineReset()` — flush GPU memory penuh antar run (WebGPU VRAM management).

---

## Relations dengan Python Reference

| Aspek | Python (baseline) | JS (DokuStruct) |
|---|---|---|
| Runtime | CPython + ORT | ORT Web (WASM/WebGPU) |
| PDF parsing | pypdfium2 | pdf-lib + PDF.js |
| Image | PIL + OpenCV | OffscreenCanvas + OpenCV.js |
| File I/O | Filesystem | File API + IndexedDB cache |
| GPU EP | DirectML (layout/OCR) / CPU (formula/table) | WebGPU (layout/OCR) / WASM (formula/table) |
| Config | YAML files | JS objects + global injection |
| CLI | Full filesystem CLI | No-op stubs |
| Versi | `0.9.4` | `0.1.0` (port of 0.9.4) |
| MinerU base | `2.6.4` | `2.6.4` |
| OmniDocBench | **v1.6** (1651 hal) | **v1.6** — eval N=350/50, seed 42 |
| Tested env | Win10 / i5-4690 + RX 580 | Chrome 148, ORT Web 1.24.3 vs DirectML 1.24.4, OpenCV.js 4.10.0 |

---

## Benchmarking & Validasi

- **OmniDocBench v1.6** (1651 hal) sebagai ground truth.
- **3 dimensi terpisah**:
  - **Port-fidelity** (JS vs Py direct): Coverage F1 **0.9528**, TEDS-Struct **0.9504**, IoU **0.9021**, Kendall τ **0.9428** (N=350)
  - **Accuracy vs annotations**: Proxy composite **71.6933 (JS) vs 74.2855 (Py)** Δ -2.59 CI [-3.94;-1.28] p 8e-06 (Holm) — Formula & TEDS ns — **proxy = normalized LaTeX edit, bukan CDM, ≠ official Overall**
  - **Time**: **7.5785 s (JS) vs 3.8105 s (Py)** mean, georatio **1.804 CI [1.645;1.998]** (N=50, 3 warm-up +10 runs) — formula bottleneck R2.44, CV 1.02% vs 2.27% stabil
- `benchmark/` berisi framework evaluasi lengkap dengan 4-sheet Excel output dan metodologi statistik (geometric mean, bootstrap 5000 seed 42, Wilcoxon paired + rank-biserial, Holm-Bonferroni per family).
- Workbook + `sample_manifest.json` (seed 42, stratified source×language min 3) diarsip di `docs/evidence/`.

---

## Catatan untuk Agent

Saat bekerja di codebase ini:

1. **Cari `PORTING NOTE`** — setiap file `.js` di `rapid_doc/` mungkin memiliki catatan porting di header, JSDoc, atau inline (PRESERVE/ADAPT/INTRODUCE, lihat `docs/porting-decisions.md`).
2. **Python reference ada di `python/rapid_doc/`** — jika ragu dengan logika JS, cek file `.py` yang bersesuaian. **Jangan ubah** — itu kanon v0.9.4; perubahan hanya di JS (patch graf JS-only ADP-26).
3. **Branding = DokuStruct**, repo = DokuStruct / RapidDoc-JS alias — jangan rename `rapiddoc_model_cache` (IndexedDB 150 MB) dan key legacy `rapiddoc_resume`/`RapidDocResume` (fallback migrasi).
4. **Koordinat bounding box** — selalu gunakan `bankerRound`/`intTrunc`, jangan `Math.round()` (ADP-28/29: banker's rounding, Math.trunc untuk `int()`).
5. **GPU state** — `ModelSingleton` dan ort_runtime.js mengelola shared WebGPU device; perhatikan `deviceLost` flag dan GPU mutex (INT-04).
6. **Benchmark** — OmniDocBench **v1.6**, N=350/50 seed 42, proxy composite ≠ official Overall; lihat `README.md` Benchmark & `benchmark/README.md`.
7. **File ini adalah ringkasan porting** — untuk detail teknis implementasi, lihat kode sumber dan `PORTING NOTE` masing-masing file.
