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

import { configureOrtRuntime } from './rapid_doc/utils/ort_runtime.js';
import { docAnalyze } from './rapid_doc/backend/pipeline/pipeline_analyze.js';
import { resultToMiddleJson } from './rapid_doc/backend/pipeline/model_json_to_middle_json.js';
import { unionMake } from './rapid_doc/backend/pipeline/pipeline_middle_json_mkcontent.js';
import { MemoryDataWriter } from './rapid_doc/data/data_reader_writer/index.js';
import { MakeMode } from './rapid_doc/utils/enum_class.js';

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
let abortCtrl = null;
let running = false;

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
  return {
    execution_provider: ep,
    executionProviders: ep === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'],
    parse_method: el.cfgParse.value,
    formula_enable: el.cfgFormula.checked,
    table_enable: el.cfgTable.checked,
    repeat: Math.max(1, parseInt(el.cfgRepeat.value, 10) || 1),
    warmup: el.cfgWarmup.checked,
    layout_config: {
      executionProviders: ep === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'],
      engine_cfg: { use_webgpu: ep !== 'wasm' },
    },
    ocr_config: {
      executionProviders: ep === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'],
      'Det.rec_batch_num': ep === 'webgpu' ? 4 : 1,
      'Rec.rec_batch_num': ep === 'webgpu' ? 6 : 6,
    },
    formula_config: {
      executionProviders: ['wasm'],
    },
    table_config: {
      executionProviders: ['wasm'],
    },
  };
}

// ---------------------------------------------------------------------------
// Unified timing builder (matches Python demo_batch.py output)
// ---------------------------------------------------------------------------

function buildUnifiedTiming(filename, pageCount, totalMs, stageTimings, postMs) {
  const t = stageTimings ?? {};
  const layoutMs    = t.layout    ?? 0;
  const ocrMs       = t.ocr       ?? 0;
  const formulaMs   = t.formula   ?? 0;
  const tableMs     = t.table     ?? 0;
  const modelInitMs = t.model_init ?? 0;
  const inferMs     = layoutMs + ocrMs + formulaMs + tableMs;

  return {
    filename,
    page_count: pageCount,
    // Seconds (primary — matches Python output)
    total_s:           round4(totalMs / 1000),
    model_init_s:      round4(modelInitMs / 1000),
    layout_s:          round4(layoutMs / 1000),
    ocr_s:             round4(ocrMs / 1000),
    formula_s:         round4(formulaMs / 1000),
    table_s:           round4(tableMs / 1000),
    postprocess_s:     round4(postMs / 1000),
    total_inference_s: round4(inferMs / 1000),
    // Milliseconds (secondary)
    total_ms:          Math.round(totalMs),
    model_init_ms:     Math.round(modelInitMs),
    layout_ms:         Math.round(layoutMs),
    ocr_ms:            Math.round(ocrMs),
    formula_ms:        Math.round(formulaMs),
    table_ms:          Math.round(tableMs),
    postprocessing_ms: Math.round(postMs),
  };
}

function round4(v) { return Math.round(v * 10000) / 10000; }

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

  const config = getConfig();
  const repeat = config.repeat;
  const doWarmup = config.warmup;
  const totalRuns = queue.length * (repeat + (doWarmup ? 1 : 0));
  let doneRuns = 0;

  log(`Starting benchmark: ${queue.length} file(s), ${repeat} run(s) each${doWarmup ? ' + 1 warm-up' : ''}`, 'info');
  log(`EP: ${config.execution_provider}, formula: ${config.formula_enable}, table: ${config.table_enable}`, 'info');

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

  for (const file of queue) {
    if (signal.aborted) break;
    setFileStatus(file.name, 'running', 'running…');
    log(`File: ${file.name}`, 'info');

    const fileRuns = [];
    const totalRunsForFile = repeat + (doWarmup ? 1 : 0);

    for (let run = 0; run < totalRunsForFile; run++) {
      if (signal.aborted) break;
      const isWarmup = doWarmup && run === 0;
      const runLabel = isWarmup ? 'warm-up' : `run ${run - (doWarmup ? 1 : 0) + 1}/${repeat}`;

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
            run: run - (doWarmup ? 1 : 0) + 1,
            warmup: false,
            timing: result.timing,
            content_list: result.content_list,
          });
          appendResultRow(file.name, result.page_count, run - (doWarmup ? 1 : 0) + 1, result.timing);
          log(`  ✓ ${runLabel}: total=${elapsed}s, inference=${result.timing.total_inference_s}s`, 'ok');
        } else {
          log(`  ✓ warm-up: ${elapsed}s (excluded from stats)`, 'warn');
        }
      } catch (err) {
        if (err?.name === 'AbortError') { log('  Aborted.', 'warn'); break; }
        log(`  ✗ ${runLabel} failed: ${err?.message ?? err}`, 'err');
        setFileStatus(file.name, 'error', 'error');
      }

      doneRuns++;
      el.progressFill.style.width = `${Math.round(doneRuns / totalRuns * 100)}%`;
    }

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
    ${n(timing.layout_s)}
    ${n(timing.ocr_s)}
    ${n(timing.formula_s)}
    ${n(timing.table_s)}
    ${n(timing.postprocess_s)}
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
    if (!byFile[r.filename]) byFile[r.filename] = { runs: [], content_list: r.content_list };
    byFile[r.filename].runs.push(r.timing);
  }

  const exportData = {
    metadata: {
      timestamp: new Date().toISOString(),
      execution_provider: el.cfgEp.value,
      formula_enable: el.cfgFormula.checked,
      table_enable: el.cfgTable.checked,
      parse_method: el.cfgParse.value,
      repeat: parseInt(el.cfgRepeat.value, 10),
      warmup_excluded: el.cfgWarmup.checked,
      user_agent: navigator.userAgent,
    },
    files: {},
  };

  for (const [filename, data] of Object.entries(byFile)) {
    const runs = data.runs;
    const stem = filename.replace(/\.[^.]+$/, '');

    // Mean timing (for evaluate.py)
    const meanTiming = {
      filename,
      page_count: runs[0]?.page_count ?? 0,
      total_s:          round4(mean(runs.map(r => r.total_s))),
      model_init_s:     0,
      layout_s:         round4(mean(runs.map(r => r.layout_s))),
      ocr_s:            round4(mean(runs.map(r => r.ocr_s))),
      formula_s:        round4(mean(runs.map(r => r.formula_s))),
      table_s:          round4(mean(runs.map(r => r.table_s))),
      postprocess_s:    round4(mean(runs.map(r => r.postprocess_s))),
      total_inference_s: round4(mean(runs.map(r => r.total_inference_s))),
      total_ms:         Math.round(mean(runs.map(r => r.total_ms))),
      model_init_ms:    0,
      layout_ms:        Math.round(mean(runs.map(r => r.layout_ms))),
      ocr_ms:           Math.round(mean(runs.map(r => r.ocr_ms))),
      formula_ms:       Math.round(mean(runs.map(r => r.formula_ms))),
      table_ms:         Math.round(mean(runs.map(r => r.table_ms))),
      postprocessing_ms: Math.round(mean(runs.map(r => r.postprocessing_ms))),
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
    };

    exportData.files[stem] = {
      timing: meanTiming,
      content_list: data.content_list,
    };
  }

  // Download as JSON
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `benchmark_js_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  log('Results exported as JSON. Place individual <stem>_timing.json and <stem>_content_list.json in benchmark/js_results/ for evaluate.py.', 'ok');

  // Also trigger individual file downloads for evaluate.py compatibility
  for (const [filename, data] of Object.entries(byFile)) {
    const stem = filename.replace(/\.[^.]+$/, '');
    const runs = data.runs;
    const meanTiming = exportData.files[stem].timing;

    // _timing.json (mean over runs)
    const timingBlob = new Blob([JSON.stringify(meanTiming, null, 2)], { type: 'application/json' });
    const timingUrl = URL.createObjectURL(timingBlob);
    const ta = Object.assign(document.createElement('a'), { href: timingUrl, download: `${stem}_timing.json` });
    ta.click();
    setTimeout(() => URL.revokeObjectURL(timingUrl), 10_000);

    // _content_list.json
    const clBlob = new Blob([JSON.stringify(data.content_list, null, 2)], { type: 'application/json' });
    const clUrl = URL.createObjectURL(clBlob);
    const ca = Object.assign(document.createElement('a'), { href: clUrl, download: `${stem}_content_list.json` });
    ca.click();
    setTimeout(() => URL.revokeObjectURL(clUrl), 10_000);
  }
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
