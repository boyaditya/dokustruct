/**
 * benchmark.js
 * ============
 * Lightweight benchmark runner for RapidDoc-JS.
 *
 * Runs the same pipeline as the main UI but without any rendering overhead.
 * Supports multi-file queue, configurable repeat count, and warm-up exclusion.
 *
 * Output: per-run timing JSON + content_list JSON, downloadable as a ZIP
 * that can be fed directly into benchmark/evaluate.py.
 */

import { configureOrtRuntime, getAdapterMetadata } from './rapid_doc/utils/ort_runtime.js';
import { docAnalyze } from './rapid_doc/backend/pipeline/pipeline_analyze.js';
import { resultToMiddleJson } from './rapid_doc/backend/pipeline/model_json_to_middle_json.js';
import { unionMake } from './rapid_doc/backend/pipeline/pipeline_middle_json_mkcontent.js';
import { MemoryDataWriter } from './rapid_doc/data/data_reader_writer/index.js';
import { MakeMode } from './rapid_doc/utils/enum_class.js';
import { buildXlsxBlob } from './ui/utils/xlsxWriter.js';
import { ASSET_MANIFEST } from './rapid_doc/utils/model_url_map.js';
import JSZip from 'jszip';

const PDF_PAGES_BATCH = 64; // default batch size

// ---------------------------------------------------------------------------
// OpenCV loader (same pattern as pipelineAdapter.js)
// ---------------------------------------------------------------------------

function hasOpenCVRuntime() {
  return Boolean(globalThis.cv?.Mat);
}

function loadOpenCVScript() {
  if (hasOpenCVRuntime()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-docparse-opencv], script[src="/opencv/opencv.js"]');
    if (existing) {
      if (hasOpenCVRuntime()) { resolve(); return; }
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load /opencv/opencv.js')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = '/opencv/opencv.js';
    script.async = true;
    script.dataset.docparseOpencv = 'true';
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', () => reject(new Error('Failed to load /opencv/opencv.js')), { once: true });
    document.head.appendChild(script);
  });
}

function waitForOpenCV(timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (hasOpenCVRuntime()) { resolve(true); return; }
    const interval = setInterval(() => {
      if (hasOpenCVRuntime()) { clearInterval(interval); clearTimeout(timer); resolve(true); }
    }, 100);
    const timer = setTimeout(() => { clearInterval(interval); resolve(hasOpenCVRuntime()); }, timeoutMs);
  });
}

let _runtimeReady = false;
let _lastEp = null;

async function ensureRuntime(ep) {
  if (_runtimeReady && _lastEp === ep) return;
  _runtimeReady = false;
  log('Loading OpenCV…', 'info');
  await loadOpenCVScript();
  const ok = await waitForOpenCV();
  if (!ok) throw new Error('OpenCV runtime not available. Check /opencv/opencv.js.');
  log('OpenCV ready.', 'ok');
  await configureOrtRuntime({ numThreads: 4, useWebGpu: ep === 'webgpu' });
  log(`ORT runtime configured (EP: ${ep}).`, 'ok');
  _runtimeReady = true;
  _lastEp = ep;
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const el = {
  dropZone:     document.getElementById('dropZone'),
  fileInput:    document.getElementById('fileInput'),
  fileList:     document.getElementById('fileList'),
  btnStart:     document.getElementById('btnStart'),
  btnStop:      document.getElementById('btnStop'),
  btnClear:     document.getElementById('btnClear'),
  btnExport:    document.getElementById('btnExport'),
  progressPanel:document.getElementById('progressPanel'),
  progressLabel:document.getElementById('progressLabel'),
  progressFill: document.getElementById('progressFill'),
  summaryPanel: document.getElementById('summaryPanel'),
  statsGrid:    document.getElementById('statsGrid'),
  resultsPanel: document.getElementById('resultsPanel'),
  resultsBody:  document.getElementById('resultsBody'),
  logEl:        document.getElementById('logEl'),
  cfgEp:        document.getElementById('cfgEp'),
  cfgRepeat:    document.getElementById('cfgRepeat'),
  cfgParse:     document.getElementById('cfgParse'),
  cfgFormula:   document.getElementById('cfgFormula'),
  cfgTable:     document.getElementById('cfgTable'),
  cfgWarmup:    document.getElementById('cfgWarmup'),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {File[]} */
let queue = [];
/** @type {Map<string, {li: HTMLElement, status: HTMLElement, progress: HTMLElement}>} */
const fileEls = new Map();
/** @type {Array<{filename:string, run:number, warmup:boolean, timing:object, content_list:any[]}>} */
let allResults = [];
/** @type {Map<string, object>} cold-start (first warm-up) timing per file */
const fileColdStarts = new Map();
/** @type {Map<string, object>} input-file provenance (sha256 + kind) per file */
const fileInputProvenance = new Map();
let abortCtrl = null;
let running = false;
/** Reproducibility metadata + run config captured at the start of a benchmark. */
let lastEnvironment = null;
let lastRunConfig = null;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg, level = 'info') {
  const line = document.createElement('span');
  line.className = level;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  el.logEl.appendChild(line);
  el.logEl.scrollTop = el.logEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// File queue management
// ---------------------------------------------------------------------------

function addFiles(files) {
  for (const f of files) {
    if (queue.find(q => q.name === f.name && q.size === f.size)) continue;
    queue.push(f);
    renderFileItem(f);
  }
}

function renderFileItem(file) {
  const li = document.createElement('li');
  li.className = 'file-item';

  const nameEl   = document.createElement('span');
  nameEl.className = 'name';
  nameEl.title = file.name;
  nameEl.textContent = file.name;

  const pagesEl  = document.createElement('span');
  pagesEl.className = 'pages';
  pagesEl.textContent = '—';

  const statusEl = document.createElement('span');
  statusEl.className = 'status status-pending';
  statusEl.textContent = 'pending';

  li.appendChild(nameEl);
  li.appendChild(pagesEl);
  li.appendChild(statusEl);
  el.fileList.appendChild(li);

  fileEls.set(file.name, { li, status: statusEl, pages: pagesEl });
}

function setFileStatus(name, status, text) {
  const refs = fileEls.get(name);
  if (!refs) return;
  refs.status.className = `status status-${status}`;
  refs.status.textContent = text;
}

function setFilePages(name, n) {
  const refs = fileEls.get(name);
  if (refs) refs.pages.textContent = `${n}p`;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function getConfig() {
  const ep = el.cfgEp.value;
  const isWasm = ep === 'wasm';
  const eps = isWasm ? ['wasm'] : ['webgpu', 'wasm'];
  // Mirror the MAIN UI (ui/state/appState.js) config EXACTLY so the benchmark
  // measures the same pipeline the UI runs. Previously table_config/formula_config
  // omitted model_type, so the benchmark fell back to a DIFFERENT table model
  // and produced a different (broken) table structure than the main UI.
  return {
    execution_provider: ep,
    // ep_mode names the DEPLOYMENT CONFIGURATION under test (mirrors Python):
    // 'cpu' (wasm) = CPU-only deployment vs Python CPU; 'accelerated' (webgpu)
    // = realistic GPU deployment vs Python DirectML. We compare the systems
    // as deployed, not language/runtime in isolation.
    ep_mode: isWasm ? 'cpu' : 'accelerated',
    executionProviders: eps,
    parse_method: el.cfgParse.value,
    formula_enable: el.cfgFormula.checked,
    table_enable: el.cfgTable.checked,
    repeat: Math.max(1, parseInt(el.cfgRepeat.value, 10) || 1),
    // Warm-up is now a COUNT (was a checkbox). First warm-up is preserved as
    // the cold-start measurement; all warm-ups are excluded from steady stats.
    warmup: Math.max(0, parseInt(el.cfgWarmup.value, 10) || 0),
    layout_config: {
      execution_provider: ep,
      executionProviders: eps,
      engine_cfg: { use_webgpu: !isWasm },
      model_type: 'pp_doclayoutv2',
      conf_thresh: 0.5,
      layout_shape_mode: 'auto',
      use_doc_orientation_classify: true,
      batch_num: isWasm ? 1 : 4,
      markdown_ignore_labels: [
        'number', 'footnote', 'header', 'header_image',
        'footer', 'footer_image', 'aside_text',
      ],
    },
    ocr_config: {
      execution_provider: ep,
      executionProviders: eps,
      use_det_mode: 'auto',
      'Det.rec_batch_num': isWasm ? 1 : 4,
      'Rec.rec_batch_num': 6,
    },
    formula_config: {
      // Formula stays on wasm in both deployment configs (parity with Python
      // CPU); in cpu mode every model is wasm.
      execution_provider: isWasm ? 'wasm' : ep,
      executionProviders: ['wasm'],
      formula_level: 0,
      modelType: 'pp_formulanet_plus_s',
      batch_num: 2,
    },
    table_config: {
      // Table pinned to wasm (parity with Python CPU). model_type MUST match
      // the main UI (unet_slanet_plus) or the table structure diverges.
      execution_provider: isWasm ? 'wasm' : ep,
      executionProviders: ['wasm'],
      engine_cfg: { use_webgpu: false },
      model_type: 'unet_slanet_plus',
      force_ocr: false,
      use_word_box: false,
      // Match the Python parity config (build_parity_config leaves
      // table_formula_enable at its default True). With table_formula_enable
      // OFF, formulas inside table cells are read as plain OCR text and their
      // superscripts/subscripts collapse, diverging from the Python baseline.
      table_formula_enable: el.cfgFormula.checked,
      table_image_enable: false,
      skip_text_in_image: true,
      use_img2table: false,
      use_compare_table: false,
    },
    orientation_config: {
      execution_provider: ep,
      executionProviders: eps,
    },
  };
}

// ---------------------------------------------------------------------------
// Unified timing builder (matches Python demo_batch.py output)
// ---------------------------------------------------------------------------

function buildUnifiedTiming(filename, pageCount, totalMs, stageTimings, postMs) {
  const t = stageTimings ?? {};
  const layoutMs    = t.layout    ?? 0;
  const ocrDetMs    = t.ocr_det   ?? 0;
  const ocrRecMs    = t.ocr_rec   ?? 0;
  const ocrMs       = ocrDetMs + ocrRecMs;   // combined OCR (det + rec) inference
  const formulaMs   = t.formula   ?? 0;
  const tableMs     = t.table     ?? 0;
  const modelInitMs = t.model_init ?? 0;
  const orientationMs   = t.orientation    ?? 0;
  const regionCollectMs = t.region_collect ?? 0;
  const pdfLoadMs       = t.pdf_load        ?? 0;
  // "postprocess" is now ONLY the lightweight middle-json / content-list build
  // measured by the caller (postMs). OCR-rec inference moved into ocr_rec.
  const postTotalMs = postMs ?? 0;

  // Inference = layout + OCR(det+rec) + formula + table. OCR-rec is genuine
  // model inference and is now INCLUDED (previously hidden in "postprocess").
  const inferMs     = layoutMs + ocrMs + formulaMs + tableMs;

  // Reconciliation: everything we explicitly attribute. Anything left over
  // (memory cleanup, Mat conversion, yields, JS overhead) is reported as
  // `other_ms` so the per-stage breakdown ALWAYS sums to total_ms.
  const attributedMs = modelInitMs + pdfLoadMs + orientationMs + layoutMs
    + regionCollectMs + ocrDetMs + ocrRecMs + formulaMs + tableMs + postTotalMs;
  const otherMs = Math.max(0, totalMs - attributedMs);

  return {
    filename,
    page_count: pageCount,
    // Seconds (primary — matches Python output)
    total_s:           round4(totalMs / 1000),
    model_init_s:      round4(modelInitMs / 1000),
    pdf_load_s:        round4(pdfLoadMs / 1000),
    orientation_s:     round4(orientationMs / 1000),
    layout_s:          round4(layoutMs / 1000),
    region_collect_s:  round4(regionCollectMs / 1000),
    ocr_det_s:         round4(ocrDetMs / 1000),
    ocr_rec_s:         round4(ocrRecMs / 1000),
    ocr_s:             round4(ocrMs / 1000),
    formula_s:         round4(formulaMs / 1000),
    table_s:           round4(tableMs / 1000),
    postprocess_s:     round4(postTotalMs / 1000),
    other_s:           round4(otherMs / 1000),
    total_inference_s: round4(inferMs / 1000),
    // Milliseconds (secondary)
    total_ms:          Math.round(totalMs),
    model_init_ms:     Math.round(modelInitMs),
    pdf_load_ms:       Math.round(pdfLoadMs),
    orientation_ms:    Math.round(orientationMs),
    layout_ms:         Math.round(layoutMs),
    region_collect_ms: Math.round(regionCollectMs),
    ocr_det_ms:        Math.round(ocrDetMs),
    ocr_rec_ms:        Math.round(ocrRecMs),
    ocr_ms:            Math.round(ocrMs),
    formula_ms:        Math.round(formulaMs),
    table_ms:          Math.round(tableMs),
    postprocessing_ms: Math.round(postTotalMs),
    other_ms:          Math.round(otherMs),
  };
}

function round4(v) { return Math.round(v * 10000) / 10000; }

// ---------------------------------------------------------------------------
// Reproducibility metadata + run-config provenance
// ---------------------------------------------------------------------------

async function collectEnvironment(ep) {
  const env = {
    timestamp: new Date().toISOString(),
    user_agent: navigator.userAgent,
    platform: navigator.platform || null,
    hardware_concurrency: navigator.hardwareConcurrency || null,
    device_memory_gb: navigator.deviceMemory || null,
    cross_origin_isolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : null,
    shared_array_buffer: typeof SharedArrayBuffer !== 'undefined',
    webgpu_available: !!(navigator.gpu),
    execution_provider: ep,
    wasm_threads: null,
    ort_version: null,
    gpu_adapter: null,
    gpu_limits: null,
  };

  // ORT version + thread count (best-effort; ort is a global after config)
  try {
    const ort = globalThis.ort;
    if (ort?.env) {
      env.wasm_threads = ort.env.wasm?.numThreads ?? null;
      env.ort_version = ort.version ?? ort.env.versions?.common ?? null;
    }
  } catch { /* ignore */ }

  // GPU adapter info captured during ORT WebGPU device init
  try {
    const meta = getAdapterMetadata?.();
    if (meta) {
      env.gpu_adapter = meta.label ?? null;
      env.gpu_limits = meta.limits ?? null;
    }
    // Direct query as fallback (some browsers expose info here)
    if (!env.gpu_adapter && navigator.gpu?.requestAdapter) {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        try {
          const info = typeof adapter.requestAdapterInfo === 'function'
            ? await adapter.requestAdapterInfo() : (adapter.info ?? {});
          env.gpu_adapter = [info?.description, info?.vendor, info?.architecture]
            .filter(Boolean).join(' / ') || null;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  return env;
}

function buildRunConfig(config, ep) {
  // Real EPs per model, mirroring the Python real_eps shape for parity checks.
  // In cpu mode (wasm) ALL models run on wasm — the CPU-only deployment config.
  const gpu = ep === 'wasm' ? 'wasm' : 'webgpu';
  return {
    parse_method: config.parse_method,
    formula_enable: config.formula_enable,
    table_enable: config.table_enable,
    repeat: config.repeat,
    warmup_runs: config.warmup,
    warmup_excluded: config.warmup > 0,
    ep_mode: config.ep_mode,
    execution_provider: ep,
    real_eps: {
      layout: gpu,
      ocr: gpu,
      formula: 'wasm',  // pinned to WASM for parity with Python CPU
      table: 'wasm',
    },
  };
}

// ---------------------------------------------------------------------------
// Model-file provenance: SHA-256 (first 16 hex) of each served ONNX model.
// Recorded so the report can PROVE JS and Python used the same artifacts, and
// that the served file matches the hash declared in the asset manifest.
// ---------------------------------------------------------------------------

const PROVENANCE_MODEL_IDS = [
  'layout_pp_doclayoutv2',
  'ocr_det', 'ocr_rec_ch',
  'formula_pp_formulanet_plus_s',
  'table_unet', 'table_slanet_plus',
];

async function hashModelFiles() {
  const out = { files: {}, note: '' };
  if (!globalThis.crypto?.subtle) {
    out.note = 'SubtleCrypto unavailable (needs secure context); cannot hash.';
    return out;
  }
  // Resolve which model ids are actually present in the manifest (ids vary),
  // falling back to scanning the manifest for *.onnx assets.
  const assets = Object.values(ASSET_MANIFEST).filter(
    (a) => (a.localUrl || a.url || '').includes('.onnx'));
  const wanted = assets.filter(
    (a) => PROVENANCE_MODEL_IDS.includes(a.id)) ;
  const targets = (wanted.length ? wanted : assets).slice(0, 8);

  for (const a of targets) {
    const url = a.localUrl || a.url;
    if (!url) continue;
    try {
      const resp = await fetch(url, { method: 'GET', cache: 'force-cache' });
      if (!resp.ok) { out.files[a.id] = { url, error: `HTTP ${resp.status}` }; continue; }
      const buf = await resp.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const expected = a.sha256 || null;
      out.files[a.id] = {
        url,
        sha256_16: hex.slice(0, 16),
        sha256_full: hex,
        size_bytes: buf.byteLength,
        expected_sha256: expected,
        matches_manifest: expected ? (hex === expected) : null,
      };
    } catch (e) {
      out.files[a.id] = { url, error: String(e?.message ?? e) };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Input-file provenance: SHA-256 + kind. Recorded per document so the report
// can PROVE JS and Python consumed the SAME input bytes (a clean parity proof
// for the paired comparison).
// ---------------------------------------------------------------------------

const _IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'tiff', 'tif', 'gif', 'jp2'];

async function hashInputFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const out = { name: file.name, size_bytes: file.size };
  if (_IMAGE_EXTS.includes(ext)) {
    out.kind = 'image';
  } else if (ext === 'pdf') {
    out.kind = 'pdf';
  } else {
    out.kind = 'other';
  }
  try {
    if (globalThis.crypto?.subtle) {
      const buf = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buf);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      out.sha256_16 = hex.slice(0, 16);
      out.sha256_full = hex;
    } else {
      out.note = 'SubtleCrypto unavailable (needs secure context); cannot hash.';
    }
  } catch (e) {
    out.error = String(e?.message ?? e);
  }
  return out;
}

// Cross-run content stability check (verifies the "all runs identical" assumption)
function contentStability(runsContent) {
  if (!runsContent || !runsContent.length) {
    return { n_runs_with_content: 0, identical: true, distinct_outputs: 0 };
  }
  const typeSeq = (cl) => (cl || [])
    .filter((it) => it?.type !== 'discarded')
    .map((it) => it?.type ?? '?').join('|');
  const seqs = new Set(runsContent.map(typeSeq));
  const serialized = new Set(runsContent.map((cl) => JSON.stringify(cl)));
  return {
    n_runs_with_content: runsContent.length,
    identical: serialized.size === 1,
    distinct_type_sequences: seqs.size,
    distinct_outputs: serialized.size,
  };
}

// ---------------------------------------------------------------------------
// Single-file single-run pipeline
// ---------------------------------------------------------------------------

async function runOnce(file, config, signal) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdfPagesBatch = PDF_PAGES_BATCH;

  const t0 = performance.now();

  const docResult = await docAnalyze(
    [bytes],
    {
      lang_list: ['ch'],
      parse_method: config.parse_method,
      formula_enable: config.formula_enable,
      table_enable: config.table_enable,
      layout_config: config.layout_config,
      ocr_config: config.ocr_config,
      formula_config: config.formula_config,
      table_config: config.table_config,
      orientation_config: config.orientation_config,
      pdf_pages_batch: pdfPagesBatch,
    }
  );

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const [inferResults, allImageLists, allPdfDocs, langList, ocrEnabledList, stageTimings] = docResult;
  const modelList  = inferResults[0];
  const imagesList = allImageLists[0];
  const pageDicts  = allPdfDocs[0];
  const lang       = langList[0] ?? 'ch';
  const ocrEnabled = ocrEnabledList[0] ?? false;

  const tPost0 = performance.now();
  const imageWriter = new MemoryDataWriter();
  const middleJson = await resultToMiddleJson(
    modelList, imagesList, pageDicts, imageWriter,
    { lang, ocr_enable: ocrEnabled, formula_enabled: config.formula_enable, ocr_config: config.ocr_config, image_config: null }
  );
  const pdfInfo = middleJson?.pdf_info ?? [];
  const contentList = unionMake(pdfInfo, MakeMode.CONTENT_LIST, 'images') ?? [];
  const postMs = performance.now() - tPost0;

  const totalMs = performance.now() - t0;
  const pageCount = modelList.length;

  // Release image lists
  for (const list of allImageLists) {
    for (const item of (list ?? [])) {
      const canvas = item?.img_pil ?? item?.canvas ?? item;
      if (canvas && typeof canvas === 'object' && 'width' in canvas) {
        try { canvas.width = 0; canvas.height = 0; } catch {}
      }
    }
  }

  return {
    timing: buildUnifiedTiming(file.name, pageCount, totalMs, stageTimings, postMs),
    content_list: contentList,
    page_count: pageCount,
  };
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

async function runBenchmark() {
  if (running || queue.length === 0) return;
  running = true;
  abortCtrl = new AbortController();
  const signal = abortCtrl.signal;

  el.btnStart.disabled = true;
  el.btnStop.disabled = false;
  el.btnClear.disabled = true;
  el.btnExport.disabled = true;
  el.progressPanel.style.display = '';
  el.resultsPanel.style.display = '';
  el.summaryPanel.style.display = 'none';
  allResults = [];
  fileColdStarts.clear();
  fileInputProvenance.clear();

  const config = getConfig();
  const repeat = config.repeat;
  const warmupRuns = config.warmup;
  const totalRuns = queue.length * (repeat + warmupRuns);
  let doneRuns = 0;

  log(`Starting benchmark: ${queue.length} file(s), ${repeat} run(s) each` +
      `${warmupRuns ? ` + ${warmupRuns} warm-up` : ''}`, 'info');
  log(`EP: ${config.execution_provider} (mode=${config.ep_mode}), ` +
      `formula: ${config.formula_enable}, table: ${config.table_enable}`, 'info');

  // Load OpenCV + configure ORT (once per session, or if EP changed)
  try {
    await ensureRuntime(config.execution_provider);
  } catch (e) {
    log(`Runtime init failed: ${e?.message ?? e}`, 'err');
    running = false;
    el.btnStart.disabled = false;
    el.btnStop.disabled = true;
    el.btnClear.disabled = false;
    return;
  }

  // Capture reproducibility metadata now that ORT/WebGPU is initialised.
  lastRunConfig = buildRunConfig(config, config.execution_provider);
  try {
    lastEnvironment = await collectEnvironment(config.execution_provider);
    log(`Environment: GPU=${lastEnvironment.gpu_adapter ?? 'n/a'}, ` +
        `COI=${lastEnvironment.cross_origin_isolated}, ` +
        `threads=${lastEnvironment.wasm_threads ?? 'n/a'}, ` +
        `ORT=${lastEnvironment.ort_version ?? 'n/a'}`, 'info');
  } catch (e) {
    lastEnvironment = { error: String(e?.message ?? e) };
  }

  // Model-file provenance (hash served ONNX, verify against manifest).
  try {
    log('Hashing model files for provenance…', 'info');
    const mh = await hashModelFiles();
    lastEnvironment = { ...(lastEnvironment || {}), model_hashes: mh };
    const mism = Object.entries(mh.files || {})
      .filter(([, v]) => v.matches_manifest === false).map(([k]) => k);
    if (mism.length) {
      log(`⚠ model hash mismatch vs manifest: ${mism.join(', ')}`, 'warn');
    } else {
      log('Model hashes captured (match manifest).', 'ok');
    }
  } catch (e) {
    log(`Model hashing skipped: ${e?.message ?? e}`, 'warn');
  }

  for (const file of queue) {
    if (signal.aborted) break;
    setFileStatus(file.name, 'running', 'running…');
    log(`File: ${file.name}`, 'info');

    // Input-file provenance (hash bytes + kind) so JS↔Python input parity can
    // be proven (same bytes fed to both systems).
    try {
      const prov = await hashInputFile(file);
      fileInputProvenance.set(file.name, prov);
      log(`  input: ${prov.kind} (sha256=${prov.sha256_16 ?? 'n/a'})`, 'info');
    } catch (e) {
      log(`  input hashing skipped: ${e?.message ?? e}`, 'warn');
    }

    const fileRuns = [];
    let coldStart = null;  // first warm-up run, preserved as cold-start
    const totalRunsForFile = repeat + warmupRuns;

    for (let run = 0; run < totalRunsForFile; run++) {
      if (signal.aborted) break;
      const isWarmup = run < warmupRuns;
      const runLabel = isWarmup
        ? `warm-up ${run + 1}/${warmupRuns}`
        : `run ${run - warmupRuns + 1}/${repeat}`;

      el.progressLabel.textContent = `${file.name} — ${runLabel}`;
      el.progressFill.style.width = `${Math.round(doneRuns / totalRuns * 100)}%`;

      log(`  ${runLabel}…`, 'info');
      const t0 = performance.now();

      try {
        const result = await runOnce(file, config, signal);
        const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

        if (!isWarmup) {
          setFilePages(file.name, result.page_count);
          fileRuns.push(result);
          allResults.push({
            filename: file.name,
            run: run - warmupRuns + 1,
            warmup: false,
            timing: result.timing,
            content_list: result.content_list,
          });
          appendResultRow(file.name, result.page_count, run - warmupRuns + 1, result.timing);
          log(`  ✓ ${runLabel}: total=${elapsed}s, inference=${result.timing.total_inference_s}s`, 'ok');
        } else {
          // Preserve the FIRST warm-up run as the cold-start measurement.
          if (run === 0) coldStart = result.timing;
          log(`  ✓ ${runLabel}: ${elapsed}s (excluded from steady-state stats)`, 'warn');
        }
      } catch (err) {
        if (err?.name === 'AbortError') { log('  Aborted.', 'warn'); break; }
        log(`  ✗ ${runLabel} failed: ${err?.message ?? err}`, 'err');
        setFileStatus(file.name, 'error', 'error');
      }

      doneRuns++;
      el.progressFill.style.width = `${Math.round(doneRuns / totalRuns * 100)}%`;
    }

    // Stash cold-start for this file so export can attach it.
    if (coldStart) fileColdStarts.set(file.name, coldStart);

    if (!signal.aborted) {
      setFileStatus(file.name, 'done', `done (${repeat}×)`);
    }
  }

  el.progressLabel.textContent = signal.aborted ? 'Stopped.' : 'Complete.';
  el.progressFill.style.width = '100%';

  if (allResults.length > 0) {
    renderSummary();
    el.btnExport.disabled = false;
  }

  running = false;
  el.btnStart.disabled = false;
  el.btnStop.disabled = true;
  el.btnClear.disabled = false;
  log(`Benchmark finished. ${allResults.length} result(s) collected.`, 'ok');
}

// ---------------------------------------------------------------------------
// Results rendering
// ---------------------------------------------------------------------------

function appendResultRow(filename, pages, run, timing) {
  const tr = document.createElement('tr');
  const n = (v) => `<td class="num">${v != null ? v.toFixed(3) : '—'}</td>`;
  tr.innerHTML = `
    <td>${filename}</td>
    <td class="num">${pages}</td>
    <td class="num">${run}</td>
    ${n(timing.total_s)}
    ${n(timing.model_init_s)}
    ${n(timing.pdf_load_s)}
    ${n(timing.orientation_s)}
    ${n(timing.layout_s)}
    ${n(timing.region_collect_s)}
    ${n(timing.ocr_det_s)}
    ${n(timing.ocr_rec_s)}
    ${n(timing.formula_s)}
    ${n(timing.table_s)}
    ${n(timing.postprocess_s)}
    ${n(timing.other_s)}
    ${n(timing.total_inference_s)}
  `;
  el.resultsBody.appendChild(tr);
}

function renderSummary() {
  el.summaryPanel.style.display = '';
  el.statsGrid.innerHTML = '';

  // Group by filename, compute stats over inference time
  const byFile = {};
  for (const r of allResults) {
    if (!byFile[r.filename]) byFile[r.filename] = [];
    byFile[r.filename].push(r.timing.total_inference_s);
  }

  // Overall stats
  const allInference = allResults.map(r => r.timing.total_inference_s);
  const allTotal = allResults.map(r => r.timing.total_s);

  addStatCard('Files', Object.keys(byFile).length, '');
  addStatCard('Total runs', allResults.length, '');
  addStatCard('Mean inference', mean(allInference).toFixed(3), 's');
  addStatCard('Median inference', median(allInference).toFixed(3), 's');
  addStatCard('Std dev', stddev(allInference).toFixed(3), 's');
  addStatCard('Min inference', Math.min(...allInference).toFixed(3), 's');
  addStatCard('Max inference', Math.max(...allInference).toFixed(3), 's');
  addStatCard('Mean total', mean(allTotal).toFixed(3), 's');
}

function addStatCard(label, value, unit) {
  const card = document.createElement('div');
  card.className = 'stat-card';
  card.innerHTML = `<div class="label">${label}</div><div class="value">${value} <span class="unit">${unit}</span></div>`;
  el.statsGrid.appendChild(card);
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function exportResults() {
  if (!allResults.length) return;

  // Build per-file aggregated timing JSONs (mean over runs)
  const byFile = {};
  for (const r of allResults) {
    if (!byFile[r.filename]) byFile[r.filename] = { runs: [], content_list: r.content_list, run_contents: [] };
    byFile[r.filename].runs.push(r.timing);
    byFile[r.filename].run_contents.push(r.content_list);
    byFile[r.filename].content_list = r.content_list; // last run wins for export
  }

  const exportData = {
    metadata: {
      ...(lastEnvironment || {}),
      execution_provider: el.cfgEp.value,
      ep_mode: el.cfgEp.value === 'wasm' ? 'cpu' : 'accelerated',
      formula_enable: el.cfgFormula.checked,
      table_enable: el.cfgTable.checked,
      parse_method: el.cfgParse.value,
      repeat: parseInt(el.cfgRepeat.value, 10),
      warmup_runs: parseInt(el.cfgWarmup.value, 10) || 0,
    },
    run_config: lastRunConfig || buildRunConfig(getConfig(), el.cfgEp.value),
    files: {},
  };

  for (const [filename, data] of Object.entries(byFile)) {
    const runs = data.runs;
    const stem = filename.replace(/\.[^.]+$/, '');

    // Cold-start block (first warm-up run): real first-call latency incl.
    // JIT/shader compilation (and, on a cold HTTP cache, model download).
    const cold = fileColdStarts.get(filename) || null;
    const coldBlock = cold ? {
      total_s: cold.total_s,
      model_init_s: cold.model_init_s,
      total_inference_s: cold.total_inference_s,
      cold_start_total_s: round4((cold.model_init_s || 0) + (cold.total_inference_s || 0)),
    } : null;

    // Mean timing (for evaluate.py)
    const meanTiming = {
      filename,
      page_count: runs[0]?.page_count ?? 0,
      total_s:          round4(mean(runs.map(r => r.total_s))),
      model_init_s:     round4(mean(runs.map(r => r.model_init_s))),
      pdf_load_s:       round4(mean(runs.map(r => r.pdf_load_s ?? 0))),
      orientation_s:    round4(mean(runs.map(r => r.orientation_s ?? 0))),
      layout_s:         round4(mean(runs.map(r => r.layout_s))),
      region_collect_s: round4(mean(runs.map(r => r.region_collect_s ?? 0))),
      ocr_det_s:        round4(mean(runs.map(r => r.ocr_det_s ?? 0))),
      ocr_rec_s:        round4(mean(runs.map(r => r.ocr_rec_s ?? 0))),
      ocr_s:            round4(mean(runs.map(r => r.ocr_s))),
      formula_s:        round4(mean(runs.map(r => r.formula_s))),
      table_s:          round4(mean(runs.map(r => r.table_s))),
      postprocess_s:    round4(mean(runs.map(r => r.postprocess_s))),
      other_s:          round4(mean(runs.map(r => r.other_s ?? 0))),
      total_inference_s: round4(mean(runs.map(r => r.total_inference_s))),
      total_ms:         Math.round(mean(runs.map(r => r.total_ms))),
      model_init_ms:    Math.round(mean(runs.map(r => r.model_init_ms))),
      pdf_load_ms:      Math.round(mean(runs.map(r => r.pdf_load_ms ?? 0))),
      orientation_ms:   Math.round(mean(runs.map(r => r.orientation_ms ?? 0))),
      layout_ms:        Math.round(mean(runs.map(r => r.layout_ms))),
      region_collect_ms: Math.round(mean(runs.map(r => r.region_collect_ms ?? 0))),
      ocr_det_ms:       Math.round(mean(runs.map(r => r.ocr_det_ms ?? 0))),
      ocr_rec_ms:       Math.round(mean(runs.map(r => r.ocr_rec_ms ?? 0))),
      ocr_ms:           Math.round(mean(runs.map(r => r.ocr_ms))),
      formula_ms:       Math.round(mean(runs.map(r => r.formula_ms))),
      table_ms:         Math.round(mean(runs.map(r => r.table_ms))),
      postprocessing_ms: Math.round(mean(runs.map(r => r.postprocessing_ms))),
      other_ms:         Math.round(mean(runs.map(r => r.other_ms ?? 0))),
      // Cold-start (first-call) measurement, kept distinct from warm stats
      cold_start: coldBlock,
      // Per-run breakdown for variance analysis
      runs: runs.map((r, i) => ({ run: i + 1, ...r })),
      stats: {
        n: runs.length,
        mean_total_s:     round4(mean(runs.map(r => r.total_s))),
        median_total_s:   round4(median(runs.map(r => r.total_s))),
        std_total_s:      round4(stddev(runs.map(r => r.total_s))),
        min_total_s:      round4(Math.min(...runs.map(r => r.total_s))),
        max_total_s:      round4(Math.max(...runs.map(r => r.total_s))),
        mean_inference_s: round4(mean(runs.map(r => r.total_inference_s))),
        median_inference_s: round4(median(runs.map(r => r.total_inference_s))),
        std_inference_s:  round4(stddev(runs.map(r => r.total_inference_s))),
        min_inference_s:  round4(Math.min(...runs.map(r => r.total_inference_s))),
        max_inference_s:  round4(Math.max(...runs.map(r => r.total_inference_s))),
      },
      // Reproducibility + parity provenance (consumed by evaluate.py)
      run_config: exportData.run_config,
      metadata: exportData.metadata,
      input_file: fileInputProvenance.get(filename) || null,
      content_stability: contentStability(data.run_contents),
    };

    if (!meanTiming.content_stability.identical) {
      log(`  ⚠ ${stem}: content differs across runs ` +
          `(distinct_outputs=${meanTiming.content_stability.distinct_outputs})`, 'warn');
    }

    exportData.files[stem] = {
      timing: meanTiming,
      content_list: data.content_list,
    };
  }

  const tsStamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');

  // Bundle EVERYTHING into a single ZIP so the browser fires one download
  // (multiple sequential downloads get blocked/throttled by browsers) and the
  // archive can be fed straight into benchmark/evaluate.py via --js-dir.
  const zip = new JSZip();

  // 1) Combined JSON (evaluate.py auto-explodes benchmark_js_*.json)
  zip.file(`benchmark_js_${tsStamp}.json`, JSON.stringify(exportData, null, 2));

  // 2) Per-file <stem>_timing.json + <stem>_content_list.json for evaluate.py.
  //    Placed under js_results/ so the ZIP mirrors the expected --js-dir layout.
  for (const [filename, data] of Object.entries(byFile)) {
    const stem = filename.replace(/\.[^.]+$/, '');
    const meanTiming = exportData.files[stem].timing;
    zip.file(`js_results/${stem}_timing.json`, JSON.stringify(meanTiming, null, 2));
    zip.file(`js_results/${stem}_content_list.json`, JSON.stringify(data.content_list, null, 2));
  }

  // 3) Standalone Excel of the JS-side data (ready immediately, no Python needed)
  try {
    const xlsxBlob = await buildJsExcel(exportData);
    zip.file(`benchmark_js_${tsStamp}.xlsx`, xlsxBlob);
  } catch (e) {
    log(`Excel build failed (ZIP will omit it): ${e?.message ?? e}`, 'err');
  }

  // 4) Emit the single ZIP.
  try {
    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    const fileCount = Object.keys(byFile).length;
    downloadBlob(zipBlob, `benchmark_js_${tsStamp}.zip`);
    log(`ZIP exported: ${fileCount} file(s) × (timing + content_list) + combined JSON + Excel ` +
        `in benchmark_js_${tsStamp}.zip.`, 'ok');
    log('Unzip js_results/ into benchmark/js_results, then run benchmark/evaluate.py for the full JS↔Python comparison.', 'info');
  } catch (e) {
    log(`ZIP export failed: ${e?.message ?? e}`, 'err');
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------
// Standalone JS-side Excel (per-document + per-run + environment)
// ---------------------------------------------------------------------------

async function buildJsExcel(exportData) {
  const HDR = '4472C4';
  const GRP_JS = '70AD47';
  const h = (v) => ({ v, bold: true, fill: HDR });

  // Sheet 1: Per Dokumen (mean timings)
  const perDoc = [];
  perDoc.push([
    h('Dokumen'), h('Halaman'), h('Inferensi (s)'), h('Inf/Halaman (s)'),
    h('Model Init (s)'), h('PDF Load (s)'), h('Orient. (s)'), h('Layout (s)'),
    h('Region (s)'), h('OCR Det (s)'), h('OCR Rec (s)'), h('Formula (s)'), h('Tabel (s)'),
    h('Postprocess (s)'), h('Other (s)'), h('Total (s)'), h('Cold Start (s)'),
    h('N Run'), h('Std'), h('CV'), h('Median'), h('Min'), h('Max'),
    h('Konten Stabil'),
  ]);
  for (const [stem, payload] of Object.entries(exportData.files)) {
    const t = payload.timing;
    const pages = t.page_count || 0;
    const infer = t.total_inference_s || 0;
    const std = t.stats?.std_inference_s || 0;
    // Real cold-start when captured (first warm-up run), else fall back to
    // warm model_init + inference (clearly the warm proxy).
    const cold = t.cold_start?.cold_start_total_s != null
      ? t.cold_start.cold_start_total_s
      : round4((t.model_init_s || 0) + infer);
    perDoc.push([
      stem, pages, infer, pages ? round4(infer / pages) : 0,
      t.model_init_s, t.pdf_load_s ?? 0, t.orientation_s ?? 0, t.layout_s,
      t.region_collect_s ?? 0, t.ocr_det_s ?? 0, t.ocr_rec_s ?? 0, t.formula_s, t.table_s,
      t.postprocess_s, t.other_s ?? 0, t.total_s, cold,
      t.stats?.n || 1, std, infer > 0 ? round4(std / infer) : 0,
      t.stats?.median_inference_s, t.stats?.min_inference_s, t.stats?.max_inference_s,
      t.content_stability?.identical ? 'ya' : 'TIDAK',
    ]);
  }

  // Sheet 2: Per Run (variance analysis)
  const perRun = [];
  perRun.push([h('Dokumen'), h('Run'), h('Total (s)'), h('Inferensi (s)'),
    h('Model Init (s)'), h('PDF Load (s)'), h('Orient. (s)'), h('Layout (s)'),
    h('Region (s)'), h('OCR Det (s)'), h('OCR Rec (s)'), h('Formula (s)'), h('Tabel (s)'),
    h('Postprocess (s)'), h('Other (s)')]);
  for (const [stem, payload] of Object.entries(exportData.files)) {
    for (const r of payload.timing.runs || []) {
      perRun.push([stem, r.run, r.total_s, r.total_inference_s,
        r.model_init_s, r.pdf_load_s ?? 0, r.orientation_s ?? 0, r.layout_s,
        r.region_collect_s ?? 0, r.ocr_det_s ?? 0, r.ocr_rec_s ?? 0, r.formula_s, r.table_s,
        r.postprocess_s, r.other_s ?? 0]);
    }
  }

  // Sheet 3: Environment + run config (reproducibility)
  const envRows = [[h('Kunci'), h('Nilai')]];
  const flat = { ...exportData.metadata, ...flattenRunConfig(exportData.run_config) };
  for (const [k, v] of Object.entries(flat)) {
    envRows.push([k, typeof v === 'object' && v !== null ? JSON.stringify(v) : v]);
  }

  return buildXlsxBlob([
    { name: 'Per Dokumen', rows: perDoc },
    { name: 'Per Run', rows: perRun },
    { name: 'Environment', rows: envRows },
  ]);
}

function flattenRunConfig(rc) {
  if (!rc) return {};
  const out = {};
  for (const [k, v] of Object.entries(rc)) {
    out[`run_config.${k}`] = typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

el.dropZone.addEventListener('click', () => el.fileInput.click());
el.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); el.dropZone.classList.add('drag-over'); });
el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('drag-over'));
el.dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropZone.classList.remove('drag-over');
  addFiles([...e.dataTransfer.files]);
});
el.fileInput.addEventListener('change', () => {
  addFiles([...el.fileInput.files]);
  el.fileInput.value = '';
});

el.btnStart.addEventListener('click', runBenchmark);
el.btnStop.addEventListener('click', () => {
  abortCtrl?.abort();
  log('Stop requested.', 'warn');
});
el.btnClear.addEventListener('click', () => {
  if (running) return;
  queue = [];
  fileEls.clear();
  el.fileList.innerHTML = '';
  allResults = [];
  el.resultsBody.innerHTML = '';
  el.summaryPanel.style.display = 'none';
  el.resultsPanel.style.display = 'none';
  el.btnExport.disabled = true;
  log('Queue cleared.', 'info');
});
el.btnExport.addEventListener('click', exportResults);

// Detect EP on load
if (typeof navigator !== 'undefined' && navigator.gpu) {
  el.cfgEp.value = 'webgpu';
  log('WebGPU detected — default EP set to webgpu.', 'ok');
} else {
  el.cfgEp.value = 'wasm';
  log('WebGPU not available — default EP set to wasm.', 'warn');
}

log('Benchmark UI ready. Drop PDF files to begin.', 'info');
