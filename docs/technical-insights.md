# Technical Insights — Audit Notes

> Findings are **as-observed in source**, not claims about runtime behavior. Use as a checklist when touching `rapid_doc/` or `ui/`.

## 1) Execution providers are configured, not observed

- **Layout** picks WebGPU/WASM dynamically; **OCR/orientation** follow config; **formula/table** are hard-coded to WASM (`Loop` autoregressive) and ignore the WebGPU toggle. Selecting “WebGPU” in the UI therefore affects only 3 of 5 model groups.
- No `getProviders()` or logging of the actual provider exists — docs should state **configured provider**, not “running on WebGPU”.

## 2) Effective config is not persisted

- Config objects are rebuilt per run and not written to `middle.json`/`content_list` (`_backend`/`_version_name` only). Without an explicit dump, the exact parameters of an evaluation run are `UNKNOWN` unless recorded externally. Recommend persisting `run_config` alongside outputs (see `benchmark/` provenance).

## 3) ONNX graphs are patched offline

- `patch_ppdoclayout.py` removes `ceil_mode=1` from pooling nodes; `fix_slanet_plus_shape.py` rewrites shape metadata. If the Python baseline uses unpatched ONNX, the two systems run **non-identical graphs** — fidelity remains high but not bit-identical.

## 4) Three chunking levels — easy to conflate

- **Adapter chunk** (8 pages, `pipelineAdapter`), **engine window** (4 or 2 pages, `batch_analyze`), **model batch** (inside each stage). The adapter chunk has no Python equivalent and is browser-specific for OOM avoidance.

## 5) Three coordinate spaces

- **Rendered image pixels** (model output), **PDF points** (Middle JSON), **per-mille normalized** (`content_list`). Mixing them is a common doc bug — always note which space a box is in.

## 6) Pipeline order is preserved, execution is sequential

- 9 stages in Python order (notably table before OCR text). Inter-stage concurrency is limited to two narrow async spots; `yieldToBrowser()` is cooperative yielding, not parallelism.

## 7) Two caches, different lifetimes

- **Asset cache** (bytes, IndexedDB persistent) vs **model-session cache** (`ModelSingleton`, in-memory). `engineReset()` clears the latter, not the former; `rapiddoc_model_cache` (≈150 MB) survives across sessions.

## 8) Checksum verification is not on the hot path

- SHA-256 is checked in `DownloadFile.run` but not in `downloadAssetGroup` (the UI path). Manifest `sha256` values are correct (verified manually, 20/20 match), but the UI path does not enforce them.

## 9) Resource lifecycle is explicit

- `cv.Mat.delete()` / `tensor.dispose()` / `session.release()` are required; WebGPU `deviceLost` needs handling, and a global GPU mutex (`acquireGlobalGpu()`) serializes `session.run()`.

## 10) Minor code divergences noted in June

- Duplicate `ProgressTracker.complete()`, default OCR language differing between `index.html` (`en`) and `appState` (`ch`), 5 configs without UI controls, unused `playwright` dep. Treat undocumented defaults as `UNKNOWN` until confirmed — some may have been fixed since audit.

---

### How to use

- **For contributors:** points 1, 4, 5, 6, 7, 9 explain the most common pitfalls when touching `rapid_doc/` or `ui/`.
- **For evaluators:** points 2 and 8 explain why to persist `run_config`/`metadata` and not to claim “identical graphs/providers” without an explicit check.
- **For docs:** this file complements `docs/porting-decisions.md` and `docs/pipeline-flow.md` — it adds runtime and lifecycle nuance.
