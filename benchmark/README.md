# Benchmark Skripsi — Evaluasi Komparatif JS vs Python

Evaluasi empiris Sistem A (JS/browser) vs Sistem B (Python) berdasarkan tiga metrik:

1. **Processing Time** — `total_inference_s` (model_init TIDAK dihitung) dan rasio T_A / T_B
2. **Type Sequence Difference** — perbedaan struktur urutan tipe item output
3. **Mean Normalized Edit Distance (NED)** — perbedaan konten string item yang sepadan

Setiap file diproses N kali (default 3), dengan 1 warm-up run yang dikecualikan dari statistik.
Statistik yang dilaporkan: mean, median, std dev, min, max.

---

## Alur Kerja

```
Input: demo/pdfs/*.pdf (file yang sama untuk kedua sistem)

Sistem A (JS)                          Sistem B (Python)
─────────────────────────────          ─────────────────────────────
1. Buka http://localhost:5173/         1. Jalankan demo_batch.py
   benchmark.html                         (proses semua PDF, N repeat)
2. Drop semua PDF ke antrian           2. Output otomatis ke
3. Set repeat count (misal 3)             benchmark/py_results/
4. Klik "Start Benchmark"
5. Setelah selesai, klik
   "Export Results JSON"
6. Pindahkan <stem>_timing.json
   dan <stem>_content_list.json
   ke benchmark/js_results/

Evaluasi
────────
python -m benchmark.evaluate \
    --js-dir benchmark/js_results \
    --py-dir benchmark/py_results \
    --output benchmark/results.xlsx
```

---

## Perintah

### Python batch

```bash
# Default: 3 run per file + 1 warm-up, formula dan tabel dimatikan
rtk python -m demo.demo_batch

# Custom repeat
rtk python -m demo.demo_batch --repeat 5

# Dengan formula dan tabel
rtk python -m demo.demo_batch --formula --table

# Tanpa warm-up
rtk python -m demo.demo_batch --no-warmup
```

### JS benchmark UI

Buka `http://localhost:5173/benchmark.html` (saat dev server berjalan).

Fitur:
- Drop multi-file PDF
- Set repeat count dan warm-up toggle
- Progress per file per run
- Auto-export setelah selesai: `<stem>_timing.json` + `<stem>_content_list.json`

### Evaluasi

```bash
rtk python -m benchmark.evaluate \
    --js-dir benchmark/js_results \
    --py-dir benchmark/py_results \
    --output benchmark/results.xlsx
```

---

## Format timing JSON (identik JS dan Python)

```json
{
  "filename": "demo1.pdf",
  "page_count": 8,
  "total_s": 34.11,
  "model_init_s": 12.38,
  "layout_s": 2.81,
  "ocr_s": 7.23,
  "formula_s": 0.0,
  "table_s": 0.0,
  "postprocess_s": 0.76,
  "total_inference_s": 10.04,
  "stats": {
    "n": 3,
    "mean_inference_s": 10.04,
    "median_inference_s": 9.98,
    "std_inference_s": 0.23,
    "min_inference_s": 9.81,
    "max_inference_s": 10.32
  },
  "runs": [
    { "run": 1, "total_inference_s": 9.81, ... },
    { "run": 2, "total_inference_s": 10.32, ... },
    { "run": 3, "total_inference_s": 9.98, ... }
  ]
}
```

**Catatan**: `model_init_s` disimpan untuk referensi tapi TIDAK dimasukkan ke `total_inference_s`.
Perbandingan menggunakan `total_inference_s` (layout + ocr + formula + table).

---

## Excel output (3 sheet)

### Sheet 1: Per Dokumen
Kolom identik JS dan Python:
- Inferensi (s), Layout (s), OCR (s), Formula (s), Tabel (s), Postprocess (s)
- N Run, Std Dev, Median, Min, Max
- Rasio Waktu (A/B), Type Seq. Diff., Mean NED, N Pasang

Rasio > 1 = JS lebih lambat (merah), < 1 = JS lebih cepat (hijau).

### Sheet 2: Statistik Agregat
Mean, median, std, min, max untuk semua metrik.

### Sheet 3: Content List Diff
Urutan tipe item JS vs Python per dokumen.

---

## Catatan Metodologi

- **Model init dikecualikan** karena JS menggunakan warm cache (model tetap di VRAM antar run),
  sedangkan Python me-reload model setiap kali. Perbandingan yang adil menggunakan
  `total_inference_s` yang hanya mengukur waktu inferensi murni.

- **Warm-up run** (run pertama) dikecualikan dari statistik karena JIT compilation,
  cache miss, dan inisialisasi driver dapat menyebabkan run pertama lebih lambat.

- **Paired comparison**: setiap dokumen diproses oleh kedua sistem dengan konfigurasi
  yang sama, sehingga perbedaan hasil dapat dikaitkan dengan sistem, bukan input.
