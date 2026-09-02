# AGENTS.md — DokuStruct (RapidDoc-JS Porting Overview)

Proyek ini adalah **port JavaScript** dari [RapidDoc Python](https://github.com/RapidAI/RapidDoc) ke lingkungan browser. Rantai sumber: `MinerU (OpenDataLab) → RapidDoc (RapidAI, Python) → DokuStruct (ini, browser)`.

---

## Ringkasan Porting

Seluruh `rapid_doc/` di porting file-per-file dari `python/rapid_doc/`. Kode Python yang menjadi referensi masih disertakan dalam repository sebagai `python/rapid_doc/` — bukan sebagai dependency, melainkan sebagai kanon untuk menjaga paritas perilaku. Hanya `python/rapid_doc/` + `python/LICENSE` yang disertakan; sisanya (demo assets, docker, tests, chunker) tidak dibawa dari upstream.

Setiap file `.js` memiliki `PORTING NOTE` di header yang mendokumentasikan asal file `.py` dan keputusan adaptasi yang diambil.

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

- **Asset manifest** (`model_url_map.js`) — 50+ entri ONNX model + runtime files, di-download ke IndexedDB.
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

| Aspek | Python | JS |
|---|---|---|
| Runtime | CPython + ORT | ORT Web (WASM/WebGPU) |
| PDF parsing | pypdfium2 | pdf-lib + PDF.js |
| Image | PIL + OpenCV | OffscreenCanvas + OpenCV.js |
| File I/O | Filesystem | File API + IndexedDB cache |
| GPU | DirectML / CUDA | WebGPU |
| Config | YAML files | JS objects + global injection |
| CLI | Full filesystem CLI | No-op stubs |
| Versi | `0.9.4` | `0.1.0` |
| MinerU base | `2.6.4` | `2.6.4` |

---

## Benchmarking & Validasi

- **OmniDocBench** (1651 halaman annotasi) sebagai ground truth.
- Evaluasi membandingkan JS (WebGPU vs WASM) vs Python (DirectML vs CPU) pada:
  - Kecepatan processing
  - Paritas konten (NED, CER/WER, TEDS, IoU)
  - Cold-start latency (download model, JIT, shader compilation)
- `benchmark/` berisi framework evaluasi lengkap dengan 4-sheet Excel output dan metodologi statistik (geometric mean, bootstrap CI, Wilcoxon, Holm-Bonferroni).

---

## Catatan untuk Agent

Saat bekerja di codebase ini:

1. **Cari `PORTING NOTE`** — setiap file `.js` di `rapid_doc/` mungkin memiliki catatan porting di header, JSDoc, atau inline.
2. **Python reference ada di `python/rapid_doc/`** — jika ragu dengan logika JS, cek file `.py` yang bersesuaian.
3. **Jangan ubah Python reference** — itu adalah kanon; perubahan hanya di JS.
4. **Koordinat bounding box** — selalu gunakan `bankerRound`/`intTrunc`, jangan `Math.round()`.
5. **GPU state** — `ModelSingleton` dan ort_runtime.js mengelola shared WebGPU device; perhatikan `deviceLost` flag dan GPU mutex.
6. **File ini adalah ringkasan porting** — untuk detail teknis implementasi, lihat kode sumber dan `PORTING NOTE` masing-masing file.
