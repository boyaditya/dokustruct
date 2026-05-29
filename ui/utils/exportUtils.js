import JSZip from 'jszip';

function resultArtifact(results, ...keys) {
  for (const key of keys) {
    const value = results?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

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

/** Round to 4 decimal places */
function round4(v) {
  return Math.round(v * 10000) / 10000;
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

  // ── Benchmark JSON (unified format for evaluate.py) ─────────────────────

  /**
   * Export a unified timing JSON for one run, compatible with the Python
   * batch runner output. Both JS and Python produce the same schema so
   * benchmark/evaluate.py can read them without conversion.
   *
   * Schema (all time values in seconds AND milliseconds for compatibility):
   *   filename, page_count,
   *   total_s, model_init_s, layout_s, ocr_s, formula_s, table_s,
   *   postprocess_s, total_inference_s,
   *   total_ms, layout_ms, ocr_ms, formula_ms, table_ms, postprocessing_ms
   *
   * @param {import('../state/appState.js').AppState} state
   * @param {string} [filenameOverride]
   */
  exportBenchmarkJson(state, filenameOverride) {
    const file    = state.currentFile;
    const results = state.get('results');
    const t       = state.get('timings');
    const meta    = this._staticMeta(state);

    const totalMs       = t.total ?? 0;
    const layoutMs      = t.layout ?? 0;
    const modelInitMs   = t.model_init ?? 0;
    const ocrMs         = t.ocr ?? 0;
    const formulaMs     = t.formula ?? 0;
    const tableMs       = t.table ?? 0;
    const postMs        = t.postprocessing ?? 0;
    const inferenceMs   = layoutMs + ocrMs + formulaMs + tableMs;

    const unified = {
      filename:            file?.name ?? results?.fileName ?? '',
      page_count:          results?.page_count ?? meta.page_count ?? 0,
      // Seconds (primary — matches Python output)
      total_s:             round4(totalMs / 1000),
      model_init_s:        round4(modelInitMs / 1000),
      layout_s:            round4(layoutMs / 1000),
      ocr_s:               round4(ocrMs / 1000),
      formula_s:           round4(formulaMs / 1000),
      table_s:             round4(tableMs / 1000),
      postprocess_s:       round4(postMs / 1000),
      total_inference_s:   round4(inferenceMs / 1000),
      // Milliseconds (secondary — for compatibility with existing CSV exports)
      total_ms:            Math.round(totalMs),
      model_init_ms:       Math.round(modelInitMs),
      layout_ms:           Math.round(layoutMs),
      ocr_ms:              Math.round(ocrMs),
      formula_ms:          Math.round(formulaMs),
      table_ms:            Math.round(tableMs),
      postprocessing_ms:   Math.round(postMs),
      // Metadata
      execution_provider:  meta.execution_provider,
      formula_enable:      meta.formula_enable,
      table_enable:        meta.table_enable,
      parse_method:        meta.parse_method,
      browser:             meta.browser,
      user_agent:          meta.user_agent,
    };

    const stem  = (file?.name || 'output').replace(/\.[^.]+$/, '');
    const fname = filenameOverride ?? `${stem}_timing.json`;
    this._download(
      JSON.stringify(unified, null, 2),
      fname,
      'application/json',
    );
  }

  /**
   * Export content_list JSON for one run (for benchmark/evaluate.py).
   * @param {import('../state/appState.js').AppState} state
   * @param {string} [filenameOverride]
   */
  exportContentListJson(state, filenameOverride) {
    const results     = state.get('results');
    const contentList = resultArtifact(results, 'content_list', 'contentList', 'content_list_json');
    if (!contentList) {
      console.warn('[exportUtils] No content_list available to export.');
      return;
    }
    const file  = state.currentFile;
    const stem  = (file?.name || 'output').replace(/\.[^.]+$/, '');
    const fname = filenameOverride ?? `${stem}_content_list.json`;
    this._download(
      JSON.stringify(contentList, null, 2),
      fname,
      'application/json',
    );
  }

  /**
   * Export both timing JSON and content_list JSON in one call.
   * Convenience wrapper for the benchmark workflow.
   * @param {import('../state/appState.js').AppState} state
   */
  exportBenchmarkPair(state) {
    this.exportBenchmarkJson(state);
    this.exportContentListJson(state);
  }

  // ── ZIP bundle ────────────────────────────────────────────────────────────

  /**
   * Export a ZIP archive containing all available output files.
   * Uses the bundled JSZip dependency.
   * Falls back to individual downloads if JSZip not available.
   *
   * @param {import('../state/appState.js').AppState} state
   */
  async exportZipBundle(state) {
    const results = state.get('results');
    if (!results) return;

    const file = state.currentFile;
    const stem = (file?.name || results.fileName || 'output').replace(/\.[^.]+$/, '');

    // ── Without JSZip: individual downloads ───────────────────────────────
    // ── With JSZip ────────────────────────────────────────────────────────
    const zip = new JSZip();
    const contentList = resultArtifact(results, 'content_list', 'contentList', 'content_list_json');
    const middleJson = resultArtifact(results, 'middle_json', 'middleJson', 'layout_info');
    const modelJson = resultArtifact(results, 'model_output', 'modelOutput', 'modelJson');

    if (results.markdown) {
      zip.file(`${stem}.md`, results.markdown);
    }
    if (results.raw_text) {
      zip.file(`${stem}_raw.txt`, results.raw_text);
    }
    if (contentList) {
      zip.file(`${stem}_content_list.json`, JSON.stringify(contentList, null, 2));
    }
    if (middleJson) {
      zip.file(`${stem}_middle.json`, JSON.stringify(middleJson, null, 2));
    }
    if (modelJson) {
      zip.file(`${stem}_model.json`, JSON.stringify(modelJson, null, 2));
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
    const contentList = resultArtifact(results, 'content_list', 'contentList', 'content_list_json');
    const middleJson = resultArtifact(results, 'middle_json', 'middleJson', 'layout_info');
    const modelJson = resultArtifact(results, 'model_output', 'modelOutput', 'modelJson');

    if (results.markdown) {
      this._download(results.markdown, `${stem}.md`, 'text/markdown');
    }
    if (results.raw_text) {
      this._download(results.raw_text, `${stem}_raw.txt`, 'text/plain');
    }
    if (contentList) {
      this._download(JSON.stringify(contentList, null, 2),
        `${stem}_content_list.json`, 'application/json');
    }
    if (middleJson) {
      this._download(JSON.stringify(middleJson, null, 2),
        `${stem}_middle.json`, 'application/json');
    }
    if (modelJson) {
      this._download(JSON.stringify(modelJson, null, 2),
        `${stem}_model.json`, 'application/json');
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
    const total   = t.total || (t.preprocessing + t.layout + t.ocr + t.postprocessing);
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
      Math.round(t.layout ?? 0),
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
    const results = state.get('results');
    return {
      file_name:         state.currentFile?.name ?? results?.fileName ?? '',
      file_size_bytes:   state.currentFile?.size ?? results?.fileSize ?? 0,
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
