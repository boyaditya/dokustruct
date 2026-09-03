#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const INPUT_EXTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.webp', '.tif', '.tiff']);
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const SERVER_WAIT_MS = 45 * 1000;

function usage() {
  return `
Usage:
  npm run bench:js:supervised -- --input benchmark/sample/timing_images --out benchmark/js_timing --ep webgpu --repeat 10 --warmup 2 --mode final --pdf-pages-batch 8 --chunk-size 8

Options:
  --input <path>              Input file or directory. Required.
  --out <path>                Output directory. Default: benchmark/js_timing
  --ep <webgpu|wasm>          Execution provider. Default: webgpu
  --repeat <n>                Measured runs per file. Default: 10
  --warmup <n>                Warm-up runs per file. Default: 2
  --mode <strict|final>       benchmarkMode query value. Default: final
  --pdf-pages-batch <n>       PDF page window size. Default: 8 for webgpu, 64 for wasm
  --chunk-size <n>            Files per fresh browser session. Default: 8 for webgpu, 16 for wasm
  --retries <n>               Fresh browser retry count per chunk. Default: 1
  --no-split-on-failure       Do not bisect failed chunks after retries.
  --timeout-ms <n>            Per-chunk attempt timeout. Default: 1800000
  --url <url>                 Existing Vite URL. Default: start/use http://127.0.0.1:5173
  --port <n>                  Vite port when --url is omitted. Default: 5173
  --formula                   Enable formula recognition.
  --table                     Enable table recognition.
  --parse <auto|ocr|txt>      Parse method. Default: auto
  --channel <name>            Playwright browser channel, e.g. chrome.
  --headless                  Run headless. Default is headed/visible.
  --verbose                   Print browser console messages.
`;
}

function parseArgs(argv) {
  const positionals = [];
  const opts = {
    input: null,
    out: 'benchmark/js_timing',
    ep: 'webgpu',
    repeat: 10,
    warmup: 2,
    mode: 'final',
    pdfPagesBatch: null,
    chunkSize: null,
    retries: 1,
    splitOnFailure: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    url: null,
    port: 5173,
    formula: true,
    table: true,
    parse: 'auto',
    channel: null,
    headless: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };

    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--input') {
      opts.input = next();
    } else if (arg === '--out') {
      opts.out = next();
    } else if (arg === '--ep') {
      opts.ep = next();
    } else if (arg === '--repeat') {
      opts.repeat = parsePositiveInt(next(), arg);
    } else if (arg === '--warmup') {
      opts.warmup = parseNonNegativeInt(next(), arg);
    } else if (arg === '--mode') {
      opts.mode = next();
    } else if (arg === '--pdf-pages-batch') {
      opts.pdfPagesBatch = parsePositiveInt(next(), arg);
    } else if (arg === '--chunk-size') {
      opts.chunkSize = parsePositiveInt(next(), arg);
    } else if (arg === '--retries' || arg === '--max-retries') {
      opts.retries = parseNonNegativeInt(next(), arg);
    } else if (arg === '--no-split-on-failure') {
      opts.splitOnFailure = false;
    } else if (arg === '--timeout-ms') {
      opts.timeoutMs = parsePositiveInt(next(), arg);
    } else if (arg === '--url') {
      opts.url = next();
    } else if (arg === '--port') {
      opts.port = parsePositiveInt(next(), arg);
    } else if (arg === '--formula') {
      opts.formula = true;
    } else if (arg === '--table') {
      opts.table = true;
    } else if (arg === '--parse') {
      opts.parse = next();
    } else if (arg === '--channel') {
      opts.channel = next();
    } else if (arg === '--headless') {
      opts.headless = true;
    } else if (arg === '--verbose') {
      opts.verbose = true;
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (positionals.length) applyPositionalArgs(opts, positionals);
  if (opts.help) return opts;

  if (!opts.input) throw new Error('--input is required');
  if (!['webgpu', 'wasm'].includes(opts.ep)) throw new Error('--ep must be webgpu or wasm');
  if (!['strict', 'final'].includes(opts.mode)) throw new Error('--mode must be strict or final');
  if (!['auto', 'ocr', 'txt'].includes(opts.parse)) throw new Error('--parse must be auto, ocr, or txt');
  if (!opts.pdfPagesBatch) opts.pdfPagesBatch = opts.ep === 'webgpu' ? 8 : 64;
  if (!opts.chunkSize) opts.chunkSize = opts.ep === 'webgpu' ? 8 : 16;
  return opts;
}

function applyPositionalArgs(opts, values) {
  // npm 10 on this Windows environment strips unknown option names from
  // `npm run script -- --input x --out y`, leaving only positional values.
  const [
    input,
    out,
    ep,
    repeat,
    warmup,
    mode,
    pdfPagesBatch,
    chunkSize,
    retries,
    timeoutMs,
  ] = values;

  if (input && !opts.input) opts.input = input;
  if (out && opts.out === 'benchmark/js_timing') opts.out = out;
  if (ep && opts.ep === 'webgpu') opts.ep = ep;
  if (repeat && opts.repeat === 10) opts.repeat = parsePositiveInt(repeat, 'repeat');
  if (warmup && opts.warmup === 2) opts.warmup = parseNonNegativeInt(warmup, 'warmup');
  if (mode && opts.mode === 'final') opts.mode = mode;
  if (pdfPagesBatch && opts.pdfPagesBatch == null) {
    opts.pdfPagesBatch = parsePositiveInt(pdfPagesBatch, 'pdf-pages-batch');
  }
  if (chunkSize && opts.chunkSize == null) opts.chunkSize = parsePositiveInt(chunkSize, 'chunk-size');
  if (retries && opts.retries === 1) opts.retries = parseNonNegativeInt(retries, 'retries');
  if (timeoutMs && opts.timeoutMs === DEFAULT_TIMEOUT_MS) {
    opts.timeoutMs = parsePositiveInt(timeoutMs, 'timeout-ms');
  }
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function resolveFromRepo(p) {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

async function collectInputFiles(inputPath) {
  const abs = resolveFromRepo(inputPath);
  const stat = await fs.stat(abs);
  const files = [];

  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile() && INPUT_EXTS.has(path.extname(entry.name).toLowerCase())) {
        files.push(toInputFile(full, abs));
      }
    }
  }

  if (stat.isDirectory()) {
    await visit(abs);
  } else if (stat.isFile() && INPUT_EXTS.has(path.extname(abs).toLowerCase())) {
    files.push(toInputFile(abs, path.dirname(abs)));
  } else {
    throw new Error(`Unsupported input file type: ${abs}`);
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel));
  ensureUniqueStems(files);
  return files;
}

function toInputFile(abs, root) {
  return {
    abs,
    rel: path.relative(root, abs) || path.basename(abs),
    name: path.basename(abs),
    stem: path.basename(abs).replace(/\.[^.]+$/, ''),
  };
}

function ensureUniqueStems(files) {
  const seen = new Map();
  for (const file of files) {
    const prev = seen.get(file.stem);
    if (prev) {
      throw new Error(
        `Duplicate output stem "${file.stem}" for "${prev.rel}" and "${file.rel}". ` +
        'Rename one input file before running supervised benchmark.',
      );
    }
    seen.set(file.stem, file);
  }
}

function chunkFiles(files, size) {
  const chunks = [];
  for (let i = 0; i < files.length; i += size) chunks.push(files.slice(i, i + size));
  return chunks;
}

async function urlReachable(url) {
  try {
    const response = await fetch(url, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer(opts) {
  if (opts.url) {
    if (!(await urlReachable(opts.url))) throw new Error(`Benchmark URL is not reachable: ${opts.url}`);
    return { baseUrl: opts.url.replace(/\/$/, ''), process: null };
  }

  const baseUrl = `http://127.0.0.1:${opts.port}`;
  if (await urlReachable(`${baseUrl}/benchmark.html`)) return { baseUrl, process: null };

  const child = spawn(
    'npm',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(opts.port), '--strictPort', 'true'],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    },
  );

  const logs = [];
  child.stdout.on('data', data => logs.push(String(data)));
  child.stderr.on('data', data => logs.push(String(data)));

  const deadline = Date.now() + SERVER_WAIT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`Vite dev server exited early:\n${logs.join('').trim()}`);
    }
    if (await urlReachable(`${baseUrl}/benchmark.html`)) return { baseUrl, process: child };
    await delay(500);
  }

  stopProcessTree(child);
  throw new Error(`Timed out waiting for Vite at ${baseUrl}:\n${logs.join('').trim()}`);
}

function stopProcessTree(child) {
  if (!child || child.killed || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function buildBenchmarkUrl(baseUrl, opts) {
  const query = new URLSearchParams({
    benchmarkMode: opts.mode,
    automation: '1',
    strictEp: '1',
    ep: opts.ep,
    repeat: String(opts.repeat),
    warmup: String(opts.warmup),
    pdfPagesBatch: String(opts.pdfPagesBatch),
    formula: String(opts.formula),
    table: String(opts.table),
    parse: opts.parse,
  });
  return `${baseUrl}/benchmark.html?${query.toString()}`;
}

function launchArgs() {
  return [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
}

async function launchContext(userDataDir, opts) {
  const baseOptions = {
    headless: opts.headless,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: false,
    args: launchArgs(),
  };

  if (opts.channel) {
    return chromium.launchPersistentContext(userDataDir, { ...baseOptions, channel: opts.channel });
  }

  try {
    return await chromium.launchPersistentContext(userDataDir, { ...baseOptions, channel: 'chrome' });
  } catch (err) {
    console.warn(`[warn] Chrome channel launch failed, falling back to bundled Chromium: ${err.message}`);
    return chromium.launchPersistentContext(userDataDir, baseOptions);
  }
}

async function runChunkAttempt(files, opts, baseUrl, attempt, chunkId) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rapiddoc-bench-'));
  let context = null;
  let page = null;
  let pageCrashed = false;
  const consoleTail = [];
  const pageErrors = [];
  const startedAt = new Date().toISOString();

  try {
    context = await launchContext(userDataDir, opts);
    page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(Math.min(opts.timeoutMs, 120000));

    page.on('crash', () => { pageCrashed = true; });
    page.on('pageerror', err => {
      pageErrors.push(String(err?.message ?? err));
    });
    page.on('console', msg => {
      const entry = `[${msg.type()}] ${msg.text()}`;
      if (opts.verbose) console.log(`  ${entry}`);
      if (msg.type() === 'error' || msg.type() === 'warning') {
        consoleTail.push(entry);
        if (consoleTail.length > 80) consoleTail.shift();
      }
    });

    const browserVersion = context.browser()?.version() ?? null;
    await page.goto(buildBenchmarkUrl(baseUrl, opts), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => Boolean(window.__RAPIDDOC_BENCHMARK__));
    await page.setInputFiles('#fileInput', files.map(file => file.abs));

    const statusBefore = await page.evaluate(() => window.__RAPIDDOC_BENCHMARK__.status());
    await withTimeout(
      page.evaluate(() => window.__RAPIDDOC_BENCHMARK__.start()),
      opts.timeoutMs,
      `chunk ${chunkId} attempt ${attempt}`,
    );
    const status = await page.evaluate(() => window.__RAPIDDOC_BENCHMARK__.status());
    const exportData = await page.evaluate(() => window.__RAPIDDOC_BENCHMARK__.getExportData());
    const logs = await page.evaluate(() => window.__RAPIDDOC_BENCHMARK__.getLogs());

    if (pageCrashed) throw new Error('Page crashed during benchmark attempt');
    if (!exportData) throw new Error('Benchmark finished without export data');

    const strictViolation = opts.ep === 'webgpu' && status.effective_execution_provider !== 'webgpu';
    const finalFailures = (exportData.failures || []).filter(f => f.final && !f.recovered);
    const failedNames = new Set(finalFailures.map(f => f.filename));
    const exportedStems = new Set(Object.keys(exportData.files || {}));
    const successfulFiles = strictViolation
      ? []
      : files.filter(file => exportedStems.has(file.stem) && !failedNames.has(file.name));
    const failedFiles = strictViolation
      ? files
      : files.filter(file => !exportedStems.has(file.stem) || failedNames.has(file.name));

    let error = null;
    if (strictViolation) {
      error = `Strict EP violation: effective EP is ${status.effective_execution_provider}`;
    } else if (failedFiles.length) {
      error = `Chunk reported ${failedFiles.length}/${files.length} failed file(s)`;
    }

    return {
      ok: !error,
      partial: successfulFiles.length > 0 && failedFiles.length > 0,
      files,
      successfulFiles,
      failedFiles,
      attempt,
      chunkId,
      startedAt,
      finishedAt: new Date().toISOString(),
      browserVersion,
      statusBefore,
      status,
      exportData,
      logs,
      consoleTail,
      pageErrors,
      error,
      pageCrashed,
    };
  } catch (err) {
    return {
      ok: false,
      partial: false,
      files,
      successfulFiles: [],
      failedFiles: files,
      attempt,
      chunkId,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: String(err?.message ?? err),
      pageCrashed,
      consoleTail,
      pageErrors,
    };
  } finally {
    try {
      await context?.close();
    } catch {
      // Ignore cleanup errors; the attempt outcome above is what matters.
    }
    try {
      await fs.rm(userDataDir, { recursive: true, force: true });
    } catch {
      // Best effort temp cleanup.
    }
  }
}

async function writeFileArtifact(outDir, file, payload) {
  await fs.writeFile(
    path.join(outDir, `${file.stem}_timing.json`),
    `${JSON.stringify(payload.timing, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(outDir, `${file.stem}_content_list.json`),
    `${JSON.stringify(payload.content_list, null, 2)}\n`,
  );
}

async function saveSuccessfulFiles(ctx, result) {
  let saved = 0;
  if (!result.exportData) return saved;

  for (const file of result.successfulFiles) {
    if (ctx.completedStems.has(file.stem) || ctx.failedStems.has(file.stem)) continue;
    const payload = result.exportData.files?.[file.stem];
    if (!payload?.timing || !payload?.content_list) continue;

    await writeFileArtifact(ctx.outDir, file, payload);
    ctx.combined.files[file.stem] = payload;
    ctx.combined.run_config ??= result.exportData.run_config ?? payload.timing?.run_config ?? null;
    ctx.combined.metadata = {
      ...(result.exportData.metadata || {}),
      ...ctx.combined.metadata,
      browser_versions: ctx.manifest.browser_versions,
    };
    ctx.completedStems.add(file.stem);
    ctx.manifest.totals.succeeded++;
    saved++;
  }

  return saved;
}

function makeEmptyCombined(opts, campaignId) {
  return {
    metadata: {
      benchmark_mode: opts.mode,
      automation_mode: true,
      supervised_runner: true,
      isolation_strategy: 'chunked_context',
      campaign_id: campaignId,
      timestamp: new Date().toISOString(),
      execution_provider: opts.ep,
      effective_execution_provider: opts.ep,
      strict_ep: true,
      repeat: opts.repeat,
      warmup_runs: opts.warmup,
      pdf_pages_batch: opts.pdfPagesBatch,
      chunk_size: opts.chunkSize,
      split_on_failure: opts.splitOnFailure,
      formula_enable: opts.formula,
      table_enable: opts.table,
      parse_method: opts.parse,
      failure_count: 0,
      final_failure_count: 0,
      retry_count: 0,
      crash_count: 0,
      failed_files: [],
    },
    run_config: null,
    failures: [],
    files: {},
  };
}

function makeManifest(opts, campaignId, inputFiles, outDir) {
  return {
    campaign_id: campaignId,
    started_at: new Date().toISOString(),
    finished_at: null,
    input: path.resolve(resolveFromRepo(opts.input)),
    output: outDir,
    requested: {
      ep: opts.ep,
      strict_ep: true,
      repeat: opts.repeat,
      warmup: opts.warmup,
      benchmark_mode: opts.mode,
      pdf_pages_batch: opts.pdfPagesBatch,
      chunk_size: opts.chunkSize,
      split_on_failure: opts.splitOnFailure,
      formula: opts.formula,
      table: opts.table,
      parse: opts.parse,
      retries: opts.retries,
      timeout_ms: opts.timeoutMs,
      headless: opts.headless,
      channel: opts.channel ?? 'chrome-with-chromium-fallback',
    },
    totals: {
      files: inputFiles.length,
      succeeded: 0,
      failed: 0,
      chunks: 0,
      split_chunks: 0,
      attempts: 0,
      retries: 0,
      crashes: 0,
    },
    browser_versions: [],
    attempts: [],
    failed_files: [],
  };
}

async function persistCampaign(ctx) {
  updateCombinedMetadata(ctx);
  await fs.writeFile(ctx.combinedPath, `${JSON.stringify(ctx.combined, null, 2)}\n`);
  await fs.writeFile(ctx.manifestPath, `${JSON.stringify(ctx.manifest, null, 2)}\n`);
}

function updateCombinedMetadata(ctx) {
  ctx.combined.metadata.failure_count = ctx.combined.failures.length;
  ctx.combined.metadata.final_failure_count = ctx.manifest.totals.failed;
  ctx.combined.metadata.retry_count = ctx.manifest.totals.retries;
  ctx.combined.metadata.crash_count = ctx.manifest.totals.crashes;
  ctx.combined.metadata.chunk_count = ctx.manifest.totals.chunks;
  ctx.combined.metadata.split_chunk_count = ctx.manifest.totals.split_chunks;
  ctx.combined.metadata.files_succeeded = ctx.manifest.totals.succeeded;
  ctx.combined.metadata.files_failed = ctx.manifest.totals.failed;
  ctx.combined.metadata.failed_files = ctx.manifest.failed_files.map(f => f.input_path);
}

async function processChunk(files, ctx, depth = 0) {
  const pending = files.filter(file => !ctx.completedStems.has(file.stem) && !ctx.failedStems.has(file.stem));
  if (!pending.length) return;

  const chunkId = ++ctx.nextChunkId;
  ctx.manifest.totals.chunks++;
  console.log(`[chunk ${chunkId}] ${pending.length} file(s), depth=${depth}`);

  let remaining = pending;
  let lastResult = null;

  for (let attempt = 1; attempt <= ctx.opts.retries + 1; attempt++) {
    ctx.manifest.totals.attempts++;
    if (attempt > 1) ctx.manifest.totals.retries++;
    console.log(`  attempt ${attempt}/${ctx.opts.retries + 1}: ${remaining.length} pending file(s)`);

    const result = await runChunkAttempt(remaining, ctx.opts, ctx.baseUrl, attempt, chunkId);
    lastResult = result;
    ctx.manifest.attempts.push(summarizeAttempt(result));

    if (result.browserVersion && !ctx.manifest.browser_versions.includes(result.browserVersion)) {
      ctx.manifest.browser_versions.push(result.browserVersion);
    }
    if (result.pageCrashed) ctx.manifest.totals.crashes++;

    const saved = await saveSuccessfulFiles(ctx, result);
    if (saved) console.log(`  saved ${saved} successful file(s) from chunk ${chunkId}`);

    remaining = remaining.filter(file => !ctx.completedStems.has(file.stem));
    if (result.ok || remaining.length === 0) {
      console.log(`  ok: chunk ${chunkId} complete`);
      await persistCampaign(ctx);
      return;
    }

    console.log(`  failed: ${result.error}`);
  }

  remaining = remaining.filter(file => !ctx.completedStems.has(file.stem) && !ctx.failedStems.has(file.stem));
  if (!remaining.length) {
    await persistCampaign(ctx);
    return;
  }

  if (ctx.opts.splitOnFailure && remaining.length > 1) {
    ctx.manifest.totals.split_chunks++;
    const mid = Math.ceil(remaining.length / 2);
    console.log(`  splitting chunk ${chunkId}: ${mid} + ${remaining.length - mid}`);
    await processChunk(remaining.slice(0, mid), ctx, depth + 1);
    await processChunk(remaining.slice(mid), ctx, depth + 1);
    return;
  }

  for (const file of remaining) {
    recordFinalFailure(ctx, file, lastResult?.error ?? 'chunk failed after retries', ctx.opts.retries + 1);
  }
  await persistCampaign(ctx);
}

function recordFinalFailure(ctx, file, error, attempts) {
  if (ctx.completedStems.has(file.stem) || ctx.failedStems.has(file.stem)) return;
  const failure = {
    filename: file.name,
    input_path: file.rel,
    final: true,
    recovered: false,
    error,
    attempts,
  };
  ctx.failedStems.add(file.stem);
  ctx.combined.failures.push(failure);
  ctx.manifest.failed_files.push(failure);
  ctx.manifest.totals.failed++;
  console.log(`  final failure: ${file.rel}: ${error}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage().trim());
    return;
  }

  const outDir = resolveFromRepo(opts.out);
  const inputFiles = await collectInputFiles(opts.input);
  await fs.mkdir(outDir, { recursive: true });

  if (!inputFiles.length) throw new Error(`No benchmark input files found in ${opts.input}`);

  const campaignId = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const ctx = {
    opts,
    outDir,
    baseUrl: null,
    combinedPath: path.join(outDir, `benchmark_js_supervised_${campaignId}.json`),
    manifestPath: path.join(outDir, `benchmark_js_supervised_manifest_${campaignId}.json`),
    combined: makeEmptyCombined(opts, campaignId),
    manifest: makeManifest(opts, campaignId, inputFiles, outDir),
    completedStems: new Set(),
    failedStems: new Set(),
    nextChunkId: 0,
  };

  console.log(
    `[info] Supervised JS benchmark: ${inputFiles.length} file(s), ` +
    `chunkSize=${opts.chunkSize}, ep=${opts.ep}, strictEp=true`,
  );
  console.log(`[info] Output: ${outDir}`);

  const server = await ensureServer(opts);
  ctx.baseUrl = server.baseUrl;
  console.log(`[info] Benchmark URL: ${server.baseUrl}/benchmark.html`);

  try {
    const chunks = chunkFiles(inputFiles, opts.chunkSize);
    for (const [index, chunk] of chunks.entries()) {
      console.log(`[batch ${index + 1}/${chunks.length}] ${chunk.length} file(s)`);
      await processChunk(chunk, ctx);
      await persistCampaign(ctx);
    }
  } finally {
    ctx.manifest.finished_at = new Date().toISOString();
    await persistCampaign(ctx);
    stopProcessTree(server.process);
  }

  console.log(`[done] ${ctx.manifest.totals.succeeded} succeeded, ${ctx.manifest.totals.failed} failed`);
  console.log(`[done] Chunks: ${ctx.manifest.totals.chunks}, attempts: ${ctx.manifest.totals.attempts}`);
  console.log(`[done] Combined JSON: ${ctx.combinedPath}`);
  console.log(`[done] Manifest: ${ctx.manifestPath}`);

  if (ctx.manifest.totals.failed > 0) process.exitCode = 1;
}

function summarizeAttempt(result) {
  return {
    chunk_id: result.chunkId,
    chunk_size: result.files.length,
    filenames: result.files.map(file => file.name),
    input_paths: result.files.map(file => file.rel),
    attempt: result.attempt,
    ok: result.ok,
    partial: result.partial,
    started_at: result.startedAt,
    finished_at: result.finishedAt,
    browser_version: result.browserVersion ?? null,
    status: result.status ?? null,
    exported_files: result.successfulFiles.map(file => file.rel),
    failed_files: result.failedFiles.map(file => file.rel),
    error: result.ok ? null : result.error,
    page_crashed: result.pageCrashed ?? false,
    console_tail: result.consoleTail ?? [],
    page_errors: result.pageErrors ?? [],
  };
}

main().catch(err => {
  console.error(`[fatal] ${err?.message ?? err}`);
  process.exitCode = 2;
});
