# Technical Insights — Audit Notes

> Findings are **as-observed in source**, not claims about runtime behavior. Use as a checklist when touching `rapid_doc/` or `ui/`.

## 1) Execution providers are configured, not observed

- **Layout** dynamically picks WebGPU when available, otherwise WASM; **OCR/orientation** follow the UI toggle; **formula** (PP-FormulaNet Plus, `Loop`) and **table** (SLANet) are intentionally **WASM-only** and ignore the WebGPU toggle
- No `session.getProviders()` exists — state **configured provider** for 3/5 groups, not “running on WebGPU”. `verifyProviders` only warns.

## 2) Effective config is rebuilt per run

- Engine `middle.json`/`content_list` store only `_backend`/`_version_name`, not full `run_config`. Without an explicit dump the exact parameters are unknown.
- **Benchmark** persists `run_config` + `metadata` + `content_stability` in `_timing.json` and flags mismatches; **UI history** now stores `runConfig` for the session, but exported markdown/`content_list` still need external provenance.

## 3) ONNX graphs are patched offline

- `patch_ppdoclayout.py` removes `ceil_mode=1` from pooling nodes; `fix_slanet_plus_shape.py` rewrites shape metadata. `model_url_map.js` `sha256` tracks **patched bytes** (24 assets). If the Python baseline uses unpatched ONNX, graphs are intentionally non-bit-identical — fidelity stays high (ADP-26).

## 4) Three chunking levels — easy to conflate

- **L1 adapter chunk** (8 pages, `pipelineAdapter`, browser-only, `engineReset` between chunks, no Python equivalent, OOM guard)
- **L2 engine window** (`PDF_PAGES_BATCH` 4 WASM / 2 WebGPU, `batch_analyze`/`pipeline_analyze`)
- **L3 stage batch** per model (`layout 4/1`, `det 4/1`, `rec 4–6`, `formula 1–2`)

## 5) Three coordinate spaces

- **Rendered pixels** (model output, `pdf_image_tools`/`toMatBgr`), **PDF points** (Middle JSON `pdf_info`/`page_size`), **per-mille 0–1000** (`content_list`, `unionMake` `Math.floor(x*1000/W)`). Always annotate which space a box is in.

## 6) Pipeline order is preserved, execution is sequential

- 9 stages in Python order (notably table before OCR rec). Inter-stage concurrency is only two narrow async spots; `yieldToBrowser()` is cooperative yielding (`scheduler.yield` → `MessageChannel` → `setTimeout`), **not parallelism**.

## 7) Two caches + LRU, different lifetimes

- **IndexedDB** `rapiddoc_model_cache` (asset bytes, **core ~285 MB**, survives `engineReset`)
- **In-memory** `ModelSingleton`/`AtomModelSingleton` sessions + **LRU 12-entry** `memoryCache` (~500 MB cap, `clearAssetMemoryCache` revokes object URLs) — both cleared by `engineReset()`, which also flushes WebGPU `releaseGpuDevice()` (only way to return pooled buffers).

## 8) Checksums are on the hot path

- **SHA-256 via SubtleCrypto** (24/24 assets in manifest) is verified **before** IndexedDB write on **both** `DownloadFile.run` and the UI `downloadAssetGroup` hot path (`downloadFromSources {verifySha256}` → `saveToCache`). Corrupt buffers never poison cache. Test-mode can disable via flag.

## 9) Resource lifecycle is explicit

- `cv.Mat.delete()` / `tensor.dispose()` / `session.release()` required; `device.lost` sets `deviceLost=true` and skips `release()` to avoid “invalid session” noise; global GPU mutex `acquireGlobalGpu()` serializes `session.run()` (ORT WebGPU not thread-safe).

## 10) June nits — now resolved

- Duplicate `ProgressTracker.complete()` → single `complete(stage)` (June duplicate gone)
- OCR default now consistently `ch` (`appState`/`app.js`); `<html lang="en">` is page language, not OCR
- `playwright` is used by `benchmark/js_supervised_runner.mjs` (`npx playwright install chromium` required)
- 5 advanced table/checkbox flags (`tableForceOcr`, `tableUseWordBox`, `tableFormulaEnable`, `skipTextInImage`, `tableUseImg2table`, `checkboxEnable`) remain code-only by design — treat as code defaults.

---

### How to use

- **For contributors:** 1, 4, 5, 6, 7, 9 are the most common pitfalls when touching `rapid_doc/` or `ui/`.
- **For evaluators:** 2 and 8 explain why to persist `run_config`/`metadata` and not to claim “identical graphs/providers”.
- **For docs:** complements `docs/porting-decisions.md` and `README.md` Runtime Insights.
