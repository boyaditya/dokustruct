import { AppState } from './state/appState.js';
import { pipelineAdapter } from './utils/pipelineAdapter.js';
import { exportUtils } from './utils/exportUtils.js';
import { configureOrtWasmRuntime } from '../rapid_doc/utils/ort_runtime.js';

const STAGE_ORDER = [
  'preprocessing',
  'layout',
  'ocr',
  'formula',
  'table',
  'assembly',
  'visual',
];

const TIMING_STAGE_MAP = {
  preprocessing: ['preprocessing'],
  layout: ['layoutAnalysis'],
  ocr: ['ocr'],
  formula: ['formula'],
  table: ['table'],
  assembly: ['readingOrder', 'postprocessing'],
  visual: [],
};

const VISUAL_PLACEHOLDER = {
  width: 960,
  height: 540,
};
const VISUAL_MAX_SIDE = 2200;
const ZOOM_LEVELS = [1, 1.22, 1.5, 1.85];
const PAN_DRAG_THRESHOLD = 3;
const VISUAL_CANVAS_MAX_HEIGHT_DESKTOP = 680;
const VISUAL_CANVAS_MAX_HEIGHT_MOBILE = 380;
const OCR_CANVAS_MAX_HEIGHT_DESKTOP = 520;
const OCR_CANVAS_MAX_HEIGHT_MOBILE = 320;

const OCR_LAYOUT_REGION_LABELS = new Set([
  'text', 'plain_text', 'content', 'paragraph', 'paragraph_text', 'body_text',
  'abstract', 'algorithm', 'reference', 'reference_content', 'quote', 'aside_text',
  'vertical_text', 'title', 'doc_title', 'paragraph_title', 'list', 'index',
  'image_caption', 'figure_caption', 'chart_caption', 'figure_title', 'chart_title',
  'table_caption', 'table_title', 'image_footnote', 'chart_footnote', 'vision_footnote',
  'table_footnote', 'footnote', 'header', 'footer', 'number', 'page_number',
]);

const NATIVE_LAYOUT_TABLE_TYPE_ORDER = {
  table_caption: 1,
  table_body: 2,
  table_footnote: 3,
};

const NATIVE_LAYOUT_PRIMARY_TYPES = new Set([
  'text',
  'ref_text',
  'title',
  'interline_equation',
  'list',
  'index',
]);

const NATIVE_LAYOUT_CONTAINER_TYPES = new Set(['image', 'table', 'code']);

const DENSE_TEXT_LAYOUT_LABELS = new Set([
  ...OCR_LAYOUT_REGION_LABELS,
  'caption',
]);

const LAYOUT_VISUAL_MIN_AREA_RATIO = 0.00045;
const LAYOUT_VISUAL_MIN_TEXT_AREA_RATIO = 0.0055;
const LAYOUT_VISUAL_MIN_TEXT_HEIGHT_RATIO = 0.02;
const LAYOUT_VISUAL_MAX_TEXT_ASPECT_RATIO = 18;
const LAYOUT_VISUAL_MAX_REGIONS = 140;
const OCR_REWRITE_EMPTY_FALLBACK = '[unreadable]';

const PPSTRUCTURE_LABEL_COLORS = {
  title: '#f59e0b',
  text: '#60a5fa',
  plain_text: '#60a5fa',
  figure: '#f43f5e',
  table: '#10b981',
  table_body: '#0ea5a4',
  formula: '#8b5cf6',
  caption: '#fb7185',
  header: '#06b6d4',
  footer: '#f97316',
  list: '#84cc16',
  reference: '#6366f1',
  quote: '#a855f7',
};

const PPSTRUCTURE_FALLBACK_COLORS = [
  '#38bdf8', '#f97316', '#a855f7', '#22c55e', '#ef4444', '#14b8a6', '#eab308', '#3b82f6',
];

const LAYOUT_TO_V1 = {
  plus_l: 'pp_doclayout_plus_l',
  v2: 'pp_doclayoutv2',
  v3: 'pp_doclayoutv3',
  s: 'pp_doclayout_s',
};

const V1_TO_LAYOUT = {
  pp_doclayout_plus_l: 'plus_l',
  pp_doclayoutv2: 'v2',
  pp_doclayoutv3: 'v3',
  pp_doclayout_s: 's',
};

const OCR_TO_LANG = {
  ch_v5: 'ch',
  en_v5: 'en',
};

const LANG_TO_OCR = {
  ch: 'ch_v5',
  en: 'en_v5',
};

const state = new AppState();
configureOrtWasmRuntime({ numThreads: 4 });

if (typeof window !== 'undefined') {
  // Expose runtime state for e2e harness synchronisation.
  window.__RAPIDDOC_V1_APP_STATE__ = state;
}

const $ = (sel) => document.querySelector(sel);

const uploadZone = $('#upload-zone');
const fileInput = $('#file-input');
const fileNameDisplay = $('#file-name-display');
const pipelineModeHint = $('#pipeline-mode-hint');
const layoutModelSelect = $('#layout-model-select');
const layoutModelHint = $('#layout-model-hint');
const ocrRecModelSelect = $('#ocr-rec-model-select');
const ocrRecModelHint = $('#ocr-rec-model-hint');
const formulaEnableToggle = $('#formula-enable-toggle');
const formulaModelSelect = $('#formula-model-select');
const tableEnableToggle = $('#table-enable-toggle');
const tableModelSelect = $('#table-model-select');

const markdownRaw = $('#markdown-raw');
const markdownViewer = $('#markdown-viewer');
const markdownTabs = Array.from(document.querySelectorAll('#markdown-tabs .mini-tab'));
const markdownCards = Array.from(document.querySelectorAll('[data-md-card]'));

const visualTabs = Array.from(document.querySelectorAll('#visual-tabs .visual-tab'));
const visualCards = Array.from(document.querySelectorAll('[data-visual-card]'));
const layoutDetectionCanvas = $('#layout-detection-canvas');
const readingOrderCanvas = $('#reading-order-canvas');
const ocrOverlayCanvas = $('#ocr-overlay-canvas');
const ocrRewriteCanvas = $('#ocr-rewrite-canvas');
const layoutMeta = $('#layout-meta');
const readingOrderMeta = $('#reading-order-meta');
const ocrMeta = $('#ocr-meta');
const visualZoomHint = $('#visual-zoom-hint');
const visualResetZoomBtn = $('#visual-reset-zoom');

const VISUAL_ITEMS = [
  { key: 'layout', tab: 'layout', canvas: layoutDetectionCanvas },
  { key: 'reading', tab: 'reading', canvas: readingOrderCanvas },
  { key: 'ocr-overlay', tab: 'ocr', canvas: ocrOverlayCanvas },
  { key: 'ocr-rewrite', tab: 'ocr', canvas: ocrRewriteCanvas },
];

const visualWraps = new Map(
  VISUAL_ITEMS.map((item) => [item.key, document.querySelector(`[data-visual-wrap="${item.key}"]`)]),
);

const visualStates = new Map(
  VISUAL_ITEMS.map((item) => [item.key, {
    zoom: 1,
    panX: 0,
    panY: 0,
    pointerId: null,
    pointerDown: false,
    dragging: false,
    startX: 0,
    startY: 0,
    startPanX: 0,
    startPanY: 0,
    suppressClickUntil: 0,
  }]),
);

const totalTime = $('#total-time');
const runBtn = $('#btn-run');
const csvBtn = $('#btn-csv');
const artifactsBtn = $('#btn-artifacts');
const postprocessingBreakdownRows = $('#postprocessing-breakdown-rows');
const postprocessingBreakdownEmpty = $('#postprocessing-breakdown-empty');

let currentFile = null;
let sourceCanvas = null;
let currentMarkdownMode = 'viewer';
let runningUiStage = null;
let latestVisualRenderMs = 0;

bootstrap();

function bootstrap() {
  const savedLayout = localStorage.getItem('rapiddoc_v1_layout_model') || 'v2';
  const savedOcrRec = localStorage.getItem('rapiddoc_v1_ocr_rec_model') || 'ch_v5';
  const savedFormula = localStorage.getItem('rapiddoc_v1_formula_enable');
  const savedTable = localStorage.getItem('rapiddoc_v1_table_enable');
  const savedFormulaModel = localStorage.getItem('rapiddoc_v1_formula_model') || 'pp_formulanet_plus_s';
  const savedTableModel = localStorage.getItem('rapiddoc_v1_table_model') || 'unet_slanet_plus';

  state.patch({
    parseMethod: 'auto',
    forceOcr: false,
    dumpMd: true,
    dumpContentList: true,
    dumpMiddleJson: true,
    dumpModelOutput: false,
    drawLayoutBbox: true,
    drawSpanBbox: false,
    pipelineMode: 'full_analysis',
    layoutModelType: mapLayoutToV1(savedLayout),
    language: mapOcrRecToLang(savedOcrRec),
    formulaEnable: savedFormula === '1',
    tableEnable: savedTable === '1',
    tableModelType: savedTableModel,
    formulaModelType: savedFormulaModel,
  });

  if (layoutModelSelect) {
    layoutModelSelect.value = mapV1ToLayout(state.get('layoutModelType'));
    updateLayoutModelHint();
    layoutModelSelect.addEventListener('change', () => {
      const v4Key = layoutModelSelect.value;
      const v1Key = mapLayoutToV1(v4Key);
      state.set('layoutModelType', v1Key);
      localStorage.setItem('rapiddoc_v1_layout_model', v4Key);
      updateLayoutModelHint();
    });
  }

  if (ocrRecModelSelect) {
    ocrRecModelSelect.value = mapLangToOcrRec(state.get('language'));
    updateOcrRecModelHint();
    ocrRecModelSelect.addEventListener('change', () => {
      const lang = mapOcrRecToLang(ocrRecModelSelect.value);
      state.set('language', lang);
      localStorage.setItem('rapiddoc_v1_ocr_rec_model', ocrRecModelSelect.value);
      updateOcrRecModelHint();
    });
  }

  if (formulaEnableToggle) {
    formulaEnableToggle.checked = state.get('formulaEnable');
    formulaEnableToggle.addEventListener('change', () => {
      const enabled = Boolean(formulaEnableToggle.checked);
      state.set('formulaEnable', enabled);
      localStorage.setItem('rapiddoc_v1_formula_enable', enabled ? '1' : '0');
    });
  }

  if (formulaModelSelect) {
    formulaModelSelect.value = state.get('formulaModelType');
    formulaModelSelect.addEventListener('change', () => {
      state.set('formulaModelType', formulaModelSelect.value);
      localStorage.setItem('rapiddoc_v1_formula_model', formulaModelSelect.value);
    });
  }

  if (tableEnableToggle) {
    tableEnableToggle.checked = state.get('tableEnable');
    tableEnableToggle.addEventListener('change', () => {
      const enabled = Boolean(tableEnableToggle.checked);
      state.set('tableEnable', enabled);
      localStorage.setItem('rapiddoc_v1_table_enable', enabled ? '1' : '0');
    });
  }

  if (tableModelSelect) {
    tableModelSelect.value = state.get('tableModelType');
    tableModelSelect.addEventListener('change', () => {
      state.set('tableModelType', tableModelSelect.value);
      localStorage.setItem('rapiddoc_v1_table_model', tableModelSelect.value);
    });
  }

  initUploadEvents();
  initVisualTabs();
  initMarkdownTabs();
  initInlineVisualInteractions();
  updateVisualZoomUi();

  runBtn?.addEventListener('click', runPipeline);
  csvBtn?.addEventListener('click', () => {
    exportUtils.exportBenchmarkCsv(state);
  });
  artifactsBtn?.addEventListener('click', async () => {
    await exportUtils.exportZipBundle(state);
  });

  visualResetZoomBtn?.addEventListener('click', () => {
    const active = getActiveVisualKey();
    if (active) {
      resetInlineZoomByTab(active);
    }
  });

  state.subscribe('processingStage', (stage) => {
    const mapped = mapProcessingStageToUi(stage);
    if (!mapped) {
      return;
    }
    setStageRunning(mapped);
  });

  state.subscribe('timings', () => {
    if (state.get('results')) {
      applyFinalStageTimings(buildUiTimings());
      updateTotalTimeFromTimings();
    }
  });

  state.subscribe('results', async (results) => {
    if (!results) {
      return;
    }

    renderMarkdownOutput(results.markdown || '(no markdown output)', results.images || null);
    const visualMs = await renderVisualOutputs(results);
    applyVisualTiming(results, visualMs);
    renderPostprocessingBreakdown(results);

    applyFinalStageTimings(buildUiTimings());
    updateTotalTimeFromTimings();
    csvBtn.disabled = false;
    if (artifactsBtn) {
      artifactsBtn.disabled = false;
    }
  });

  state.subscribe('isProcessing', (processing) => {
    updateRunButtonState(Boolean(processing));
    if (!processing && !state.get('results') && runningUiStage) {
      markCurrentRunningAsError();
    }
  });

  syncPipelineModeHint();
  resetStages();
  resetPostprocessingBreakdown();
  resetVisualOutputs('Upload a file to render visuals.');
  renderMarkdownOutput('Upload a file to run RapidDoc pipeline.', null);
  updateRunButtonState(false);
}

function mapLayoutToV1(value) {
  return LAYOUT_TO_V1[value] || 'pp_doclayoutv2';
}

function mapV1ToLayout(value) {
  return V1_TO_LAYOUT[value] || 'v2';
}

function mapOcrRecToLang(value) {
  return OCR_TO_LANG[value] || 'ch';
}

function mapLangToOcrRec(value) {
  return LANG_TO_OCR[value] || 'ch_v5';
}

function updateLayoutModelHint() {
  if (!layoutModelHint || !layoutModelSelect) {
    return;
  }
  const labels = {
    v2: 'PP-DocLayoutV2',
    v3: 'PP-DocLayoutV3',
    s: 'PP-DocLayout-S',
    plus_l: 'PP-DocLayout Plus L',
  };
  const key = layoutModelSelect.value;
  layoutModelHint.textContent = `Current: ${labels[key] || labels.v2}.`; 
}

function updateOcrRecModelHint() {
  if (!ocrRecModelHint || !ocrRecModelSelect) {
    return;
  }
  const labels = {
    ch_v5: 'PP-OCRv5 Recognizer (CH)',
    en_v5: 'PP-OCRv5 Recognizer (EN)',
  };
  const key = ocrRecModelSelect.value;
  ocrRecModelHint.textContent = `Current: ${labels[key] || labels.ch_v5}.`; 
}

function syncPipelineModeHint() {
  if (!pipelineModeHint) {
    return;
  }

  pipelineModeHint.textContent = 'Full Analysis runs complete pipeline (layout + OCR + postprocess).';
}

function initUploadEvents() {
  if (!uploadZone || !fileInput) {
    return;
  }

  uploadZone.addEventListener('click', () => fileInput.click());
  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('drag-over');
  });
  uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('drag-over');
  });
  uploadZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    uploadZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      await loadFile(file);
    }
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (file) {
      await loadFile(file);
    }
  });
}

async function loadFile(file) {
  currentFile = file;
  state.patch({
    files: [file],
    currentFileIndex: 0,
    results: null,
    showOutputPanel: false,
    timings: {
      preprocessing: 0,
      layoutAnalysis: 0,
      ocr: 0,
      formula: 0,
      table: 0,
      readingOrder: 0,
      postprocessing: 0,
      total: 0,
    },
  });

  fileNameDisplay.textContent = file.name;
  csvBtn.disabled = true;
  if (artifactsBtn) {
    artifactsBtn.disabled = true;
  }
  resetStages();
  resetPostprocessingBreakdown();
  renderMarkdownOutput(`File loaded: ${file.name}. Click Run Pipeline to start.`, null);

  try {
    sourceCanvas = await buildSourceCanvas(file);
    resetVisualOutputs('File loaded. Click Run Pipeline to render visuals.');
    setTotalMessage('File loaded. Click Run Pipeline.');
  } catch (err) {
    sourceCanvas = null;
    resetVisualOutputs(`Preview not available: ${err.message || err}`);
    setTotalMessage('File loaded. Preview unavailable, but processing can continue.');
  }

  updateRunButtonState(Boolean(state.get('isProcessing')));
}

async function buildSourceCanvas(file) {
  if (isImageFile(file)) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  }

  // PDF preview is optional. We still allow processing without a preview canvas.
  throw new Error('PDF preview is disabled in this UI mode.');
}

function isImageFile(file) {
  const mime = String(file?.type || '').toLowerCase();
  if (mime.startsWith('image/')) {
    return true;
  }
  return /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(file?.name || '');
}

async function runPipeline() {
  if (!currentFile || state.get('isProcessing')) {
    return;
  }

  state.patch({
    parseMethod: 'auto',
    forceOcr: false,
    timings: {
      preprocessing: 0,
      layoutAnalysis: 0,
      ocr: 0,
      formula: 0,
      table: 0,
      readingOrder: 0,
      postprocessing: 0,
      total: 0,
    },
  });

  resetStages();
  resetPostprocessingBreakdown();
  setTotalMessage(`Processing ${currentFile.name}...`);
  state.set('results', null);
  csvBtn.disabled = true;
  if (artifactsBtn) {
    artifactsBtn.disabled = true;
  }

  try {
    await pipelineAdapter.run(state);

    const results = state.get('results');
    if (!results) {
      markCurrentRunningAsError();
      setTotalMessage('Processing finished without output. Please try again.');
      return;
    }

    setTotalMessage('Processing complete.');
  } catch (err) {
    markCurrentRunningAsError();
    setTotalMessage(`Processing failed: ${err.message || err}`);
  }
}

function updateRunButtonState(isProcessing) {
  const canRun = Boolean(currentFile) && !isProcessing;
  runBtn.disabled = !canRun;
  runBtn.textContent = isProcessing ? 'Running Pipeline...' : 'Run Pipeline';
}

function setTotalMessage(message) {
  if (totalTime) {
    totalTime.textContent = message;
  }
}

function updateTotalTimeFromTimings() {
  const t = state.get('timings');
  const total = Number(
    t.total
    || (t.preprocessing + t.layoutAnalysis + t.ocr + t.formula + t.table + t.readingOrder + t.postprocessing)
    || 0
  );
  if (total > 0) {
    totalTime.textContent = `Total: ${Math.round(total)} ms`;
  }
}

function applyVisualTiming(results, visualMs) {
  const safeVisualMs = Number.isFinite(Number(visualMs)) ? Number(visualMs) : 0;
  latestVisualRenderMs = Math.max(0, safeVisualMs);
  if (safeVisualMs <= 0 || !results) {
    return;
  }

  if (!results._timingBreakdown || typeof results._timingBreakdown !== 'object') {
    results._timingBreakdown = {};
  }
  if (!results._timingBreakdown.postprocessing || typeof results._timingBreakdown.postprocessing !== 'object') {
    results._timingBreakdown.postprocessing = {};
  }

  const breakdown = results._timingBreakdown.postprocessing;
  breakdown.visual_render_ui_ms = safeVisualMs;

  const postTotal = Number(breakdown.total_ms || 0) + safeVisualMs;
  breakdown.total_ms = postTotal;

  const timings = state.get('timings');
  const nextPost = Number(timings.postprocessing || 0) + safeVisualMs;
  const nextTotal = Number(timings.total || 0) + safeVisualMs;
  state.recordTiming('postprocessing', nextPost);
  state.recordTiming('total', nextTotal);
}

function resetPostprocessingBreakdown() {
  latestVisualRenderMs = 0;
  if (postprocessingBreakdownRows) {
    postprocessingBreakdownRows.innerHTML = '';
  }
  if (postprocessingBreakdownEmpty) {
    postprocessingBreakdownEmpty.style.display = 'block';
    postprocessingBreakdownEmpty.textContent = 'Run pipeline to view detailed postprocessing timings.';
  }
}

function renderPostprocessingBreakdown(results) {
  if (!postprocessingBreakdownRows || !postprocessingBreakdownEmpty) {
    return;
  }

  const breakdown = results?._timingBreakdown?.postprocessing;
  if (!breakdown || typeof breakdown !== 'object') {
    resetPostprocessingBreakdown();
    return;
  }

  const rows = [
    ['Engine OCR postprocess', Number(breakdown.engine_postprocessing_ms || 0)],
    ['Middle JSON conversion', Number(breakdown.middle_json_ms || 0)],
    ['Markdown assembly', Number(breakdown.markdown_union_ms || 0)],
    ['Content-list assembly', Number(breakdown.content_list_union_ms || 0)],
    ['Result normalization', Number(breakdown.result_normalize_ms || 0)],
    ['Visual render (UI)', Number(breakdown.visual_render_ui_ms || 0)],
  ];

  const visibleRows = rows.filter(([, ms]) => Number.isFinite(ms) && ms >= 0);
  if (!visibleRows.length) {
    resetPostprocessingBreakdown();
    return;
  }

  const dominantMs = Math.max(...visibleRows.map(([, ms]) => ms));
  postprocessingBreakdownRows.innerHTML = visibleRows
    .map(([label, ms]) => {
      const dominantClass = dominantMs > 0 && ms === dominantMs ? ' is-dominant' : '';
      return `<div class="timing-breakdown-row${dominantClass}"><span class="timing-label">${label}</span><span class="timing-value">${Math.round(ms)} ms</span></div>`;
    })
    .join('');

  const totalMs = Number(breakdown.total_ms || visibleRows.reduce((sum, [, ms]) => sum + ms, 0));
  postprocessingBreakdownRows.insertAdjacentHTML(
    'beforeend',
    `<div class="timing-breakdown-row is-dominant"><span class="timing-label">Total postprocessing</span><span class="timing-value">${Math.round(totalMs)} ms</span></div>`,
  );

  postprocessingBreakdownEmpty.style.display = 'none';
}

function mapProcessingStageToUi(stage) {
  switch (stage) {
    case 'loading_models':
    case 'preprocessing':
      return 'preprocessing';
    case 'layout':
      return 'layout';
    case 'ocr':
      return 'ocr';
    case 'postprocessing':
      return 'assembly';
    default:
      return null;
  }
}

function getStageRow(stageName) {
  return document.querySelector(`[data-stage="${stageName}"]`);
}

function resetStages() {
  runningUiStage = null;
  for (const stage of STAGE_ORDER) {
    const row = getStageRow(stage);
    if (!row) continue;

    const bar = row.querySelector('.stage-bar');
    const time = row.querySelector('.stage-time');
    const status = row.querySelector('.stage-status');

    bar.style.width = '0%';
    bar.classList.remove('running', 'done', 'error');
    time.textContent = '-';
    status.textContent = '○';
  }
}

function setStageRunning(stageName) {
  runningUiStage = stageName;
  for (const stage of STAGE_ORDER) {
    const row = getStageRow(stage);
    if (!row) continue;

    const bar = row.querySelector('.stage-bar');
    const status = row.querySelector('.stage-status');

    if (stage === stageName) {
      bar.classList.remove('done', 'error');
      bar.classList.add('running');
      bar.style.width = '65%';
      status.textContent = '⋯';
    } else {
      bar.classList.remove('running');
    }
  }
}

function markCurrentRunningAsError() {
  if (!runningUiStage) {
    return;
  }

  const row = getStageRow(runningUiStage);
  if (!row) {
    return;
  }

  const bar = row.querySelector('.stage-bar');
  const status = row.querySelector('.stage-status');
  bar.classList.remove('running', 'done');
  bar.classList.add('error');
  status.textContent = '✗';
  runningUiStage = null;
}

function buildUiTimings() {
  const t = state.get('timings');
  const visualMs = Number(latestVisualRenderMs || 0);
  const rawPostprocessing = Number(t.postprocessing || 0);
  const assemblyPostprocessing = Math.max(0, rawPostprocessing - visualMs);

  return {
    preprocessing: Number(t.preprocessing || 0),
    layout: Number(t.layoutAnalysis || 0),
    ocr: Number(t.ocr || 0),
    formula: Number(t.formula || 0),
    table: Number(t.table || 0),
    assembly: Number(t.readingOrder || 0) + assemblyPostprocessing,
    visual: visualMs,
  };
}

function applyFinalStageTimings(timings) {
  const total = STAGE_ORDER.reduce((acc, stage) => acc + Number(timings[stage] || 0), 0);
  const formulaEnabled = Boolean(state.get('formulaEnable'));
  const tableEnabled = Boolean(state.get('tableEnable'));

  for (const stage of STAGE_ORDER) {
    const row = getStageRow(stage);
    if (!row) continue;

    const ms = Number(timings[stage] || 0);
    const bar = row.querySelector('.stage-bar');
    const time = row.querySelector('.stage-time');
    const status = row.querySelector('.stage-status');

    bar.classList.remove('running', 'error');

    const skipped = (
      (stage === 'formula' && !formulaEnabled)
      || (stage === 'table' && !tableEnabled)
    );

    if (skipped && ms <= 0) {
      bar.classList.remove('done');
      bar.style.width = '0%';
      time.textContent = '-';
      status.textContent = '—';
      continue;
    }

    bar.classList.add('done');
    bar.style.width = `${total > 0 ? ((ms / total) * 100).toFixed(2) : 0}%`;
    time.textContent = `${Math.round(ms)}ms`;
    status.textContent = '✓';
  }

  runningUiStage = null;
}

function initMarkdownTabs() {
  markdownTabs.forEach((btn) => {
    btn.addEventListener('click', () => setMarkdownMode(btn.dataset.md || 'viewer'));
  });
  setMarkdownMode('viewer');
}

function setMarkdownMode(mode) {
  currentMarkdownMode = ['raw', 'viewer'].includes(mode) ? mode : 'viewer';

  markdownTabs.forEach((btn) => {
    const active = btn.dataset.md === currentMarkdownMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  markdownCards.forEach((card) => {
    card.classList.toggle('active', card.dataset.mdCard === currentMarkdownMode);
  });
}

function renderMarkdownOutput(markdownText, imageMap = null) {
  const source = (typeof markdownText === 'string' && markdownText.trim().length > 0)
    ? markdownText
    : '(no markdown output)';

  markdownRaw.textContent = source;

  try {
    if (typeof marked !== 'undefined') {
      // Protect LaTeX blocks from being mangled by marked.parse()
      const latexBlocks = [];
      let protectedSource = source;

      // Protect display math ($$...$$) — must come before inline ($...$)
      // Use [\s\S]*? to handle multiline display formulas
      protectedSource = protectedSource.replace(/\$\$([\s\S]*?)\$\$/g, (_, latex) => {
        const idx = latexBlocks.length;
        latexBlocks.push({ latex: latex.trim(), display: true });
        return `<div class="katex-display-placeholder" data-idx="${idx}"></div>`;
      });

      // Protect inline math ($...$)
      // Use [\s\S]*? to handle formulas that span lines, but require non-empty content
      // Negative lookahead prevents matching $$ (already handled above)
      protectedSource = protectedSource.replace(/(?<!\$)\$(?!\$)([\s\S]+?)(?<!\$)\$(?!\$)/g, (_, latex) => {
        const trimmed = latex.trim();
        if (!trimmed) return `$${latex}$`; // empty — skip
        const idx = latexBlocks.length;
        latexBlocks.push({ latex: trimmed, display: false });
        return `<span class="katex-inline-placeholder" data-idx="${idx}"></span>`;
      });

      markdownViewer.innerHTML = marked.parse(protectedSource);

      // Render each LaTeX placeholder with KaTeX
      if (typeof katex !== 'undefined') {
        // Macros for common model output typos / non-standard commands
        const macros = {
          '\\rmathrm': '\\mathrm',
          '\\rmath': '\\mathrm',
          '\\mbox': '\\text',
        };

        for (const el of markdownViewer.querySelectorAll('[data-idx]')) {
          const block = latexBlocks[parseInt(el.dataset.idx)];
          if (!block) continue;
          try {
            el.innerHTML = katex.renderToString(block.latex, {
              displayMode: block.display,
              throwOnError: false,
              strict: false,
              trust: true,
              macros,
            });
          } catch {
            // Fallback: show as code block, not red error text
            const code = document.createElement('code');
            code.style.cssText = 'background:rgba(0,0,0,.05);padding:2px 4px;border-radius:3px;font-size:.9em;';
            code.textContent = block.display ? `$$${block.latex}$$` : `$${block.latex}$`;
            el.replaceWith(code);
          }
        }
      }

      applyMarkdownImageSources(imageMap);
    } else {
      markdownViewer.textContent = source;
    }
  } catch {
    markdownViewer.textContent = source;
  }
}

function applyMarkdownImageSources(imageMap) {
  if (!markdownViewer || !imageMap) return;
  const lookup = buildImageLookup(imageMap);
  if (!lookup.size) return;

  for (const img of markdownViewer.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (!src || /^(https?:|data:|blob:)/i.test(src)) continue;
    const clean = normalizeImageKey(src);
    const direct = lookup.get(clean)
      || lookup.get(clean.replace(/^images\//, ''))
      || lookup.get(`images/${clean}`);
    if (direct) img.src = direct;
  }
}

function buildImageLookup(imageMap) {
  const lookup = new Map();
  const entries = imageMap instanceof Map
    ? imageMap.entries()
    : Object.entries(imageMap);

  for (const [key, value] of entries) {
    if (typeof value !== 'string') continue;
    const clean = normalizeImageKey(key);
    if (!clean) continue;
    lookup.set(clean, value);
    if (!clean.startsWith('images/')) {
      lookup.set(`images/${clean}`, value);
    }
  }
  return lookup;
}

function normalizeImageKey(value) {
  return String(value || '').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function initVisualTabs() {
  for (const btn of visualTabs) {
    btn.addEventListener('click', () => setVisualMode(btn.dataset.visual || 'layout'));
  }
  setVisualMode('layout');
}

function setVisualMode(mode) {
  const normalized = ['layout', 'reading', 'ocr'].includes(mode) ? mode : 'layout';

  for (const btn of visualTabs) {
    const active = btn.dataset.visual === normalized;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }

  for (const card of visualCards) {
    const key = card.dataset.visualCard;
    const active = key === normalized;
    card.classList.toggle('active', active);
  }

  updateVisualZoomUi();
}

function initInlineVisualInteractions() {
  for (const item of VISUAL_ITEMS) {
    const wrap = visualWraps.get(item.key);
    const canvas = item.canvas;
    if (!wrap || !canvas) {
      continue;
    }

    wrap.addEventListener('click', (event) => handleInlineVisualClick(item.key, event));
    wrap.addEventListener('pointerdown', (event) => startInlinePan(item.key, event));
    wrap.addEventListener('pointermove', (event) => moveInlinePan(item.key, event));
    wrap.addEventListener('pointerup', (event) => endInlinePan(item.key, event));
    wrap.addEventListener('pointercancel', (event) => endInlinePan(item.key, event));
  }

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    const active = getActiveVisualKey();
    if (active) {
      resetInlineZoomByTab(active);
    }
  });
}

function handleInlineVisualClick(key, event) {
  const item = getVisualItemByKey(key);
  const state = visualStates.get(key);
  if (!item || !state) {
    return;
  }

  if (Date.now() < state.suppressClickUntil) {
    return;
  }

  const next = getNextZoomLevel(getTabZoom(item.tab));
  setInlineZoomByTab(item.tab, next, event);
}

function setInlineZoomByTab(tab, zoom, anchorEvent = null) {
  const target = clamp(zoom, ZOOM_LEVELS[0], ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
  for (const item of VISUAL_ITEMS) {
    if (item.tab !== tab) {
      continue;
    }
    const state = visualStates.get(item.key);
    if (!state) {
      continue;
    }
    const prevZoom = state.zoom;
    state.zoom = target;
    applyInlineVisualTransform(item.key, anchorEvent, prevZoom);
  }
  updateVisualZoomUi();
}

function resetInlineZoomByTab(tab) {
  setInlineZoomByTab(tab, 1);
}

function resetAllInlineZoom() {
  for (const item of VISUAL_ITEMS) {
    const state = visualStates.get(item.key);
    if (!state) {
      continue;
    }
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    state.pointerId = null;
    state.pointerDown = false;
    state.dragging = false;
    state.startPanX = 0;
    state.startPanY = 0;
    state.suppressClickUntil = 0;
    applyInlineVisualTransform(item.key, null, state.zoom);

    const wrap = visualWraps.get(item.key);
    wrap?.classList.remove('is-pointer-down');
    wrap?.classList.remove('dragging');
  }
  updateVisualZoomUi();
}

function applyInlineVisualTransform(key, pointEvent = null, prevZoom = null) {
  const wrap = visualWraps.get(key);
  const canvas = getVisualItemByKey(key)?.canvas;
  const state = visualStates.get(key);
  if (!wrap || !canvas || !state) {
    return;
  }

  const zoom = clamp(state.zoom ?? 1, ZOOM_LEVELS[0], ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
  const baseSize = getInlineCanvasBaseSize(key, canvas, wrap);
  const baseW = baseSize.width;
  const baseH = baseSize.height;

  if (zoom <= 1.001) {
    canvas.style.width = '';
    canvas.style.height = '';
    canvas.style.transform = '';
    canvas.style.transformOrigin = '';
    state.panX = 0;
    state.panY = 0;
    wrap.scrollLeft = 0;
    wrap.scrollTop = 0;
    wrap.classList.remove('is-zoomed');
    wrap.classList.remove('is-pannable');
    return;
  }

  canvas.style.width = `${Math.round(baseW)}px`;
  canvas.style.height = `${Math.round(baseH)}px`;
  canvas.style.transformOrigin = '50% 50%';
  const panLimits = getPanLimits(baseW, baseH, zoom, wrap.clientWidth, wrap.clientHeight);
  const canPan = panLimits.maxX > 0 || panLimits.maxY > 0;

  if (!canPan) {
    state.panX = 0;
    state.panY = 0;
  } else {
    if (pointEvent && prevZoom && prevZoom > 0) {
      const wrapRect = wrap.getBoundingClientRect();
      const anchorX = pointEvent.clientX - wrapRect.left - (wrapRect.width / 2);
      const anchorY = pointEvent.clientY - wrapRect.top - (wrapRect.height / 2);
      const zoomRatio = zoom / prevZoom;
      state.panX = (state.panX ?? 0) * zoomRatio + (anchorX * (1 - zoomRatio));
      state.panY = (state.panY ?? 0) * zoomRatio + (anchorY * (1 - zoomRatio));
    }

    state.panX = clamp(state.panX ?? 0, -panLimits.maxX, panLimits.maxX);
    state.panY = clamp(state.panY ?? 0, -panLimits.maxY, panLimits.maxY);
  }

  canvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${zoom})`;
  wrap.classList.add('is-zoomed');
  wrap.classList.toggle('is-pannable', canPan);
  wrap.scrollLeft = 0;
  wrap.scrollTop = 0;
  clampWrapScroll(wrap);
}

function getPanLimits(baseW, baseH, zoom, wrapW, wrapH) {
  const scaledW = baseW * zoom;
  const scaledH = baseH * zoom;
  return {
    maxX: Math.max(0, (scaledW - wrapW) / 2),
    maxY: Math.max(0, (scaledH - wrapH) / 2),
  };
}

function getInlineCanvasBaseSize(key, canvas, wrap) {
  const intrinsicW = Math.max(1, canvas.width || VISUAL_PLACEHOLDER.width);
  const intrinsicH = Math.max(1, canvas.height || VISUAL_PLACEHOLDER.height);
  const maxHeight = getCanvasMaxHeightForKey(key);
  const availableWidth = Math.max(1, wrap.clientWidth - 12);

  const fitScale = Math.min(1, maxHeight / intrinsicH, availableWidth / intrinsicW);

  return {
    width: Math.max(1, intrinsicW * fitScale),
    height: Math.max(1, intrinsicH * fitScale),
  };
}

function getCanvasMaxHeightForKey(key) {
  const isMobile = window.matchMedia('(max-width: 980px)').matches;
  if (key === 'ocr-overlay' || key === 'ocr-rewrite') {
    return isMobile ? OCR_CANVAS_MAX_HEIGHT_MOBILE : OCR_CANVAS_MAX_HEIGHT_DESKTOP;
  }
  return isMobile ? VISUAL_CANVAS_MAX_HEIGHT_MOBILE : VISUAL_CANVAS_MAX_HEIGHT_DESKTOP;
}

function startInlinePan(key, event) {
  if (event.button !== 0 && event.pointerType === 'mouse') {
    return;
  }

  const item = getVisualItemByKey(key);
  const state = visualStates.get(key);
  const wrap = visualWraps.get(key);
  if (!item || !state || !wrap || state.zoom <= 1.001 || !wrap.classList.contains('is-pannable')) {
    return;
  }

  state.pointerId = event.pointerId;
  state.pointerDown = true;
  state.dragging = false;
  state.startX = event.clientX;
  state.startY = event.clientY;
  state.startPanX = state.panX ?? 0;
  state.startPanY = state.panY ?? 0;

  wrap.setPointerCapture(event.pointerId);
  wrap.classList.add('is-pointer-down');
}

function moveInlinePan(key, event) {
  const item = getVisualItemByKey(key);
  const state = visualStates.get(key);
  const wrap = visualWraps.get(key);
  if (!item || !state || !wrap || !state.pointerDown || state.pointerId !== event.pointerId) {
    return;
  }

  const dx = event.clientX - state.startX;
  const dy = event.clientY - state.startY;

  if (!state.dragging && (Math.abs(dx) >= PAN_DRAG_THRESHOLD || Math.abs(dy) >= PAN_DRAG_THRESHOLD)) {
    state.dragging = true;
  }
  if (!state.dragging) {
    return;
  }

  setTabClass(item.tab, 'dragging', true);
  setTabPan(item.tab, state.startPanX + dx, state.startPanY + dy);
  event.preventDefault();
}

function endInlinePan(key, event) {
  const item = getVisualItemByKey(key);
  const state = visualStates.get(key);
  const wrap = visualWraps.get(key);
  if (!item || !state || !wrap || state.pointerId !== event.pointerId) {
    return;
  }

  if (state.dragging) {
    setTabSuppressClick(item.tab, Date.now() + 180);
  }

  state.pointerId = null;
  state.pointerDown = false;
  state.dragging = false;
  setTabClass(item.tab, 'dragging', false);
  setTabClass(item.tab, 'is-pointer-down', false);

  if (wrap.hasPointerCapture(event.pointerId)) {
    wrap.releasePointerCapture(event.pointerId);
  }
}

function getTabZoom(tab) {
  let zoom = 1;
  for (const item of VISUAL_ITEMS) {
    if (item.tab !== tab) {
      continue;
    }
    zoom = Math.max(zoom, visualStates.get(item.key)?.zoom ?? 1);
  }
  return zoom;
}

function getNextZoomLevel(currentZoom) {
  for (const level of ZOOM_LEVELS) {
    if (level > (currentZoom + 0.01)) {
      return level;
    }
  }
  return ZOOM_LEVELS[0];
}

function getVisualItemByKey(key) {
  return VISUAL_ITEMS.find((item) => item.key === key) ?? null;
}

function setTabPan(tab, panX, panY) {
  for (const item of VISUAL_ITEMS) {
    if (item.tab !== tab) {
      continue;
    }
    const wrap = visualWraps.get(item.key);
    const canvas = item.canvas;
    const state = visualStates.get(item.key);
    if (!wrap || !canvas || !state) {
      continue;
    }

    const baseSize = getInlineCanvasBaseSize(item.key, canvas, wrap);
    const limits = getPanLimits(baseSize.width, baseSize.height, state.zoom ?? 1, wrap.clientWidth, wrap.clientHeight);

    state.panX = clamp(panX, -limits.maxX, limits.maxX);
    state.panY = clamp(panY, -limits.maxY, limits.maxY);
    canvas.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom ?? 1})`;
  }
}

function setTabClass(tab, className, enabled) {
  for (const item of VISUAL_ITEMS) {
    if (item.tab !== tab) {
      continue;
    }
    const wrap = visualWraps.get(item.key);
    if (!wrap) {
      continue;
    }
    wrap.classList.toggle(className, enabled);
  }
}

function setTabSuppressClick(tab, until) {
  for (const item of VISUAL_ITEMS) {
    if (item.tab !== tab) {
      continue;
    }
    const state = visualStates.get(item.key);
    if (!state) {
      continue;
    }
    state.suppressClickUntil = until;
  }
}

function clampWrapScroll(wrap) {
  const maxX = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
  const maxY = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
  wrap.scrollLeft = clamp(wrap.scrollLeft, 0, maxX);
  wrap.scrollTop = clamp(wrap.scrollTop, 0, maxY);
}

function updateVisualZoomUi() {
  const active = getActiveVisualKey();
  const zoom = active ? getTabZoom(active) : 1;
  const isZoomed = zoom > 1.001;

  if (visualResetZoomBtn) {
    visualResetZoomBtn.disabled = !isZoomed;
  }

  if (visualZoomHint) {
    visualZoomHint.textContent = isZoomed
      ? `Zoom ${Math.round(zoom * 100)}%. Drag to pan. Press Esc or Reset Zoom to return.`
      : 'Click image to zoom in. Click again or Reset Zoom to zoom out.';
  }
}

function getActiveVisualKey() {
  const active = visualCards.find((card) => card.classList.contains('active'));
  return active?.dataset.visualCard || 'layout';
}

async function renderVisualOutputs(results) {
  const t0 = performance.now();
  const payload = resolveLayoutVisualPayload(results);
  resetAllInlineZoom();

  const base = await createBaseVisualCanvas(currentFile, payload.pageInfo);
  if (!base) {
    resetVisualOutputs('No visual base canvas available.', true);
    return 0;
  }

  const srcW = Number(payload.pageInfo?.width);
  const srcH = Number(payload.pageInfo?.height);
  const scaleX = Number.isFinite(srcW) && srcW > 0 ? base.width / srcW : 1;
  const scaleY = Number.isFinite(srcH) && srcH > 0 ? base.height / srcH : 1;

  drawLayoutDetection(base, payload.layoutDets, scaleX, scaleY);
  drawReadingOrder(base, payload.layoutDets, payload.readingOrder, scaleX, scaleY);
  drawOcr(base, payload.ocr, payload.layoutDets, scaleX, scaleY);

  return performance.now() - t0;
}

async function createBaseVisualCanvas(file, pageInfo = null) {
  if (file && isImageFile(file)) {
    const arrayBuffer = await file.arrayBuffer();
    return decodeImageToCanvas(arrayBuffer);
  }

  if (sourceCanvas && sourceCanvas.width > 0 && sourceCanvas.height > 0) {
    const canvas = document.createElement('canvas');
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0);
    return canvas;
  }

  const w = Math.max(1, Number(pageInfo?.width) || VISUAL_PLACEHOLDER.width);
  const h = Math.max(1, Number(pageInfo?.height) || VISUAL_PLACEHOLDER.height);
  const fallback = document.createElement('canvas');
  fallback.width = w;
  fallback.height = h;
  const ctx = fallback.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  return fallback;
}

function resolveFirstModelPage(results) {
  const modelOutput = results?.model_output;
  if (Array.isArray(modelOutput) && modelOutput.length > 0) {
    return modelOutput[0] || null;
  }
  if (Array.isArray(modelOutput?.pages) && modelOutput.pages.length > 0) {
    return modelOutput.pages[0] || null;
  }
  return null;
}

function normalizeOcrPayload(rawOcr) {
  if (!rawOcr || typeof rawOcr !== 'object') {
    return { boxes: [], texts: [] };
  }

  const boxes = Array.isArray(rawOcr.boxes) ? rawOcr.boxes : [];
  const texts = Array.isArray(rawOcr.texts) ? rawOcr.texts : [];
  if (!boxes.length || !texts.length) {
    return { boxes: [], texts: [] };
  }

  return { boxes, texts };
}

function buildOcrFromLayoutDets(layoutDets) {
  const boxes = [];
  const texts = [];

  for (const det of Array.isArray(layoutDets) ? layoutDets : []) {
    const text = String(det?.text ?? '').trim();
    if (!text) continue;

    const box = det?.polygon_points ?? det?.polygonPoints ?? det?.polygon ?? det?.coordinate ?? det?.bbox;
    if (!Array.isArray(box) || box.length < 4) continue;

    boxes.push(box);
    texts.push(text);
  }

  return { boxes, texts };
}

function buildOcrFromMiddleBlocks(preprocBlocks) {
  const boxes = [];
  const texts = [];

  for (const block of Array.isArray(preprocBlocks) ? preprocBlocks : []) {
    const lines = Array.isArray(block?.lines) ? block.lines : [];
    for (const line of lines) {
      const spans = Array.isArray(line?.spans) ? line.spans : [];
      for (const span of spans) {
        const text = String(span?.content ?? '').trim();
        const bbox = span?.bbox ?? line?.bbox ?? block?.bbox;
        if (!text || !Array.isArray(bbox) || bbox.length < 4) continue;
        boxes.push(bbox);
        texts.push(text);
      }
    }
  }

  return { boxes, texts };
}

function resolveLayoutVisualPayload(results) {
  const middle = results?.middle_json || null;
  const firstPdfInfo = Array.isArray(middle?.pdf_info) ? middle.pdf_info[0] : null;
  const firstModelPage = resolveFirstModelPage(results);

  const layoutDetsRaw = firstPdfInfo?.layout_dets
    || firstModelPage?.layout_dets
    || middle?.layout_dets
    || results?.layout_dets
    || [];

  const readingOrder = firstPdfInfo?.layout_reading_order
    || firstModelPage?.layout_reading_order
    || middle?.layout_reading_order
    || [];

  const directOcr = normalizeOcrPayload(
    firstPdfInfo?.ocr
    || firstModelPage?.ocr
    || middle?.ocr
    || null,
  );
  const ocrFromLayout = buildOcrFromLayoutDets(layoutDetsRaw);
  const ocrFromMiddle = buildOcrFromMiddleBlocks(firstPdfInfo?.preproc_blocks || middle?.preproc_blocks || []);
  const ocr = directOcr.boxes.length
    ? directOcr
    : (ocrFromLayout.boxes.length ? ocrFromLayout : ocrFromMiddle);

  const pageInfo = firstPdfInfo?.page_info
    || firstModelPage?.page_info
    || middle?.page_info
    || results?.page_info
    || { width: sourceCanvas?.width || 0, height: sourceCanvas?.height || 0 };

  const nativeLayout = buildNativeLayoutVisualItems(firstPdfInfo);
  const pageWidth = Number(pageInfo?.width || sourceCanvas?.width || 0);
  const pageHeight = Number(pageInfo?.height || sourceCanvas?.height || 0);
  const layoutDets = nativeLayout.length
    ? nativeLayout
    : buildCoarseLayoutDetections(layoutDetsRaw, pageWidth, pageHeight);

  return {
    layoutDets,
    readingOrder: resolveReadingOrder(readingOrder, layoutDets),
    ocr: ocr && typeof ocr === 'object' ? ocr : {},
    pageInfo,
  };
}

function buildNativeLayoutVisualItems(pageInfo) {
  if (!pageInfo || typeof pageInfo !== 'object') {
    return [];
  }

  const items = [];
  let readingRank = 0;

  const pushItem = (source, {
    fallbackType = 'region',
    isDiscarded = false,
    isAuxiliary = false,
    includeInReading = false,
  } = {}) => {
    const bbox = source?.bbox;
    if (!Array.isArray(bbox) || bbox.length < 4) {
      return;
    }

    const label = String(
      source?.type
      ?? source?.original_label
      ?? source?.label
      ?? fallbackType,
    ).toLowerCase();

    const item = {
      ...source,
      coordinate: bbox,
      bbox,
      original_label: source?.original_label ?? label,
      label,
      polygon_points: source?.polygon_points ?? null,
      __nativeDiscarded: Boolean(isDiscarded),
      __nativeAuxiliary: Boolean(isAuxiliary),
      __nativeReadingOrder: null,
    };

    if (includeInReading) {
      readingRank += 1;
      item.__nativeReadingOrder = readingRank;
    }

    items.push(item);
  };

  const discardedBlocks = Array.isArray(pageInfo?.discarded_blocks) ? pageInfo.discarded_blocks : [];
  for (const dropped of discardedBlocks) {
    pushItem(dropped, {
      fallbackType: 'discarded',
      isDiscarded: true,
      includeInReading: false,
    });
  }

  const paraBlocks = Array.isArray(pageInfo?.para_blocks) ? pageInfo.para_blocks : [];
  for (const block of paraBlocks) {
    const type = String(block?.type ?? '').toLowerCase();

    if (NATIVE_LAYOUT_PRIMARY_TYPES.has(type)) {
      pushItem(block, {
        fallbackType: type || 'region',
        includeInReading: true,
      });

      if (type === 'list' && Array.isArray(block?.blocks)) {
        for (const subBlock of block.blocks) {
          pushItem(subBlock, {
            fallbackType: String(subBlock?.type ?? 'list_item').toLowerCase(),
            isAuxiliary: true,
            includeInReading: false,
          });
        }
      }
      continue;
    }

    if (!NATIVE_LAYOUT_CONTAINER_TYPES.has(type)) {
      continue;
    }

    const subBlocksRaw = Array.isArray(block?.blocks) ? block.blocks : [];
    const subBlocks = type === 'table'
      ? [...subBlocksRaw].sort((a, b) => {
        const aa = NATIVE_LAYOUT_TABLE_TYPE_ORDER[String(a?.type ?? '').toLowerCase()] ?? 999;
        const bb = NATIVE_LAYOUT_TABLE_TYPE_ORDER[String(b?.type ?? '').toLowerCase()] ?? 999;
        return aa - bb;
      })
      : subBlocksRaw;

    for (const subBlock of subBlocks) {
      if (type === 'table' && subBlock?.cross_page) {
        continue;
      }

      pushItem(subBlock, {
        fallbackType: String(subBlock?.type ?? type).toLowerCase(),
        includeInReading: true,
      });

      if (type === 'table') {
        const lines = Array.isArray(subBlock?.lines) ? subBlock.lines : [];
        for (const line of lines) {
          const spans = Array.isArray(line?.spans) ? line.spans : [];
          for (const span of spans) {
            const imgBoxes = Array.isArray(span?.img_boxes) ? span.img_boxes : [];
            for (const box of imgBoxes) {
              pushItem({ bbox: box, type: 'table_inner_image' }, {
                fallbackType: 'table_inner_image',
                isAuxiliary: true,
                includeInReading: false,
              });
            }

            const latexBoxes = Array.isArray(span?.latex_boxes) ? span.latex_boxes : [];
            for (const box of latexBoxes) {
              pushItem({ bbox: box, type: 'table_inner_formula' }, {
                fallbackType: 'table_inner_formula',
                isAuxiliary: true,
                includeInReading: false,
              });
            }
          }
        }
      }
    }
  }

  return items;
}

function resolveReadingOrder(readingOrder, layoutDets) {
  const total = Array.isArray(layoutDets) ? layoutDets.length : 0;
  if (total <= 0) return [];

  const nativeSequence = [];
  for (let i = 0; i < layoutDets.length; i += 1) {
    const rank = Number(layoutDets[i]?.__nativeReadingOrder);
    if (Number.isFinite(rank) && rank > 0) {
      nativeSequence.push({ idx: i, rank });
    }
  }
  if (nativeSequence.length > 0) {
    nativeSequence.sort((a, b) => a.rank - b.rank);
    return nativeSequence.map((entry) => entry.idx);
  }

  const localIndexByOriginal = new Map();
  layoutDets.forEach((det, idx) => {
    const origin = Number(det?.__originIndex);
    if (Number.isInteger(origin)) {
      localIndexByOriginal.set(origin, idx);
    }
  });

  const sequence = [];
  const used = new Set();
  const rawOrder = (Array.isArray(readingOrder) ? readingOrder : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value));
  const oneBased = rawOrder.length > 0
    && rawOrder.every((value) => value >= 1 && value <= total)
    && !rawOrder.includes(0);

  for (const idx of rawOrder) {
    const originIndex = oneBased ? idx - 1 : idx;
    const normalized = localIndexByOriginal.has(originIndex)
      ? Number(localIndexByOriginal.get(originIndex))
      : originIndex;
    if (!Number.isInteger(normalized) || normalized < 0 || normalized >= total || used.has(normalized)) continue;
    used.add(normalized);
    sequence.push(normalized);
  }

  const byOrder = [];
  layoutDets.forEach((det, idx) => {
    const order = Number(det?.order ?? det?.reading_order ?? det?.original_order);
    if (Number.isFinite(order)) {
      byOrder.push({ idx, order });
    }
  });
  byOrder.sort((a, b) => a.order - b.order);
  byOrder.forEach(({ idx }) => {
    if (!used.has(idx)) {
      used.add(idx);
      sequence.push(idx);
    }
  });

  for (let i = 0; i < total; i += 1) {
    if (!used.has(i)) sequence.push(i);
  }

  return sequence;
}

function resetVisualOutputs(message, isError = false) {
  setVisualMeta(layoutMeta, message, isError);
  setVisualMeta(readingOrderMeta, message, isError);
  setVisualMeta(ocrMeta, message, isError);

  paintVisualPlaceholder(layoutDetectionCanvas, 'Layout Detection');
  paintVisualPlaceholder(readingOrderCanvas, 'Reading Order');
  paintVisualPlaceholder(ocrOverlayCanvas, 'OCR Overlay');
  paintVisualPlaceholder(ocrRewriteCanvas, 'OCR Rewrite');

  resetAllInlineZoom();
}

function setVisualMeta(el, text, isError = false) {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', Boolean(isError));
}

function paintVisualPlaceholder(canvas, title) {
  if (!canvas) return;

  canvas.width = VISUAL_PLACEHOLDER.width;
  canvas.height = VISUAL_PLACEHOLDER.height;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#30363d';
  ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);

  ctx.fillStyle = '#8b949e';
  ctx.textAlign = 'center';
  ctx.font = '600 18px "IBM Plex Mono", "Courier New", monospace';
  ctx.fillText(title, canvas.width / 2, canvas.height / 2 - 4);
  ctx.font = '400 12px "IBM Plex Mono", "Courier New", monospace';
  ctx.fillText('Waiting for visual data', canvas.width / 2, canvas.height / 2 + 18);
}

function initVisualCanvas(targetCanvas, baseCanvas, blankColor = null) {
  if (!targetCanvas || !baseCanvas) return null;
  targetCanvas.width = baseCanvas.width;
  targetCanvas.height = baseCanvas.height;

  const ctx = targetCanvas.getContext('2d');
  if (!ctx) return null;

  if (blankColor) {
    ctx.fillStyle = blankColor;
    ctx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
  } else {
    ctx.drawImage(baseCanvas, 0, 0);
  }

  return ctx;
}

async function decodeImageToCanvas(arrayBuffer) {
  const bitmap = await createImageBitmap(new Blob([arrayBuffer]));
  const ratio = Math.min(1, VISUAL_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * ratio));
  const height = Math.max(1, Math.round(bitmap.height * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas;
}

function normalizePolygon(box, scaleX, scaleY) {
  if (!Array.isArray(box) || box.length < 4) return null;
  if (box.length === 4 && box.every((v) => Number.isFinite(Number(v)))) {
    const [x1, y1, x2, y2] = box.map(Number);
    return [
      [x1 * scaleX, y1 * scaleY],
      [x2 * scaleX, y1 * scaleY],
      [x2 * scaleX, y2 * scaleY],
      [x1 * scaleX, y2 * scaleY],
    ];
  }

  const points = [];
  for (const point of box) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push([x * scaleX, y * scaleY]);
  }

  return points.length >= 3 ? points : null;
}

function normalizeRect(coord) {
  if (!Array.isArray(coord) || coord.length < 4) {
    return null;
  }

  if (coord.length === 4 && coord.every((v) => Number.isFinite(Number(v)))) {
    const x1 = Number(coord[0]);
    const y1 = Number(coord[1]);
    const x2 = Number(coord[2]);
    const y2 = Number(coord[3]);
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  }

  const xs = [];
  const ys = [];
  for (const p of coord) {
    if (!Array.isArray(p) || p.length < 2) {
      continue;
    }
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    xs.push(x);
    ys.push(y);
  }

  if (!xs.length || !ys.length) {
    return null;
  }

  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function polygonBounds(points) {
  if (!Array.isArray(points) || points.length < 3) return null;

  const xs = points.map((pt) => Number(pt[0])).filter(Number.isFinite);
  const ys = points.map((pt) => Number(pt[1])).filter(Number.isFinite);

  if (!xs.length || !ys.length) return null;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function polygonCenter(points, fallbackBounds = null) {
  if (Array.isArray(points) && points.length) {
    let sx = 0;
    let sy = 0;
    let count = 0;

    for (const pt of points) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const x = Number(pt[0]);
      const y = Number(pt[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      sx += x;
      sy += y;
      count += 1;
    }

    if (count > 0) return [sx / count, sy / count];
  }

  const bounds = fallbackBounds || polygonBounds(points);
  if (!bounds) return [0, 0];
  return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
}

function tracePolygonPath(ctx, polygon) {
  if (!ctx || !Array.isArray(polygon) || polygon.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(polygon[0][0], polygon[0][1]);
  for (let i = 1; i < polygon.length; i += 1) {
    ctx.lineTo(polygon[i][0], polygon[i][1]);
  }
  ctx.closePath();
}

function drawLabelChip(ctx, text, x, y, bgColor) {
  const label = String(text || '').slice(0, 56);
  ctx.font = '12px "IBM Plex Mono", "Courier New", monospace';
  const metrics = ctx.measureText(label);
  const padding = 4;
  const w = metrics.width + padding * 2;
  const h = 18;
  const px = Math.max(0, x);
  const py = Math.max(0, y - h - 2);

  ctx.fillStyle = bgColor;
  ctx.fillRect(px, py, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, px + padding, py + h / 2);
}

function drawOrderBadge(ctx, order, x, y, color) {
  const label = String(order);
  ctx.font = 'bold 12px "IBM Plex Mono", "Courier New", monospace';
  const metrics = ctx.measureText(label);
  const r = Math.max(9, (metrics.width + 8) / 2);
  const cx = Math.max(r + 2, x + r + 2);
  const cy = Math.max(r + 2, y + r + 2);

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.fillStyle = '#0d1117';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy + 0.5);
  ctx.textAlign = 'left';
}

function labelColor(label, seed = 0) {
  const text = String(label ?? 'region').toLowerCase();
  const hex = pickPpStructureColor(text, seed);
  const rgb = hexToRgb(hex);

  return {
    withAlpha(alpha = 1) {
      return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamp(alpha, 0, 1)})`;
    },
  };
}

function pickPpStructureColor(label, seed) {
  for (const [key, value] of Object.entries(PPSTRUCTURE_LABEL_COLORS)) {
    if (label.includes(key)) {
      return value;
    }
  }

  const idx = Math.abs(hashText(`${label}-${seed}`)) % PPSTRUCTURE_FALLBACK_COLORS.length;
  return PPSTRUCTURE_FALLBACK_COLORS[idx];
}

function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function hexToRgb(hex) {
  const value = String(hex ?? '#5aa9ff').replace('#', '').trim();
  const expanded = value.length === 3
    ? `${value[0]}${value[0]}${value[1]}${value[1]}${value[2]}${value[2]}`
    : value;
  const num = Number.parseInt(expanded, 16);

  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function normalizeLayoutPolygon(det, scaleX, scaleY) {
  const source = det?.polygon_points ?? det?.polygonPoints ?? det?.polygon ?? det?.coordinate ?? det?.bbox;
  const polygon = normalizePolygon(source, scaleX, scaleY);
  if (!polygon || polygon.length < 3) {
    return null;
  }
  return polygon;
}

function drawLayoutDetection(baseCanvas, layoutDets, scaleX, scaleY) {
  const ctx = initVisualCanvas(layoutDetectionCanvas, baseCanvas);
  if (!ctx) return;

  let count = 0;

  for (const det of layoutDets) {
    const polygon = normalizeLayoutPolygon(det, scaleX, scaleY);
    if (!polygon || polygon.length < 3) continue;

    const bounds = polygonBounds(polygon);
    if (!bounds) continue;

    count += 1;

    const regionLabel = String(det?.original_label ?? det?.label ?? det?.category_name ?? 'region');
    const isDiscarded = Boolean(det?.__nativeDiscarded);
    const isAuxiliary = Boolean(det?.__nativeAuxiliary);

    const color = isDiscarded
      ? { withAlpha: (alpha = 1) => `rgba(158, 158, 158, ${clamp(alpha, 0, 1)})` }
      : labelColor(regionLabel, count);
    const score = Number(det?.score ?? 0);
    const scoreText = score > 0 ? ` ${score.toFixed(2)}` : '';
    const label = `${regionLabel}${scoreText}`;

    tracePolygonPath(ctx, polygon);
    ctx.fillStyle = color.withAlpha(isDiscarded ? 0.18 : (isAuxiliary ? 0.06 : 0.14));
    ctx.strokeStyle = color.withAlpha(isAuxiliary ? 0.7 : 1);
    ctx.lineWidth = isAuxiliary ? 1 : 2;
    ctx.fill();
    ctx.stroke();

    const boxWidth = bounds[2] - bounds[0];
    const boxHeight = bounds[3] - bounds[1];
    if (!isAuxiliary && boxWidth >= 36 && boxHeight >= 14) {
      drawLabelChip(ctx, label, bounds[0], bounds[1], color.withAlpha(0.95));
    }
  }

  setVisualMeta(layoutMeta, `${count} regions`);
}

function drawReadingOrder(baseCanvas, layoutDets, sequence, scaleX, scaleY) {
  const ctx = initVisualCanvas(readingOrderCanvas, baseCanvas);
  if (!ctx) return;

  const centers = [];

  for (let rank = 0; rank < sequence.length; rank += 1) {
    const idx = sequence[rank];
    const det = layoutDets[idx];
    const polygon = normalizeLayoutPolygon(det, scaleX, scaleY);
    if (!polygon || polygon.length < 3) continue;

    const bounds = polygonBounds(polygon);
    if (!bounds) continue;

    const hue = Math.round((rank / Math.max(1, sequence.length)) * 260);
    const stroke = `hsla(${hue}, 90%, 65%, 0.98)`;
    const fill = `hsla(${hue}, 90%, 60%, 0.16)`;

    tracePolygonPath(ctx, polygon);
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();

    drawOrderBadge(ctx, rank + 1, bounds[0], bounds[1], stroke);

    centers.push(polygonCenter(polygon, bounds));
  }

  if (centers.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(centers[0][0], centers[0][1]);
    for (let i = 1; i < centers.length; i += 1) {
      ctx.lineTo(centers[i][0], centers[i][1]);
    }

    ctx.setLineDash([8, 5]);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.52)';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(45,212,191,0.9)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  setVisualMeta(readingOrderMeta, `${sequence.length} ordered blocks`);
}

function normalizeLayoutLabel(value) {
  return String(value ?? '').toLowerCase().trim();
}

function rectArea(rect) {
  return Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]);
}

function rectIntersectionArea(a, b) {
  const w = intersectionLength(a[0], a[2], b[0], b[2]);
  const h = intersectionLength(a[1], a[3], b[1], b[3]);
  return w * h;
}

function rectIou(a, b) {
  const inter = rectIntersectionArea(a, b);
  if (inter <= 0) {
    return 0;
  }

  const union = rectArea(a) + rectArea(b) - inter;
  if (union <= 0) {
    return 0;
  }
  return inter / union;
}

function buildCoarseLayoutDetections(layoutDets, pageWidth, pageHeight) {
  const source = Array.isArray(layoutDets) ? layoutDets : [];
  if (!source.length) {
    return [];
  }

  const safePageWidth = Math.max(1, Number(pageWidth) || 1);
  const safePageHeight = Math.max(1, Number(pageHeight) || 1);
  const pageArea = safePageWidth * safePageHeight;
  const coarse = [];

  for (let idx = 0; idx < source.length; idx += 1) {
    const det = source[idx];
    const rect = normalizeRect(det?.coordinate ?? det?.polygon_points ?? det?.polygon ?? det?.bbox);
    if (!rect) {
      continue;
    }

    const width = Math.max(1, rect[2] - rect[0]);
    const height = Math.max(1, rect[3] - rect[1]);
    const area = width * height;
    const areaRatio = area / pageArea;
    if (areaRatio < LAYOUT_VISUAL_MIN_AREA_RATIO) {
      continue;
    }

    const label = normalizeLayoutLabel(det?.original_label ?? det?.label ?? det?.category_name);
    const isTextLike = DENSE_TEXT_LAYOUT_LABELS.has(label) || label.includes('text') || label.includes('caption');
    if (isTextLike) {
      const heightRatio = height / safePageHeight;
      const aspect = width / Math.max(1, height);
      if (
        areaRatio < LAYOUT_VISUAL_MIN_TEXT_AREA_RATIO
        || heightRatio < LAYOUT_VISUAL_MIN_TEXT_HEIGHT_RATIO
        || aspect > LAYOUT_VISUAL_MAX_TEXT_ASPECT_RATIO
      ) {
        continue;
      }
    }

    coarse.push({
      ...det,
      __originIndex: idx,
      __visualRect: rect,
      __visualArea: area,
    });
  }

  const deduped = dedupeVisualLayoutDetections(coarse)
    .sort((a, b) => Number(a.__originIndex || 0) - Number(b.__originIndex || 0));

  if (deduped.length) {
    return deduped.slice(0, LAYOUT_VISUAL_MAX_REGIONS);
  }

  const fallback = [...source].map((det, idx) => {
    const rect = normalizeRect(det?.coordinate ?? det?.polygon_points ?? det?.polygon ?? det?.bbox);
    const area = rect ? rectArea(rect) : 0;
    return {
      ...det,
      __originIndex: idx,
      __visualRect: rect,
      __visualArea: area,
    };
  }).filter((det) => Array.isArray(det.__visualRect));

  fallback.sort((a, b) => Number(b.__visualArea || 0) - Number(a.__visualArea || 0));
  return fallback
    .slice(0, Math.min(LAYOUT_VISUAL_MAX_REGIONS, 24))
    .sort((a, b) => Number(a.__originIndex || 0) - Number(b.__originIndex || 0));
}

function dedupeVisualLayoutDetections(layoutDets) {
  const sorted = [...layoutDets].sort((a, b) => Number(b.__visualArea || 0) - Number(a.__visualArea || 0));
  const accepted = [];

  for (const det of sorted) {
    const rect = det.__visualRect;
    if (!rect) {
      continue;
    }

    const label = normalizeLayoutLabel(det?.original_label ?? det?.label ?? det?.category_name);
    let duplicate = false;
    for (const prev of accepted) {
      const prevRect = prev.__visualRect;
      if (!prevRect) {
        continue;
      }

      const inter = rectIntersectionArea(rect, prevRect);
      if (inter <= 0) {
        continue;
      }

      const overlapMinRatio = inter / Math.max(1, Math.min(rectArea(rect), rectArea(prevRect)));
      const sameLabel = label === normalizeLayoutLabel(prev?.original_label ?? prev?.label ?? prev?.category_name);
      if (overlapMinRatio >= 0.93 || (sameLabel && rectIou(rect, prevRect) >= 0.82)) {
        duplicate = true;
        break;
      }
    }

    if (!duplicate) {
      accepted.push(det);
    }
  }

  return accepted;
}

function intersectionLength(a1, a2, b1, b2) {
  const lo = Math.max(a1, b1);
  const hi = Math.min(a2, b2);
  return Math.max(0, hi - lo);
}

function drawTextInBounds(ctx, text, bounds) {
  const [x1, y1, x2, y2] = bounds;
  const width = x2 - x1;
  const height = y2 - y1;
  if (width < 3 || height < 3) return false;

  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const padX = clamp(width * 0.04, 0.2, 7);
  const padY = clamp(height * 0.05, 0.2, 4);
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  if (innerW < 2 || innerH < 2) return false;

  let fontSize = quantizeFontSize(clamp(height * 0.82, 3, Math.min(44, height * 1.02)));
  const minFont = 2.1;
  let lines = [];
  let lineHeight = 0;

  while (fontSize >= minFont) {
    ctx.font = `${fontSize}px "IBM Plex Mono", "Courier New", monospace`;
    lines = wrapTextToWidth(ctx, normalized, innerW);
    lineHeight = Math.max(1.6, fontSize * 1.1);
    const neededHeight = lines.length * lineHeight;
    if (neededHeight <= innerH + 0.5) {
      break;
    }
    fontSize = quantizeFontSize(fontSize - 1);
  }

  ctx.font = `${fontSize}px "IBM Plex Mono", "Courier New", monospace`;
  lines = wrapTextToWidth(ctx, normalized, innerW);
  lineHeight = Math.max(1.4, Math.min(fontSize * 1.1, innerH / Math.max(1, lines.length)));

  ctx.fillStyle = '#0b0f16';
  ctx.textBaseline = 'top';

  let y = y1 + padY;
  for (const line of lines) {
    if (y + lineHeight <= y2 - padY + 0.5) {
      ctx.fillText(line, x1 + padX, y);
    }
    y += lineHeight;
  }
  return true;
}

function wrapTextToWidth(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [];
  }

  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = '';
    }

    if (ctx.measureText(word).width <= maxWidth) {
      current = word;
      continue;
    }

    const pieces = breakWordToWidth(ctx, word, maxWidth);
    for (let i = 0; i < pieces.length; i += 1) {
      if (i === pieces.length - 1) {
        current = pieces[i];
      } else {
        lines.push(pieces[i]);
      }
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function breakWordToWidth(ctx, word, maxWidth) {
  const chars = Array.from(String(word));
  const parts = [];
  let current = '';

  for (const ch of chars) {
    const candidate = current + ch;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
    } else {
      parts.push(current);
      current = ch;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function quantizeFontSize(value) {
  const rounded = Math.round(Number(value) || 0);
  return clamp(rounded, 2, 44);
}

function drawRewriteBoundingBox(ctx, bounds, color) {
  const [x1, y1, x2, y2] = bounds;
  ctx.fillStyle = color.withAlpha(0.08);
  ctx.fillRect(x1, y1, Math.max(0, x2 - x1), Math.max(0, y2 - y1));
  ctx.strokeStyle = color.withAlpha(0.88);
  ctx.lineWidth = 1.1;
  ctx.strokeRect(x1 + 0.5, y1 + 0.5, Math.max(0, (x2 - x1) - 1), Math.max(0, (y2 - y1) - 1));
}

function normalizeRewriteText(rawText, index) {
  const normalized = String(rawText ?? '').replace(/\s+/g, ' ').trim();
  if (normalized) {
    return normalized;
  }
  return `${OCR_REWRITE_EMPTY_FALLBACK} #${Number(index) + 1}`;
}

function renderFallbackTextInBounds(ctx, text, bounds) {
  const [x1, y1, x2, y2] = bounds;
  const width = Math.max(1, x2 - x1);
  const height = Math.max(1, y2 - y1);
  const size = quantizeFontSize(clamp(Math.min(height * 0.48, width * 0.12), 2, 16));

  ctx.font = `${size}px "IBM Plex Mono", "Courier New", monospace`;
  ctx.fillStyle = '#0b0f16';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(String(text), x1 + (width / 2), y1 + (height / 2));
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawOcrLayoutMaskRegions(ctx, layoutDetections, scaleX, scaleY) {
  const detections = Array.isArray(layoutDetections) ? layoutDetections : [];
  if (!detections.length) {
    return 0;
  }

  let count = 0;
  ctx.setLineDash([6, 4]);
  for (const det of detections) {
    const label = String(det?.label ?? det?.category_name ?? det?.original_label ?? '').toLowerCase();
    if (!OCR_LAYOUT_REGION_LABELS.has(label)) {
      continue;
    }

    const polygon = normalizeLayoutPolygon(det, scaleX, scaleY);
    if (!polygon || polygon.length < 3) {
      continue;
    }

    const color = labelColor(det?.original_label ?? det?.label ?? 'ocr-mask', count);
    tracePolygonPath(ctx, polygon);
    ctx.fillStyle = color.withAlpha(0.045);
    ctx.strokeStyle = color.withAlpha(0.34);
    ctx.lineWidth = 1.1;
    ctx.fill();
    ctx.stroke();
    count += 1;
  }
  ctx.setLineDash([]);

  return count;
}

function drawOcr(baseCanvas, ocr, layoutDets, scaleX, scaleY) {
  const overlayCtx = initVisualCanvas(ocrOverlayCanvas, baseCanvas);
  const rewriteCtx = initVisualCanvas(ocrRewriteCanvas, baseCanvas, '#ffffff');
  if (!overlayCtx || !rewriteCtx) return;

  const layoutMaskRegions = drawOcrLayoutMaskRegions(overlayCtx, layoutDets, scaleX, scaleY);

  const boxes = Array.isArray(ocr?.boxes) ? ocr.boxes : [];
  const texts = Array.isArray(ocr?.texts) ? ocr.texts : [];
  let valid = 0;
  let rewritten = 0;
  let fallbackRewrite = 0;

  for (let i = 0; i < boxes.length; i += 1) {
    const polygon = normalizePolygon(boxes[i], scaleX, scaleY);
    if (!polygon || polygon.length < 3) continue;

    const bounds = polygonBounds(polygon);
    if (!bounds) continue;

    valid += 1;
    const color = labelColor('ocr-region', i);

    tracePolygonPath(overlayCtx, polygon);
    overlayCtx.fillStyle = color.withAlpha(0.24);
    overlayCtx.strokeStyle = color.withAlpha(0.9);
    overlayCtx.lineWidth = 1.2;
    overlayCtx.fill();
    overlayCtx.stroke();

    drawRewriteBoundingBox(rewriteCtx, bounds, color);

    const rewriteText = normalizeRewriteText(texts[i], i);
    const rendered = drawTextInBounds(rewriteCtx, rewriteText, bounds);
    if (!rendered) {
      fallbackRewrite += 1;
      renderFallbackTextInBounds(rewriteCtx, rewriteText, bounds);
    }
    rewritten += 1;
  }

  setVisualMeta(ocrMeta, `${valid} OCR boxes | ${rewritten} rewritten | ${fallbackRewrite} fallback | ${layoutMaskRegions} mask regions`);
}
