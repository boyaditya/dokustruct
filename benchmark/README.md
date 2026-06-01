# Benchmark Skripsi — Evaluasi Komparatif JS vs Python

Evaluasi empiris Sistem A (JS/browser) vs Sistem B (Python). Setelah run,
data **langsung diproses menjadi Excel** (`results.xlsx`) plus dump diff
per-item untuk audit — baik untuk JS maupun Python.

> **Baru menyiapkan eksperimen?** Mulai dari **`SETUP_SKRIPSI.md`** — panduan
> setup langkah-demi-langkah khusus penelitian skripsi (prasyarat, dataset,
> ukuran sampel, menjalankan kedua sistem, evaluasi, checklist, limitasi).
> Dokumen ini (`README.md`) adalah referensi metrik & alur kerja umum;
> rasional metodologi lengkap ada di `BENCHMARK_CONTEXT.md`.

## Metrik

### Waktu
- `total_inference_s` (layout+ocr+formula+table), `model_init` DIKECUALIKAN dari inferensi
- Rasio T_A / T_B per dokumen + **geometric mean** agregat (hindari bias mean-of-ratios)
  dengan **selang kepercayaan 95% bootstrap**
- **Inferensi per halaman** (s/halaman) untuk kontrol panjang dokumen
- **Cold start SEJATI** = first-call latency dari run warm-up pertama (JIT/shader
  compile; di browser dengan cache dingin termasuk download bobot), dilaporkan
  sebagai metrik headline terpisah — bukan lagi proksi `model_init + inferensi` warm
- Coefficient of Variation (CV = std/mean) sebagai indikator stabilitas
- **Uji Wilcoxon signed-rank** (paired, JS vs Python) + effect size (rank-biserial)
  + **koreksi Holm-Bonferroni** untuk multiple comparisons
- **Dua deployment-config** yang dibandingkan setara antar sistem:
  `accelerated` (WebGPU↔DirectML) dan `cpu` (WASM↔CPU). Dibingkai sebagai
  "Sistem A vs Sistem B sebagaimana di-deploy", bukan isolasi runtime/EP

### Kesepadanan Output (alignment per-halaman, content-aware)
- **Type Sequence Difference** — perbedaan struktur urutan tipe
- **Coverage precision / recall / F1** — menangkap item hilang / berlebih secara eksplisit
- **Mean NED raw & ternormalisasi** (Unicode NFC + whitespace collapse)
- **CER / WER** — error rate teks (referensi = Python)
- **TEDS** — Tree-Edit-Distance Similarity untuk struktur tabel HTML
- **Mean bbox IoU** — kesesuaian posisi item ter-match
- **Korelasi urutan baca** — Kendall τ dan Spearman ρ

> Catatan kejujuran metodologis: Python diperlakukan sebagai *reference baseline*,
> bukan ground truth. Metrik mengukur **divergensi JS dari baseline**, bukan
> kebenaran absolut. Untuk akurasi absolut perlu anotasi ground-truth manual.

## Alur Kerja

```
Input: demo/pdfs/*.pdf (file yang sama untuk kedua sistem)

Sistem A (JS)                          Sistem B (Python)
─────────────────────────────         ─────────────────────────────
1. Buka /benchmark.html                1. rtk python -m demo.demo_batch --repeat 10
2. Drop semua PDF                         → tulis ke benchmark/py_results/
3. Set repeat (≥10 disarankan)            → JIKA hasil JS sudah ada di
4. Start Benchmark                          benchmark/js_results/, evaluate
5. Export Results:                          OTOMATIS jalan → results.xlsx
   - benchmark_js_*.json (gabungan)
   - <stem>_timing.json, <stem>_content_list.json
   - benchmark_js_*.xlsx (Excel JS standalone, langsung siap)
6. Pindahkan JSON ke benchmark/js_results/

Evaluasi penuh (JS↔Python):
rtk python -m benchmark.evaluate \
    --js-dir benchmark/js_results \
    --py-dir benchmark/py_results \
    --output benchmark/results.xlsx
```

Urutan disarankan: jalankan JS dulu (taruh hasil di `js_results/`), lalu jalankan
Python batch — `demo_batch` akan otomatis memanggil evaluator dan menghasilkan
`results.xlsx` di akhir. Tidak perlu langkah manual tambahan.

## Perintah

```bash
# Python batch — 10 run + 2 warm-up (accelerated/DirectML), auto-evaluate
rtk python -m demo.demo_batch --repeat 10 --warmup 2 --formula --table

# Deployment-config CPU-only (semua model CPU), dipasangkan dengan JS WASM
rtk python -m demo.demo_batch --repeat 10 --ep-mode cpu --formula --table

# Tanpa auto-evaluate
rtk python -m demo.demo_batch --repeat 10 --no-evaluate

# Evaluasi manual
rtk python -m benchmark.evaluate --js-dir benchmark/js_results --py-dir benchmark/py_results

# Unit test metrik
.venv\Scripts\python.exe -m benchmark.test_metrics
```

`benchmark.evaluate` otomatis memecah file gabungan `benchmark_js_*.json` di
`--js-dir` menjadi `<stem>_timing.json` + `<stem>_content_list.json`, jadi cukup
taruh file gabungan hasil export JS apa adanya.

## Output

| File | Isi |
|---|---|
| `benchmark/results.xlsx` | 4 sheet: Per Dokumen, Statistik Agregat (+geomean), Uji Statistik (Wilcoxon), Content List Diff |
| `benchmark/diffs/<stem>_diff.json` | Dump per-item: match/only-JS/only-Py + teks kedua sistem + NED/CER/IoU/TEDS per item |
| `benchmark/py_results/*` | Timing + content_list Python (embed run_config, metadata, content_stability) |
| `benchmark/js_results/*` | Timing + content_list JS + Excel standalone JS |

## Provenance & Reproducibility (otomatis tertanam)

Setiap `_timing.json` kini menyimpan:
- `run_config`: parse_method, formula/table enable, repeat, dan **real_eps per model**
  (Python memverifikasi DML vs CPU-fallback; JS mencatat webgpu/wasm per model)
- `metadata`: platform, versi ORT, GPU adapter + limits (JS), cross-origin-isolated,
  jumlah thread WASM, cpu_count
- `content_stability`: verifikasi apakah N run menghasilkan output identik
  (asumsi "semua run sama" diuji, bukan dipercaya)

`evaluate.py` membandingkan `run_config` JS vs Python dan menandai
**config mismatch** (merah di Excel) bila formula/table/parse_method berbeda,
supaya perbedaan output tidak salah diatribusikan.

## Mode OmniDocBench (akurasi absolut vs ground truth)

Selain perbandingan JS↔Python, sistem ini dapat diskor terhadap **ground truth**
[OmniDocBench](https://github.com/opendatalab/OmniDocBench) (CVPR 2025): 1651 halaman,
10 tipe dokumen, 5 bahasa, anotasi manual berkualitas tinggi. Ini menjawab celah
"Python sebagai baseline, bukan kebenaran" — kini akurasi diukur absolut.

```bash
# 1. Unduh dataset (images + OmniDocBench.json) dari HuggingFace/OpenDataLab,
#    taruh images ke demo/pdfs (atau folder input pilihan).

# 2. Konversi GT JSON → per-halaman content_list (+ indeks atribut untuk stratifikasi)
rtk python -m benchmark.omnidocbench --gt-json path/to/OmniDocBench.json \
    --out-dir benchmark/omnidocbench_gt

# 3. Jalankan kedua sistem atas image yang sama (JS via benchmark.html, Python via demo_batch)
#    Stem file harus cocok dengan image_path di GT (mis. academic_001).

# 4. Evaluasi dengan mode GT → menghasilkan results.xlsx (JS↔Py) DAN
#    results_gt_accuracy.xlsx (akurasi absolut, per-kategori, per-bahasa)
rtk python -m benchmark.evaluate \
    --js-dir benchmark/js_results --py-dir benchmark/py_results \
    --gt-dir benchmark/omnidocbench_gt --output benchmark/results.xlsx
```

Metrik GT (sheet `results_gt_accuracy.xlsx`): **Overall** (skala OmniDocBench
`((1−TextEdit)×100 + TableTEDS + FormulaScore)/3`), Text Edit, Text CER,
Formula Edit, Table TEDS, Reading Order Edit, Coverage F1, BBox IoU — dengan
breakdown **per tipe dokumen** dan **per bahasa**, plus head-to-head JS vs Python.

### Stratified sampling (tidak perlu 1651 halaman × 10 run)

Menjalankan seluruh 1651 halaman × 10 run × 2 sistem tidak feasible di satu
komputer, dan **tidak diperlukan**. Akurasi bersifat deterministik per sistem
(dibuktikan oleh `content_stability`), jadi cukup 1 run; hanya **timing** yang
butuh repeat. Karena itu dataset dibagi dua korpus via `benchmark/sampler.py`:

| Korpus | Ukuran (saran) | Run/sistem | Tujuan |
|---|---|---|---|
| **Accuracy** | ~150–250 halaman | 1 | metrik kualitas vs GT, stratified by tipe+bahasa |
| **Timing** | ~20–40 halaman (subset accuracy) | ≥10 + warmup | metrik waktu, butuh repeat |

Sampling: **proportional stratified** (per `data_source` × `language`), dengan
**minimum per stratum** agar tipe langka (mis. handwritten, exam) tidak hilang,
**largest-remainder rounding** untuk ukuran tepat, dan **seed tetap** agar
reproducible. Manifest sampel (`sample_manifest.json`) disimpan untuk lampiran.

```bash
# 1. Konversi GT dulu (menghasilkan omnidocbench_index.json untuk stratifikasi)
rtk python -m benchmark.omnidocbench --gt-json path/to/OmniDocBench.json \
    --out-dir benchmark/omnidocbench_gt

# 2. Ambil sampel + salin image ke folder siap-proses
rtk python -m benchmark.sampler \
    --index benchmark/omnidocbench_gt/omnidocbench_index.json \
    --images path/to/omnidocbench/images \
    --out-dir benchmark/sample \
    --accuracy-n 200 --timing-n 30 --min-per-stratum 3 --seed 42
# → benchmark/sample/accuracy_images/  (200 image, 1 run)
# → benchmark/sample/timing_images/    (30 image, 10 run)
# → benchmark/sample/sample_manifest.json

# 3a. AKURASI — kedua sistem, 1 run (formula+tabel ON), skor vs GT
rtk python -m demo.demo_batch --pdfs benchmark/sample/accuracy_images \
    --benchmark-dir benchmark/py_accuracy --repeat 1 --no-warmup --formula --table --no-evaluate
#    (JS: drop accuracy_images ke benchmark.html, repeat=1, export ke benchmark/js_accuracy)
rtk python -m benchmark.evaluate --js-dir benchmark/js_accuracy \
    --py-dir benchmark/py_accuracy --gt-dir benchmark/omnidocbench_gt \
    --manifest benchmark/sample/sample_manifest.json --manifest-split accuracy \
    --report-mode accuracy_pilot \
    --output benchmark/results_accuracy.xlsx

# 3b. TIMING — kedua sistem, 10 run + warmup, pada subset kecil
rtk python -m demo.demo_batch --pdfs benchmark/sample/timing_images \
    --benchmark-dir benchmark/py_timing --repeat 10 --warmup 2 \
    --benchmark-mode final --formula --table --no-evaluate
#    (JS: buka benchmark.html?benchmarkMode=final, drop timing_images,
#     repeat=10, warmup=2, export ke benchmark/js_timing)
rtk python -m benchmark.evaluate --js-dir benchmark/js_timing \
    --py-dir benchmark/py_timing \
    --manifest benchmark/sample/sample_manifest.json --manifest-split timing \
    --report-mode timing_final --output benchmark/results_timing.xlsx
```

Pelaporan: akurasi sebagai mean per-stratum + 95% CI; timing sebagai mean/median
+ CV + uji Wilcoxon. Sebut eksplisit ini **stratified random sample (seed tetap)**,
estimasi atas populasi 1651 — bukan sensus penuh leaderboard.

Untuk workbook pilot N=50, lihat `benchmark/METHODOLOGY_AUDIT_PLAN.md`.
Validasi Excel dapat dijalankan dengan `rtk python -m benchmark.audit_workbook`.

### Berapa ukuran minimum yang tetap valid?

Tidak ada satu angka ajaib — minimum bergantung pada variance metrik, margin of
error, dan berapa stratum yang ingin dilaporkan terpisah. Gunakan
`benchmark/sample_size.py` untuk menghitungnya, jangan menebak.

**Ukuran sampel dengan finite population correction (N=1651, 95% CI):**

| Tingkat | n akurasi | Dasar statistik |
|---|---|---|
| **Lantai minimum** | **100** | CI overall worst-case ±9.5%; realistis (edit-dist) ±0.03; >CLT n=30; per-stratum ~8 |
| **Disarankan** | **150–200** | CI realistis ±0.02; per-stratum 10–20 + CI per-kategori |
| **Kuat** | **300–350** | memenuhi ±5% bahkan untuk metrik worst-case (proporsi) |

Catatan penting: metrik OCR (edit distance, TEDS) biasanya **variance rendah**,
jadi n kecil sering sudah memberi CI sempit. Constraint yang lebih mengikat
biasanya **per-stratum** (agar tiap tipe dokumen × bahasa terisi ≥10–15).

**Timing corpus** (terpisah): 15–30 dokumen × ≥10 repeat. Minimum ~15 dokumen
agar uji Wilcoxon paired punya power memadai.

**Cara rigor (disarankan untuk sidang): pilot dulu, ukur variance, baru sizing.**

```bash
# 1. Pilot kecil: ambil ~30 sampel, jalankan kedua sistem, skor vs GT
rtk python -m benchmark.sampler --index benchmark/omnidocbench_gt/omnidocbench_index.json \
    --images path/to/images --out-dir benchmark/pilot --accuracy-n 30 --timing-n 10 --seed 42
#    (proses pilot di kedua sistem → benchmark/js_pilot, benchmark/py_pilot)
rtk python -m benchmark.evaluate --js-dir benchmark/js_pilot --py-dir benchmark/py_pilot \
    --gt-dir benchmark/omnidocbench_gt --output benchmark/pilot_results.xlsx

# 2. Hitung n yang dibutuhkan dari std aktual pilot (target margin ±0.03)
rtk python -m benchmark.sample_size --pilot benchmark/pilot_results_gt_accuracy.xlsx --margin 0.03

# 3. Tabel teori (tanpa data) untuk justifikasi di bab metode
rtk python -m benchmark.sample_size --population 1651 --confidence 0.95
```

Pilot mode membaca std tiap metrik dari hasil pilot, lalu melaporkan **n yang
dibutuhkan** untuk mencapai margin target — angka inilah yang dipakai sebagai
`--accuracy-n` pada run penuh. Ini dapat dipertahankan: ukuran sampel dihitung
dari variance terukur, bukan ditetapkan sembarang.

> **Deviasi terdokumentasi**: metrik formula resmi OmniDocBench adalah **CDM**
> (butuh TeX Live + ImageMagick + Ghostscript untuk render LaTeX). Karena berat
> dan tidak relevan untuk port browser, formula diskor dengan **normalized-LaTeX
> edit distance** sebagai proxy. Nyatakan ini di bab metode agar tidak mengklaim
> paritas penuh dengan leaderboard resmi.

## Catatan Metodologi (untuk bab metode skripsi)

- **Kerangka deployment-config (bukan isolasi variabel)**: perbandingan default
  (`accelerated`) adalah *konfigurasi deployment end-to-end* (browser-native
  WebGPU/WASM vs Python-native DirectML/CPU). Dibingkai sebagai "Sistem A vs B
  sebagaimana di-deploy", BUKAN isolasi bahasa/runtime/EP. Tersedia juga
  deployment CPU-only: `--ep-mode cpu` (Python) + WASM (JS) → WASM↔CPU.
  `evaluate.py` menandai bila JS & Python dijalankan pada ep_mode berbeda
  (bukan pasangan deployment setara).
- **Model init dikecualikan** dari inferensi karena setelah warm-up KEDUA sistem
  memakai cache model (`ModelSingleton._models` persist lintas run di Python;
  cache VRAM di JS). **BUKAN** karena "Python reload tiap run" (klaim itu salah).
  Cold-start sejati dilaporkan terpisah dari run warm-up pertama.
- **Warm-up run** dikecualikan dari statistik (JIT, cache miss, init driver).
- **Geometric mean** untuk rasio; mean-of-ratios bias secara statistik.
- **n ≥ 5** disarankan; laporkan CV + uji Wilcoxon, bukan hanya mean.
- Dokumentasikan kondisi lingkungan (back-to-back, power plan, idle GPU, suhu).
- Stratifikasi dataset (text-heavy, formula, tabel, scan vs born-digital, bahasa)
  dan laporkan per-kategori, bukan hanya overall.
