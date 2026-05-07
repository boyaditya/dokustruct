/**
 * ui/utils/exportUtils.js
 * Export utilities:
 *   - CSV benchmark (single run)
 *   - CSV research batch (N runs + aggregate)
 *   - ZIP bundle (markdown + JSON outputs + benchmark CSV)
 *
 * Thesis experiment CSV columns (Chapter 3, Fase I & II):
 *   file_name, file_size_bytes, page_count, parse_method,
 *   formula_enable, table_enable,
 *   total_ms, preprocessing_ms, layout_ms, ocr_ms, postprocessing_ms,
 *   execution_provider, peak_memory_mb, browser, user_agent
 */

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/** Escape a value for CSV (wrap in quotes, escape internal quotes) */
function csvCell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

/** Join an array of values into a CSV row string */
function csvRow(values) {
  return values.map(csvCell).join(',');
}

/** Build the standard benchmark header row */
const BENCHMARK_HEADERS = [
  'file_name',
  'file_size_bytes',
  'page_count',
  'parse_method',
  'formula_enable',
  'table_enable',
  'total_ms',
  'preprocessing_ms',
  'layout_ms',
  'ocr_ms',
  'postprocessing_ms',
  'execution_provider',
  'peak_memory_mb',
  'browser',
  'user_agent',
];

/** Research-run CSV headers (includes run index) */
const RESEARCH_HEADERS = ['run', ...BENCHMARK_HEADERS];

// ---------------------------------------------------------------------------
// ExportUtils class
// ---------------------------------------------------------------------------

export class ExportUtils {
  // ── Single-run benchmark CSV ──────────────────────────────────────────────

  /**
   * Export a single-run benchmark CSV from current AppState.
   * @param {import('../state/appState.js').AppState} state
   * @param {string} [filenameOverride]
   */
  exportBenchmarkCsv(state, filenameOverride) {
    const row = this._buildBenchmarkRow(state);
    const csv = [BENCHMARK_HEADERS.join(','), csvRow(row)].join('\n');

    const file  = state.currentFile;
    const stem  = file ? file.name.replace(/\.[^.]+$/, '') : 'benchmark';
    const fname = filenameOverride ?? `${stem}_benchmark.csv`;
    this._download(csv, fname, 'text/csv;charset=utf-8;');
  }

  // ── Research batch CSV ────────────────────────────────────────────────────

  /**
   * Export all N research runs + aggregate statistics.
   * @param {import('../state/appState.js').AppState} state
   * @param {string} [filenameOverride]
   */
  exportResearchCsv(state, filenameOverride) {
    const history  = state.get('researchRunHistory');
    if (!history || history.length === 0) {
      console.warn('[exportUtils] No research run history to export.');
      return;
    }

    const file = state.currentFile;
    const meta = this._staticMeta(state);

    const runRows = history.map((t, i) => {
      const total = t.total
        || (t.preprocessing + t.layoutAnalysis + t.ocr + t.postprocessing);
      return csvRow([
        i + 1,
        meta.file_name,
        meta.file_size_bytes,
        meta.page_count,
        meta.parse_method,
        meta.formula_enable,
        meta.table_enable,
        Math.round(total),
        Math.round(t.preprocessing  ?? 0),
        Math.round(t.layoutAnalysis ?? 0),
        Math.round(t.ocr            ?? 0),
        Math.round(t.postprocessing ?? 0),
        meta.execution_provider,
        meta.peak_memory_mb,
        meta.browser,
        meta.user_agent,
      ]);
    });

    const lines = [RESEARCH_HEADERS.join(','), ...runRows, ''];

    // ── Aggregate block ────────────────────────────────────────────────────
    const agg = state.researchAggregates;
    if (agg) {
      lines.push('# Aggregate Statistics');
      lines.push(csvRow(['metric', 'value', 'unit']));
      lines.push(csvRow(['N',              agg.n,      'runs']));
      lines.push(csvRow(['mean_total',     agg.mean,   'ms']));
      lines.push(csvRow(['sd_total',       agg.sd,     'ms']));
      lines.push(csvRow(['median_total',   agg.median, 'ms']));
      lines.push(csvRow(['iqr_total',      agg.iqr,    'ms']));
      lines.push(csvRow(['cv_total',       agg.cv,     '%']));
      lines.push(csvRow(['min_total',      agg.min,    'ms']));
      lines.push(csvRow(['max_total',      agg.max,    'ms']));

      // Per-stage means
      const stageMeans = this._stageMeans(history);
      for (const [stage, mean] of Object.entries(stageMeans)) {
        lines.push(csvRow([`mean_${stage}`, Math.round(mean), 'ms']));
      }
    }

    const stem  = file ? file.name.replace(/\.[^.]+$/, '') : 'research';
    const fname = filenameOverride ?? `${stem}_research_runs.csv`;
    this._download(lines.join('\n'), fname, 'text/csv;charset=utf-8;');
  }

  // ── ZIP bundle ────────────────────────────────────────────────────────────

  /**
   * Export a ZIP archive containing all available output files.
   * Requires JSZip to be available globally (window.JSZip).
   * Falls back to individual downloads if JSZip not available.
   *
   * @param {import('../state/appState.js').AppState} state
   */
  async exportZipBundle(state) {
    const results = state.get('results');
    if (!results) return;

    const file = state.currentFile;
    const stem = file ? file.name.replace(/\.[^.]+$/, '') : 'output';

    // ── Without JSZip: individual downloads ───────────────────────────────
    if (!window.JSZip) {
      console.warn('[exportUtils] JSZip not available — falling back to individual downloads.');
      this._downloadIndividual(state, results, stem);
      return;
    }

    // ── With JSZip ────────────────────────────────────────────────────────
    const zip = new window.JSZip();

    if (results.markdown) {
      zip.file(`${stem}.md`, results.markdown);
    }
    if (results.raw_text) {
      zip.file(`${stem}_raw.txt`, results.raw_text);
    }
    if (results.content_list) {
      zip.file(`${stem}_content_list.json`, JSON.stringify(results.content_list, null, 2));
    }
    if (results.middle_json) {
      zip.file(`${stem}_middle.json`, JSON.stringify(results.middle_json, null, 2));
    }
    if (results.model_output) {
      zip.file(`${stem}_model_output.json`, JSON.stringify(results.model_output, null, 2));
    }

    // Inline images
    if (results.images && typeof results.images === 'object') {
      const imgFolder = zip.folder('images');
      for (const [name, dataUrl] of Object.entries(results.images)) {
        const base64 = dataUrl.split(',')[1];
        if (base64) imgFolder.file(name, base64, { base64: true });
      }
    }

    // Benchmark CSV
    const csvRow_ = this._buildBenchmarkRow(state);
    const csv = [BENCHMARK_HEADERS.join(','), csvRow(csvRow_)].join('\n');
    zip.file(`${stem}_benchmark.csv`, csv);

    // Research CSV if applicable
    const history = state.get('researchRunHistory');
    if (history && history.length > 0) {
      // Re-use exportResearchCsv but capture string instead of downloading
      // Build inline
      const meta = this._staticMeta(state);
      const runRows = history.map((t, i) => {
        const total = t.total || (t.preprocessing + t.layoutAnalysis + t.ocr + t.postprocessing);
        return csvRow([
          i + 1, meta.file_name, meta.file_size_bytes, meta.page_count,
          meta.parse_method, meta.formula_enable, meta.table_enable,
          Math.round(total), Math.round(t.preprocessing ?? 0),
          Math.round(t.layoutAnalysis ?? 0), Math.round(t.ocr ?? 0),
          Math.round(t.postprocessing ?? 0),
          meta.execution_provider, meta.peak_memory_mb, meta.browser, meta.user_agent,
        ]);
      });
      zip.file(`${stem}_research_runs.csv`,
        [RESEARCH_HEADERS.join(','), ...runRows].join('\n'));
    }

    // Generate and download
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'),
      { href: url, download: `${stem}_rapidoc_output.zip` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // ── Individual file downloaders ───────────────────────────────────────────

  /**
   * Download individual output files (no ZIP).
   * @param {import('../state/appState.js').AppState} state
   * @param {object} results
   * @param {string} stem — base filename without extension
   */
  _downloadIndividual(state, results, stem) {
    if (results.markdown) {
      this._download(results.markdown, `${stem}.md`, 'text/markdown');
    }
    if (results.raw_text) {
      this._download(results.raw_text, `${stem}_raw.txt`, 'text/plain');
    }
    if (results.content_list) {
      this._download(JSON.stringify(results.content_list, null, 2),
        `${stem}_content_list.json`, 'application/json');
    }
    if (results.middle_json) {
      this._download(JSON.stringify(results.middle_json, null, 2),
        `${stem}_middle.json`, 'application/json');
    }
    if (results.model_output) {
      this._download(JSON.stringify(results.model_output, null, 2),
        `${stem}_model_output.json`, 'application/json');
    }
    this.exportBenchmarkCsv(state, `${stem}_benchmark.csv`);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Build the data row array for a single-run benchmark CSV.
   * @param {import('../state/appState.js').AppState} state
   * @returns {Array<string|number>}
   */
  _buildBenchmarkRow(state) {
    const meta    = this._staticMeta(state);
    const t       = state.get('timings');
    const total   = t.total || (t.preprocessing + t.layoutAnalysis + t.ocr + t.postprocessing);
    const results = state.get('results');
    const pages   = results?.page_count ?? state.get('progress').total ?? 1;

    return [
      meta.file_name,
      meta.file_size_bytes,
      pages,
      meta.parse_method,
      meta.formula_enable,
      meta.table_enable,
      Math.round(total),
      Math.round(t.preprocessing  ?? 0),
      Math.round(t.layoutAnalysis ?? 0),
      Math.round(t.ocr            ?? 0),
      Math.round(t.postprocessing ?? 0),
      meta.execution_provider,
      meta.peak_memory_mb,
      meta.browser,
      meta.user_agent,
    ];
  }

  /**
   * Extract static (non-timing) metadata from state.
   * @param {import('../state/appState.js').AppState} state
   * @returns {object}
   */
  _staticMeta(state) {
    const file = state.currentFile;
    const results = state.get('results');
    return {
      file_name:         file?.name ?? '',
      file_size_bytes:   file?.size ?? 0,
      page_count:        results?.page_count ?? state.get('progress').total ?? 1,
      parse_method:      state.get('parseMethod'),
      formula_enable:    state.get('formulaEnable') ? 1 : 0,
      table_enable:      state.get('tableEnable')   ? 1 : 0,
      execution_provider: state.get('activeExecutionProvider') ?? 'wasm',
      peak_memory_mb:    state.get('peakMemoryMb'),
      browser:           navigator.appName,
      user_agent:        navigator.userAgent,
    };
  }

  /**
   * Calculate per-stage means across a research run history array.
   * @param {import('../state/appState.js').Timings[]} history
   * @returns {Object.<string, number>}
   */
  _stageMeans(history) {
    const stages = ['preprocessing', 'layoutAnalysis', 'ocr', 'postprocessing'];
    const result = {};
    for (const stage of stages) {
      const values = history.map(t => t[stage] ?? 0);
      result[stage] = values.reduce((a, b) => a + b, 0) / values.length;
    }
    return result;
  }

  /**
   * Trigger a file download in the browser.
   * @param {string} content
   * @param {string} filename
   * @param {string} mime
   */
  _download(content, filename, mime) {
    const bom  = mime.includes('csv') ? '\uFEFF' : '';   // UTF-8 BOM for Excel CSV compat
    const blob = new Blob([bom + content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/** @type {ExportUtils} */
export const exportUtils = new ExportUtils();
