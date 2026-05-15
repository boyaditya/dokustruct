/**
 * ui/state/appState.js
 * Central reactive state store for the DocParsing web UI.
 *
 * Pattern: lightweight pub/sub with path-based subscriptions.
 * No external framework — vanilla JS only.
 *
 * Usage:
 *   const state = new AppState();
 *
 *   // Subscribe to any change
 *   const unsub = state.subscribe('files', (files) => console.log(files));
 *
 *   // Subscribe to any state change
 *   const unsub2 = state.subscribeAll((patch, prevState) => { ... });
 *
 *   // Read
 *   const files = state.get('files');
 *
 *   // Write (triggers subscribers)
 *   state.set('parseMethod', 'ocr');
 *
 *   // Batch write (fires only one notification cycle)
 *   state.patch({ formulaEnable: true, tableEnable: false });
 *
 *   // Reset to initial state
 *   state.reset();
 *
 * Research Artifact: System A — ,  2025
 */

// ---------------------------------------------------------------------------
// Initial state definition
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PageRange
 * @property {number} start
 * @property {number|null} end
 */

/**
 * @typedef {object} Timings
 * @property {number} preprocessing
 * @property {number} layoutAnalysis
 * @property {number} ocr
 * @property {number} formula
 * @property {number} table
 * @property {number} readingOrder
 * @property {number} postprocessing
 * @property {number} total
 */

/**
 * @typedef {object} Progress
 * @property {number} current
 * @property {number} total
 */

/**
 * @typedef {'not_downloaded'|'downloading'|'cached'|'error'|'cancelled'} ModelStatusValue
 */

/**
 * Full application state shape.
 * @typedef {object} AppStateShape
 *
 * — Input —
 * @property {File[]}        files
 * @property {number}        currentFileIndex
 * @property {PageRange}     pageRange
 * @property {number}        maxPages
 *
 * — Parse options —
 * @property {'auto'|'ocr'|'txt'} parseMethod
 * @property {boolean}       forceOcr
 * @property {string}        language
 * @property {'auto'|'txt'|'ocr'} useDetMode
 *
 * — Feature toggles —
 * @property {boolean}       formulaEnable
 * @property {boolean}       tableEnable
 * @property {boolean}       checkboxEnable
 * @property {0|1}           formulaLevel
 *
 * — Layout config —
 * @property {string}        layoutModelType
 * @property {number}        layoutConfThresh
 * @property {'auto'|'rect'} layoutShapeMode
 * @property {string[]}      markdownIgnoreLabels
 *
 * — Table config —
 * @property {string}        tableModelType
 * @property {boolean}       tableForceOcr
 * @property {boolean}       tableUseWordBox
 * @property {boolean}       tableFormulaEnable
 * @property {boolean}       tableImageEnable
 * @property {boolean}       skipTextInImage
 * @property {boolean}       tableUseImg2table
 * @property {boolean}       tableCompareMode
 *
 * — Output options —
 * @property {boolean}       dumpMd
 * @property {boolean}       dumpMiddleJson
 * @property {boolean}       dumpModelOutput
 * @property {boolean}       dumpContentList
 * @property {boolean}       drawLayoutBbox
 * @property {boolean}       drawSpanBbox
 * @property {boolean}       dumpMdHtml
 * @property {boolean}       dumpMdDocx
 * @property {'mm_markdown'|'nlp_markdown'|'content_list'} makeMode
 * @property {'a'|'b'|'all'} latexDelimiterType
 *
 * — Processing state —
 * @property {boolean}       isProcessing
 * @property {string|null}   processingStage
 * @property {Progress}      progress
 * @property {AbortController|null} abortController
 *
 * — Results —
 * @property {object|null}   results
 * @property {'markdown'|'raw'|'json_content'|'json_middle'|'json_model'|'layout_vis'} activeOutputTab
 * @property {boolean}       showOutputPanel
 *
 * — Benchmarks —
 * @property {Timings}       timings
 * @property {string|null}   activeExecutionProvider
 * @property {number}        peakMemoryMb
 *
 * — Research mode —
 * @property {boolean}       researchMode
 * @property {number}        researchRepeatCount
 * @property {number}        researchCurrentRun
 * @property {Timings[]}     researchRunHistory
 *
 * — Model management —
 * @property {Object.<string, ModelStatusValue>} modelStatus
 * @property {Object.<string, number>}           modelProgress
 * @property {Object.<string, number>}           modelSizeMb
 * @property {'idle'|'runtime_loading'|'model_warming'|'ready'|'error'} runtimeStatus
 * @property {'idle'|'runtime_loading'|'model_warming'|'ready'|'error'} warmupStatus
 * @property {string|null}   warmupConfigKey
 * @property {Timings}       startupTimings
 * @property {string|null}   warmupError
 *
 * — UI state —
 * @property {boolean}       leftDrawerOpen
 * @property {boolean}       rightSheetOpen
 * @property {boolean}       showPdfPreview
 * @property {string[]}      expandedSections
 * @property {'layout'|'span'|'none'} activeBboxLayer
 * @property {string[]}      hiddenBboxCategories
 */

/** @returns {AppStateShape} */
function createInitialState() {
  return {
    // ── Input ──────────────────────────────────────────────────────────────
    files: [],
    currentFileIndex: 0,
    pageRange: { start: 0, end: null },
    maxPages: 20,

    // ── Pipeline mode ──────────────────────────────────────────────────────
    // Kept for backward compatibility with older config/state snapshots.
    pipelineMode: 'full_analysis',

    // ── Parse options ──────────────────────────────────────────────────────
    parseMethod: 'auto',
    forceOcr: false,
    language: 'ch',
    useDetMode: 'auto',

    // ── Feature toggles ────────────────────────────────────────────────────
    formulaEnable: false,
    tableEnable: false,
    checkboxEnable: false,
    formulaLevel: 0,
    formulaModelType: 'pp_formulanet_plus_s',

    // ── Layout config ──────────────────────────────────────────────────────
    layoutModelType: 'pp_doclayoutv2',
    layoutConfThresh: 0.5,
    layoutShapeMode: 'auto',
    useDocOrientationClassify: true,
    markdownIgnoreLabels: [
      'number',
      'footnote',
      'header',
      'header_image',
      'footer',
      'footer_image',
      'aside_text',
    ],

    // ── Table config ───────────────────────────────────────────────────────
    tableModelType: 'unet_slanet_plus',
    tableForceOcr: false,
    tableUseWordBox: false,
    tableFormulaEnable: false,
    tableImageEnable: false,
    skipTextInImage: true,
    tableUseImg2table: false,
    tableCompareMode: false,

    // ── Output options ─────────────────────────────────────────────────────
    dumpMd: true,
    dumpMiddleJson: true,
    dumpModelOutput: true,
    dumpContentList: true,
    drawLayoutBbox: true,
    drawSpanBbox: false,
    dumpMdHtml: false,
    dumpMdDocx: false,
    makeMode: 'mm_markdown',
    latexDelimiterType: 'all',

    // ── Processing state ───────────────────────────────────────────────────
    isProcessing: false,
    processingStage: null,     // 'loading_models'|'preprocessing'|'layout'|'ocr'|'postprocessing'|'done'
    progress: { current: 0, total: 0 },
    abortController: null,

    // ── Results ────────────────────────────────────────────────────────────
    results: null,
    activeOutputTab: 'markdown',
    showOutputPanel: false,

    // ── Benchmarks ─────────────────────────────────────────────────────────
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
    activeExecutionProvider: null,
    peakMemoryMb: 0,

    // ── Research mode ──────────────────────────────────────────────────────
    researchMode: false,
    researchRepeatCount: 10,
    researchCurrentRun: 0,
    researchRunHistory: [],    // Array<Timings>

    // ── Model management ───────────────────────────────────────────────────
    modelStatus: {},           // { [modelId]: 'not_downloaded'|'downloading'|'cached'|'error'|'cancelled' }
    modelProgress: {},         // { [modelId]: 0-100 }
    modelSizeMb: {},           // { [modelId]: number }
    runtimeStatus: 'idle',
    warmupStatus: 'idle',
    warmupConfigKey: null,
    startupTimings: {
      preprocessing: 0,
      layoutAnalysis: 0,
      ocr: 0,
      formula: 0,
      table: 0,
      readingOrder: 0,
      postprocessing: 0,
      total: 0,
    },
    warmupError: null,

    // ── UI state ───────────────────────────────────────────────────────────
    leftDrawerOpen: false,
    rightSheetOpen: false,
    showPdfPreview: true,
    expandedSections: ['parseMethod', 'features'],   // section keys open by default
    activeBboxLayer: 'layout',
    hiddenBboxCategories: [],
  };
}

// ---------------------------------------------------------------------------
// AppState class
// ---------------------------------------------------------------------------

export class AppState {
  /** @type {AppStateShape} */
  #state;

  /**
   * Path-keyed subscriber map.
   * key: state path (e.g. 'files') or '*' for all-change listeners.
   * value: Set of callback functions.
   * @type {Map<string, Set<Function>>}
   */
  #subscribers = new Map();

  /** Batching flag — suppresses individual notifications during patch(). */
  #batching = false;

  /** Keys changed during a batch — flushed after batch completes. */
  #batchDirty = new Set();

  constructor() {
    this.#state = createInitialState();
    this._detectResearchMode();
    this._detectExecutionProvider();
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /**
   * Read a top-level state key.
   * @template {keyof AppStateShape} K
   * @param {K} key
   * @returns {AppStateShape[K]}
   */
  get(key) {
    return this.#state[key];
  }

  /**
   * Return a shallow copy of the full state object.
   * @returns {AppStateShape}
   */
  snapshot() {
    return { ...this.#state };
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Set a top-level state key and notify subscribers.
   * @template {keyof AppStateShape} K
   * @param {K} key
   * @param {AppStateShape[K]} value
   */
  set(key, value) {
    const prev = this.#state[key];
    if (prev === value) return;              // reference equality — skip if unchanged
    this.#state[key] = value;

    if (this.#batching) {
      this.#batchDirty.add(key);
    } else {
      this._notify(key, value, prev);
      this._notifyAll({ [key]: value }, this.#state);
    }
  }

  /**
   * Merge a partial state object, firing a single notification cycle.
   * @param {Partial<AppStateShape>} patch
   */
  patch(patch) {
    const prevState = { ...this.#state };
    this.#batching = true;

    for (const [key, value] of Object.entries(patch)) {
      const prev = this.#state[key];
      if (prev !== value) {
        this.#state[key] = value;
        this.#batchDirty.add(key);
      }
    }

    this.#batching = false;

    if (this.#batchDirty.size === 0) return;

    // Build the actual changed subset
    const changed = {};
    for (const key of this.#batchDirty) {
      changed[key] = this.#state[key];
    }

    // Notify per-key subscribers
    for (const key of this.#batchDirty) {
      this._notify(key, this.#state[key], prevState[key]);
    }

    // Notify wildcard subscribers once with all changes
    this._notifyAll(changed, this.#state);

    this.#batchDirty.clear();
  }

  /**
   * Deeply update a nested object key (one level deep).
   * E.g. state.setNested('timings', 'ocr', 420)
   *
   * @param {string} key - Top-level state key that holds an object.
   * @param {string} subKey - Property name within that object.
   * @param {*} value
   */
  setNested(key, subKey, value) {
    const obj = this.#state[key];
    if (typeof obj !== 'object' || obj === null) {
      throw new Error(`State key "${key}" is not an object.`);
    }
    if (obj[subKey] === value) return;
    const updated = { ...obj, [subKey]: value };
    this.set(key, updated);
  }

  /**
   * Reset state to initial values and notify all subscribers.
   * Preserves: modelStatus, modelProgress, modelSizeMb, researchMode,
   *            activeExecutionProvider (hardware detection — not user config).
   */
  reset() {
    const preserved = {
      modelStatus:            { ...this.#state.modelStatus },
      modelProgress:          { ...this.#state.modelProgress },
      modelSizeMb:            { ...this.#state.modelSizeMb },
      researchMode:           this.#state.researchMode,
      activeExecutionProvider: this.#state.activeExecutionProvider,
    };

    const prevState = { ...this.#state };
    this.#state = { ...createInitialState(), ...preserved };

    this._notifyAll(this.#state, prevState);

    // Per-key notifications for changed keys
    for (const key of Object.keys(this.#state)) {
      if (this.#state[key] !== prevState[key]) {
        this._notify(key, this.#state[key], prevState[key]);
      }
    }
  }

  // ── Subscribe ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to changes on a specific state key.
   *
   * @param {string} key - State key to watch.
   * @param {function(any, any): void} callback - Called with (newValue, oldValue).
   * @returns {function(): void} Unsubscribe function.
   */
  subscribe(key, callback) {
    if (!this.#subscribers.has(key)) {
      this.#subscribers.set(key, new Set());
    }
    this.#subscribers.get(key).add(callback);

    // Return unsubscribe
    return () => {
      this.#subscribers.get(key)?.delete(callback);
    };
  }

  /**
   * Subscribe to any state change. Callback receives (changedPatch, fullState).
   *
   * @param {function(object, AppStateShape): void} callback
   * @returns {function(): void} Unsubscribe function.
   */
  subscribeAll(callback) {
    return this.subscribe('*', callback);
  }

  /**
   * Subscribe, but also immediately invoke callback with current value.
   *
   * @param {string} key
   * @param {function(any, any): void} callback
   * @returns {function(): void} Unsubscribe function.
   */
  subscribeImmediate(key, callback) {
    callback(this.get(key), undefined);
    return this.subscribe(key, callback);
  }

  // ── Derived / computed getters ────────────────────────────────────────────

  /**
   * Returns true if the app has at least one file queued and is not processing.
   * @returns {boolean}
   */
  get canConvert() {
    return this.#state.files.length > 0 && !this.#state.isProcessing;
  }

  /**
   * Returns true if there are results available to display.
   * @returns {boolean}
   */
  get hasResults() {
    return this.#state.results !== null;
  }

  /**
   * The currently active file (File object or null).
   * @returns {File|null}
   */
  get currentFile() {
    const { files, currentFileIndex } = this.#state;
    return files[currentFileIndex] ?? null;
  }

  /**
   * Build the layoutConfig object for passing to the pipeline adapter.
   * @returns {object}
   */
  get layoutConfig() {
    const s = this.#state;
    const executionProvider = s.activeExecutionProvider ?? 'wasm';
    return {
      execution_provider: executionProvider,
      executionProviders: executionProvider === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'],
      engine_cfg: { use_webgpu: executionProvider === 'webgpu' },
      model_type: s.layoutModelType,
      conf_thresh: s.layoutConfThresh,
      layout_shape_mode: s.layoutShapeMode,
      use_doc_orientation_classify: s.useDocOrientationClassify,
      batch_num: executionProvider === 'webgpu' ? 4 : 1,
      markdown_ignore_labels: s.markdownIgnoreLabels,
    };
  }

  /**
   * Build the ocrConfig object.
   * @returns {object}
   */
  get ocrConfig() {
    const s = this.#state;
    const executionProvider = s.activeExecutionProvider ?? 'wasm';
    return {
      execution_provider: executionProvider,
      executionProviders: executionProvider === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'],
      use_det_mode: s.useDetMode,
      "Det.rec_batch_num": executionProvider === 'webgpu' ? 4 : 1,
      "Rec.rec_batch_num": executionProvider === 'webgpu' ? 24 : 6,
    };
  }

  /**
   * Build the tableConfig object.
   * @returns {object}
   */
  get tableConfig() {
    const s = this.#state;
    const executionProvider = s.activeExecutionProvider ?? 'wasm';
    return {
      execution_provider: executionProvider,
      executionProviders: executionProvider === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'],
      engine_cfg: { use_webgpu: executionProvider === 'webgpu' },
      model_type: s.tableModelType,
      force_ocr: s.tableForceOcr,
      use_word_box: s.tableUseWordBox,
      table_formula_enable: s.tableFormulaEnable,
      table_image_enable: s.tableImageEnable,
      skip_text_in_image: s.skipTextInImage,
      use_img2table: s.tableUseImg2table,
      use_compare_table: s.tableCompareMode,
    };
  }

  /**
   * Build the checkboxConfig object.
   * @returns {object}
   */
  get checkboxConfig() {
    return { checkbox_enable: this.#state.checkboxEnable };
  }

  /**
   * Build the formulaConfig object.
   * @returns {object}
   */
  get formulaConfig() {
    const s = this.#state;
    const executionProvider = s.activeExecutionProvider ?? 'wasm';
    const isLatexOcr = s.formulaModelType === 'latex_ocr';
    return {
      execution_provider: executionProvider,
      executionProviders: executionProvider === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'],
      formula_level: s.formulaLevel,
      modelType: s.formulaModelType,
      batch_num: isLatexOcr && executionProvider === 'webgpu' ? 2 : (executionProvider === 'wasm' ? 2 : 1),
    };
  }

  get orientationConfig() {
    const executionProvider = this.#state.activeExecutionProvider ?? 'wasm';
    return {
      execution_provider: executionProvider,
      executionProviders: executionProvider === 'wasm' ? ['wasm'] : ['webgpu', 'wasm'],
    };
  }

  /**
   * Returns the latex delimiter strings for the active delimiter type setting.
   * Used by MarkdownRenderer.
   * @returns {{ inline: [string,string][], display: [string,string][] }}
   */
  get latexDelimiters() {
    const type = this.#state.latexDelimiterType;
    /** @type {[string,string][]} */
    const inline  = [];
    /** @type {[string,string][]} */
    const display = [];

    if (type === 'a' || type === 'all') {
      inline.push(['$', '$']);
      display.push(['$$', '$$']);
    }
    if (type === 'b' || type === 'all') {
      inline.push(['\\(', '\\)']);
      display.push(['\\[', '\\]']);
    }

    return { inline, display };
  }

  /**
   * Aggregate research run statistics from researchRunHistory.
   * @returns {{ mean: number, sd: number, median: number, iqr: number, cv: number, min: number, max: number }|null}
   */
  get researchAggregates() {
    const history = this.#state.researchRunHistory;
    if (!history || history.length === 0) return null;

    const totals = history.map(t => t.total);
    const n = totals.length;
    const mean = totals.reduce((a, b) => a + b, 0) / n;
    const variance = totals.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const sd = Math.sqrt(variance);
    const sorted = [...totals].sort((a, b) => a - b);
    const median = n % 2 === 0
      ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
      : sorted[Math.floor(n / 2)];
    const q1 = sorted[Math.floor(n / 4)];
    const q3 = sorted[Math.floor(3 * n / 4)];
    const iqr = q3 - q1;
    const cv = mean > 0 ? (sd / mean) * 100 : 0;

    return {
      mean: Math.round(mean),
      sd: Math.round(sd),
      median: Math.round(median),
      iqr: Math.round(iqr),
      cv: parseFloat(cv.toFixed(1)),
      min: sorted[0],
      max: sorted[n - 1],
      n,
    };
  }

  // ── Pipeline helpers ──────────────────────────────────────────────────────

  /**
   * Mark processing as started for a given stage.
   * @param {'loading_models'|'preprocessing'|'layout'|'ocr'|'postprocessing'} stage
   * @param {number} [totalPages]
   */
  beginStage(stage, totalPages = 0) {
    this.patch({
      isProcessing: true,
      processingStage: stage,
      progress: { current: 0, total: totalPages },
    });
  }

  /**
   * Update page-level progress within the current stage.
   * @param {number} current
   * @param {number} [total]
   */
  updateProgress(current, total) {
    this.set('progress', {
      current,
      total: total ?? this.#state.progress.total,
    });
  }

  /**
   * Record timing for a single pipeline stage.
    * @param {'preprocessing'|'layoutAnalysis'|'ocr'|'formula'|'table'|'readingOrder'|'postprocessing'|'total'} stage
   * @param {number} ms
   */
  recordTiming(stage, ms) {
    this.setNested('timings', stage, ms);
  }

  /**
   * Record timing for startup/runtime/model preparation.
   * @param {'preprocessing'|'layoutAnalysis'|'ocr'|'formula'|'table'|'readingOrder'|'postprocessing'|'total'} stage
   * @param {number} ms
   */
  recordStartupTiming(stage, ms) {
    this.setNested('startupTimings', stage, ms);
  }

  /**
   * Update peak memory estimate from performance.memory if available.
   */
  updateMemory() {
    if (typeof performance !== 'undefined' && performance.memory) {
      const mb = Math.round(performance.memory.usedJSHeapSize / (1024 * 1024));
      if (mb !== this.#state.peakMemoryMb) {
        this.set('peakMemoryMb', mb);
      }
    }
  }

  /**
   * Mark processing as finished and store results.
   * @param {object} results
   */
  finishProcessing(results) {
    this.patch({
      isProcessing: false,
      processingStage: 'done',
      results,
      showOutputPanel: true,
      abortController: null,
    });
  }

  /**
   * Mark processing as failed (not user-cancelled).
   * @param {Error|string} error
   */
  failProcessing(error) {
    console.error('[AppState] Processing failed:', error);
    this.patch({
      isProcessing: false,
      processingStage: null,
      abortController: null,
    });
  }

  /**
   * Cancel in-flight processing via the stored AbortController.
   */
  cancelProcessing() {
    if (this.#state.abortController) {
      this.#state.abortController.abort();
    }
    this.patch({
      isProcessing: false,
      processingStage: null,
      abortController: null,
      progress: { current: 0, total: 0 },
    });
  }

  // ── Model management helpers ──────────────────────────────────────────────

  /**
   * Update the download status of a model.
   * @param {string} modelId
   * @param {ModelStatusValue} status
   * @param {number} [progressPct] - 0-100, only relevant when status='downloading'
   */
  setModelStatus(modelId, status, progressPct = 0) {
    const newStatus   = { ...this.#state.modelStatus,   [modelId]: status };
    const newProgress = { ...this.#state.modelProgress, [modelId]: progressPct };
    this.patch({ modelStatus: newStatus, modelProgress: newProgress });
  }

  /**
   * Register model sizes (from config).
   * @param {Object.<string, number>} sizeMap - { modelId: sizeInMb }
   */
  registerModelSizes(sizeMap) {
    this.set('modelSizeMb', { ...this.#state.modelSizeMb, ...sizeMap });
  }

  // ── File management helpers ───────────────────────────────────────────────

  /**
   * Add files to the queue. Deduplicates by name+size.
   * @param {File[]} newFiles
   */
  addFiles(newFiles) {
    const existing = this.#state.files;
    const deduped = newFiles.filter(f =>
      !existing.some(e => e.name === f.name && e.size === f.size),
    );
    if (deduped.length === 0) return;
    this.set('files', [...existing, ...deduped]);
  }

  /**
   * Remove a file from the queue by index.
   * @param {number} index
   */
  removeFile(index) {
    const files = [...this.#state.files];
    files.splice(index, 1);
    const currentIndex = Math.min(this.#state.currentFileIndex, files.length - 1);
    this.patch({
      files,
      currentFileIndex: Math.max(0, currentIndex),
    });
  }

  /**
   * Clear all queued files and reset results.
   */
  clearFiles() {
    this.patch({
      files: [],
      currentFileIndex: 0,
      results: null,
      showOutputPanel: false,
      timings: createInitialState().timings,
      peakMemoryMb: 0,
    });
  }

  // ── Research mode helpers ─────────────────────────────────────────────────

  /**
   * Append a completed run's timings to the research history.
   * @param {Timings} timings
   */
  recordResearchRun(timings) {
    const history = [...this.#state.researchRunHistory, { ...timings }];
    this.patch({
      researchRunHistory: history,
      researchCurrentRun: this.#state.researchCurrentRun + 1,
    });
  }

  /**
   * Clear the research run history.
   */
  clearResearchHistory() {
    this.patch({
      researchRunHistory: [],
      researchCurrentRun: 0,
    });
  }

  // ── Internal notification ─────────────────────────────────────────────────

  /**
   * Fire per-key subscribers.
   * @param {string} key
   * @param {*} newValue
   * @param {*} oldValue
   */
  _notify(key, newValue, oldValue) {
    const subs = this.#subscribers.get(key);
    if (!subs || subs.size === 0) return;
    for (const cb of subs) {
      try { cb(newValue, oldValue); }
      catch (e) { console.error(`[AppState] Subscriber error (key="${key}"):`, e); }
    }
  }

  /**
   * Fire wildcard '*' subscribers with the changed patch.
   * @param {object} patch
   * @param {AppStateShape} fullState
   */
  _notifyAll(patch, fullState) {
    const subs = this.#subscribers.get('*');
    if (!subs || subs.size === 0) return;
    for (const cb of subs) {
      try { cb(patch, fullState); }
      catch (e) { console.error('[AppState] subscribeAll subscriber error:', e); }
    }
  }

  // ── Internal: auto-detect ─────────────────────────────────────────────────

  /**
   * Check for ?research=1 URL parameter and activate research mode.
   */
  _detectResearchMode() {
    if (typeof location !== 'undefined') {
      const params = new URLSearchParams(location.search);
      if (params.get('research') === '1') {
        this.#state.researchMode = true;
      }
    }
  }

  /**
   * Detect WebGPU or WASM execution provider availability.
   * Stores result in activeExecutionProvider without triggering subscribers
   * (called before any subscriptions exist).
   */
  _detectExecutionProvider() {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      this.#state.activeExecutionProvider = 'webgpu';
    } else {
      this.#state.activeExecutionProvider = 'wasm';
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export (optional — components can also instantiate their own)
// ---------------------------------------------------------------------------

/**
 * Shared singleton AppState instance.
 * Import this when you need access to the global state in any module.
 *
 * @type {AppState}
 */
export const appState = new AppState();
