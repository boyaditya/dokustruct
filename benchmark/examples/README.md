# Benchmark Example Output

This folder contains a **minimal mock workbook** for portfolio review.

- `results_example.xlsx` (6 KB, 3 sheets: Summary, Per Document, Sample Manifest) — illustrates the structure of full evaluation workbooks without requiring a 1.5 GB OmniDocBench download or 350-document run.

**Full workbooks (N=350 accuracy, N=50 timing, 8 files, 466 KB):** archived in [`docs/evidence/`](../docs/evidence/) — mirrors `thesis/data_testing/` (seed 42, stratified `data_source × language`).

**Generate your own:** `pip install -r benchmark/requirements.txt && python -m benchmark.evaluate --js-dir benchmark/js_results --py-dir benchmark/py_results --gt-dir benchmark/omnidocbench_gt --output benchmark/results.xlsx` (see `benchmark/README.md` Prerequisites & Methodology Notes).

**Supervised runner (headless):** `npm run bench:js:supervised -- --input benchmark/sample/timing_images --out benchmark/js_timing --help`
