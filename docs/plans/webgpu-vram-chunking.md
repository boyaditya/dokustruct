# WebGPU Chunking + Auto-Resume — Final Handover

## Problem
300-page PDFs crash at ~138 pages on AMD GCN-4 GPU. Root cause: ORT-Web JSEP buffer pool saturates GPU device after ~138 cumulative inference pages. No code fix possible within one browser session — only page reload gives fresh GPU adapter + WASM heap.

## Solution Implemented
**Auto-resume via page reload**: when native ORT crash detected, save state (file bytes + accumulated content) → `location.reload()` → auto-detect + auto-resume without user action.

## Key Files Changed

### `ui/utils/pipelineAdapter.js`
- `VRAM_CHUNK_SIZE = 8` — per-chunk page count
- `countPdfPages()` — pdf-lib metadata, lightweight
- `offsetPageIndices()` — single offset after unionMake
- `mergeTimings()` — stage timing sums
- `getResumeDb()` / `saveResumeState()` / `loadResumeState()` / `clearResumeState()` — IndexedDB + sessionStorage persistence
- `_resumeFromCrash()` — public method: rebuilds File from IndexedDB, prepares engine, runs from saved chunk offset
- Pre-slices sub-PDFs once from single `PDFDocument.load()`
- Chunked loop: streams markdown per chunk via `prevChunksMarkdown`/`prevChunksContentList`
- On native crash (catch block): calls `saveResumeState()` + `location.reload()`
- `_chunkImageWriters` tracked for finally-block cleanup

### `ui/app.js`
- `init()`: detects `sessionStorage.rapiddoc_resume` → sets `appState.currentFile` → calls `pipelineAdapter._resumeFromCrash()`
- `refreshIcons()`: removed `hideProgress()` in finally block
- Timer: `updateElapsedTime()` from `updateProgress()` + results subscriber; `setInterval` fallback

### `rapid_doc/backend/pipeline/pipeline_analyze.js`
- WASM trap detection: raw number from `resultToMiddleJson` → `finished.fill(true); break;`
- Page counting: `pdf-lib.getPageCount()` (was `loadImagesFromPdf` which leaked full-resolution canvases)
- Removed dual `requestAnimationFrame` that blocked pipeline when tab backgrounded

## Resume Flow (End-to-End)
```
Chunk 16 crash → saveResumeState(IndexedDB + sessionStorage) → location.reload()
↓ Page loads fresh
init() detects sessionStorage.rapiddoc_resume
↓ Rebuilds File from IndexedDB bytes
state.currentFile = reconstructed File
↓ Calls pipelineAdapter._resumeFromCrash()
  - prepare() → downloads models if needed → warmup
  - _runFullAnalysis() → loadResumeState() restores accumulated state
  - startChunkIdx = Math.floor(startPage / chunkSize)
  - Loop resumes from chunk 16
↓ All 300 pages processed
clearResumeState() on success
```

## Edge Cases
- No resume state → normal flow (unchanged)
- Resume state but IndexedDB missing → toast error, fall to normal
- User aborts during resume → `clearResumeState()` on abort
- Cold cache (no models downloaded) → `prepare()` downloads them first
