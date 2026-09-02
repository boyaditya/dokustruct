/**
 * PORTING NOTE: demo.py → demo.js
 *
 * WORKAROUND 1: python-dotenv / os.environ
 * REASON: Environment variables don't exist in the browser security model.
 * SOLUTION: Configuration is injected via globalThis.__RAPIDDOC_CONFIG__ and
 *   globalThis.__RAPIDDOC_DEVICE__. See rapid_doc/utils/config_reader.js and
 *   rapid_doc/utils/os_env_config.js for the browser configuration pattern.
 * AFFECTED METHODS: top-level env setup block
 *
 * WORKAROUND 2: File-based input paths (os.path, pathlib.Path, open())
 * REASON: Browser has no direct filesystem access.
 * SOLUTION: parseDoc() accepts File objects (from <input type="file">) or
 *   ArrayBuffers. read_fn is replaced with arrayBufferFromFile.
 *   PDF bytes are obtained directly as ArrayBuffer / Uint8Array.
 * AFFECTED METHODS: parseDom, parseDoc
 *
 * WORKAROUND 3: loguru logger
 * REASON: loguru is Python-only.
 * SOLUTION: console.info / console.error / console.warn used directly.
 * AFFECTED METHODS: all logging calls
 *
 * WORKAROUND 4: time.time()
 * REASON: Python time module not available.
 * SOLUTION: performance.now() for high-resolution timing (milliseconds).
 *   Divide by 1000 where seconds are displayed.
 * AFFECTED METHODS: all timing blocks
 *
 * WORKAROUND 5: FileBasedDataWriter output
 * REASON: Cannot write to an arbitrary directory on disk from the browser.
 * SOLUTION: Output is collected in an in-memory ResultCollector object and
 *   returned to the caller. Named exports allow individual flags to be set.
 *   Actual persistence (IndexedDB, download, etc.) is left to the caller.
 * AFFECTED METHODS: do_parse
 *
 * WORKAROUND 6: convert_pdf_bytes_to_bytes_by_pypdfium2
 * REASON: pypdfium2-based page slicing not available in browser.
 * SOLUTION: Delegate to the imported convertPdfBytesToBytesByPypdfium2 which
 *   is already ported with PDF.js. Falls back to returning the original bytes
 *   if the JS port is not yet available.
 * AFFECTED METHODS: do_parse
 */

import { docAnalyze as pipelineDocAnalyze } from './rapid_doc/backend/pipeline/pipeline_analyze.js';
import { unionMake as pipelineUnionMake } from './rapid_doc/backend/pipeline/pipeline_middle_json_mkcontent.js';
import { resultToMiddleJson as pipelineResultToMiddleJson } from './rapid_doc/backend/pipeline/model_json_to_middle_json.js';
import { MemoryDataWriter } from './rapid_doc/data/data_reader_writer/index.js';
import { drawLayoutBbox, drawSpanBbox } from './rapid_doc/utils/draw_bbox.js';
import { MakeMode } from './rapid_doc/utils/enum_class.js';
import { convertPdfBytesToBytesByPypdfium2, prepareEnv } from './rapid_doc/cli/common.js';
import { markdownToHtml } from './rapid_doc/utils/markdown_to_html.js';
import { markdownToDocx } from './rapid_doc/utils/markdown_to_word.js';

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/**
 * Return the device string: 'webgpu' if the browser supports WebGPU, else 'wasm'.
 *
 * @returns {'webgpu'|'wasm'}
 */
export function getDevice() {
  return (typeof navigator !== 'undefined' && navigator.gpu) ? 'webgpu' : 'wasm';
}

// ---------------------------------------------------------------------------
// Result container
// ---------------------------------------------------------------------------

/**
 * Holds all outputs produced by do_parse for a single PDF.
 */
export class ParseResult {
  /** @type {string} */ pdfFileName = '';
  /** @type {Uint8Array|null} */ originPdfBytes = null;
  /** @type {string|null} */ mdContent = null;
  /** @type {string|null} */ htmlContent = null;
  /** @type {Uint8Array|null} */ docxContent = null;
  /** @type {object|null} */ middleJson = null;
  /** @type {object|null} */ modelJson = null;
  /** @type {object|null} */ contentList = null;
  /** @type {Uint8Array|null} */ layoutPdfBytes = null;
  /** @type {Uint8Array|null} */ spanPdfBytes = null;
  /** @type {Map<string,Uint8Array>} */ images = new Map();
}

// ---------------------------------------------------------------------------
// Core parsing
// ---------------------------------------------------------------------------

/**
 * Parse a list of PDF documents and return results for each.
 *
 * This is the main entry point, analogous to demo.py's do_parse.
 *
 * @param {object} opts
 * @param {string[]} opts.pdfFileNames - Logical file name for each PDF (no extension).
 * @param {Uint8Array[]|ArrayBuffer[]} opts.pdfBytesList - Raw PDF bytes for each file.
 * @param {string} [opts.parseMethod='auto'] - 'auto' | 'txt' | 'ocr'
 * @param {boolean} [opts.formulaEnable=true]
 * @param {boolean} [opts.tableEnable=true]
 * @param {boolean} [opts.drawLayoutBboxFlag=true]
 * @param {boolean} [opts.drawSpanBboxFlag=true]
 * @param {boolean} [opts.dumpMd=true]
 * @param {boolean} [opts.dumpMiddleJson=true]
 * @param {boolean} [opts.dumpModelOutput=true]
 * @param {boolean} [opts.dumpOrigPdf=true]
 * @param {boolean} [opts.dumpContentList=true]
 * @param {boolean} [opts.dumpMdHtml=false]
 * @param {boolean} [opts.dumpMdDocx=false]
 * @param {string} [opts.makeMdMode=MakeMode.MM_MD]
 * @param {number} [opts.startPageId=0]
 * @param {number|null} [opts.endPageId=null]
 * @param {object} [opts.layoutConfig={}]
 * @param {object} [opts.ocrConfig={}]
 * @param {object} [opts.formulaConfig={}]
 * @param {object} [opts.tableConfig={}]
 * @param {object} [opts.checkboxConfig={}]
 * @param {object} [opts.imageConfig={}]
 * @param {function(string, number):void} [opts.onProgress] - Optional progress callback (pdfName, 0-100).
 * @returns {Promise<ParseResult[]>} One ParseResult per input PDF.
 */
export async function doParse({
  pdfFileNames,
  pdfBytesList,
  parseMethod = 'auto',
  formulaEnable = true,
  tableEnable = true,
  drawLayoutBboxFlag = true,
  drawSpanBboxFlag = true,
  dumpMd = true,
  dumpMiddleJson = true,
  dumpModelOutput = true,
  dumpOrigPdf = true,
  dumpContentList = true,
  dumpMdHtml = false,
  dumpMdDocx = false,
  makeMdMode = MakeMode.MM_MD,
  startPageId = 0,
  endPageId = null,
  layoutConfig = {},
  ocrConfig = {},
  formulaConfig = {},
  tableConfig = {},
  checkboxConfig = {},
  imageConfig = {},
  onProgress = null,
} = {}) {
  // ---- 1. Slice pages (equivalent to convert_pdf_bytes_to_bytes_by_pypdfium2) ----
  const slicedBytesList = [];
  for (const pdfBytes of pdfBytesList) {
    try {
      const sliced = await convertPdfBytesToBytesByPypdfium2(pdfBytes, startPageId, endPageId);
      slicedBytesList.push(sliced);
    } catch (e) {
      console.warn(`Page-slice failed, using original bytes: ${e}`);
      slicedBytesList.push(pdfBytes instanceof ArrayBuffer ? new Uint8Array(pdfBytes) : pdfBytes);
    }
  }

  // ---- 2. Run inference pipeline ----
  const t0 = performance.now();
  const [inferResults, allImageLists, allPageDicts, langList, ocrEnabledList] =
    await pipelineDocAnalyze(slicedBytesList, {
      parseMethod,
      formulaEnable,
      tableEnable,
      layoutConfig,
      ocrConfig,
      formulaConfig,
      tableConfig,
      checkboxConfig,
    });
  console.info(`推理耗时: ${((performance.now() - t0) / 1000).toFixed(2)}秒`);

  // ---- 3. Post-process each PDF ----
  const results = [];

  for (let idx = 0; idx < inferResults.length; idx++) {
    const t1 = performance.now();
    const modelList = inferResults[idx];
    const modelJson = JSON.parse(JSON.stringify(modelList)); // deepcopy
    const pdfFileName = pdfFileNames[idx];
    const imageWriter = new MemoryDataWriter();
    const mdWriter = new MemoryDataWriter();

    const imagesList = allImageLists[idx];
    const pdfDict = allPageDicts[idx];
    const lang = langList[idx];
    const ocrEnabled = ocrEnabledList[idx];

    const middleJson = await pipelineResultToMiddleJson(
      modelList,
      imagesList,
      pdfDict,
      imageWriter,
      lang,
      ocrEnabled,
      formulaEnable,
      { ocrConfig, imageConfig },
    );

    console.info(`运行时间: ${((performance.now() - t1) / 1000).toFixed(2)}秒`);

    const result = new ParseResult();
    result.pdfFileName = pdfFileName;
    result.middleJson = middleJson;
    result.images = imageWriter.files;

    const pdfInfo = middleJson.pdf_info;
    let pdfBytes = slicedBytesList[idx];

    // Detect if input is an image (PNG, JPEG, BMP) using magic bytes
    const isImage = pdfBytes && pdfBytes.length > 0 && 
                    (pdfBytes[0] === 0x89 || pdfBytes[0] === 0xFF || pdfBytes[0] === 0x42);

    if (!isImage) {
      if (drawLayoutBboxFlag) {
        try {
          const bytesCopy = pdfBytes instanceof Uint8Array ? pdfBytes.slice(0) : new Uint8Array(pdfBytes).slice(0);
          result.layoutPdfBytes = await drawLayoutBbox(pdfInfo, bytesCopy, `${pdfFileName}_layout.pdf`);
        } catch (e) { console.warn(`drawLayoutBbox failed: ${e}`); }
      }

      if (drawSpanBboxFlag) {
        try {
          const bytesCopy = pdfBytes instanceof Uint8Array ? pdfBytes.slice(0) : new Uint8Array(pdfBytes).slice(0);
          result.spanPdfBytes = await drawSpanBbox(pdfInfo, bytesCopy, `${pdfFileName}_span.pdf`);
        } catch (e) { console.warn(`drawSpanBbox failed: ${e}`); }
      }
    }

    if (dumpOrigPdf) {
      result.originPdfBytes = pdfBytes instanceof Uint8Array ? pdfBytes.slice(0) : new Uint8Array(pdfBytes).slice(0);
    }

    if (dumpMd) {
      const imageDir = 'images';
      result.mdContent = await pipelineUnionMake(pdfInfo, makeMdMode, imageDir);

      if (dumpMdHtml && result.mdContent) {
        try {
          result.htmlContent = await markdownToHtml(result.mdContent, {
            title: pdfFileName,
            embedImages: false,
          });
        } catch (e) { console.warn(`Markdown转HTML失败: ${e}`); }
      }

      if (dumpMdDocx && result.mdContent) {
        try {
          result.docxContent = await markdownToDocx(result.mdContent, {});
        } catch (e) { console.warn(`Markdown转docx失败: ${e}`); }
      }
    }

    if (dumpContentList) {
      const imageDir = 'images';
      result.contentList = await pipelineUnionMake(pdfInfo, MakeMode.CONTENT_LIST, imageDir);
    }

    if (dumpModelOutput) {
      result.modelJson = modelJson;
    }

    if (onProgress) {
      try { onProgress(pdfFileName, 100); } catch (_) {}
    }

    console.info(`[${pdfFileName}] parse complete`);
    results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// High-level convenience wrapper (mirrors demo.py parse_doc)
// ---------------------------------------------------------------------------

/**
 * Parse a list of PDF files (given as File objects or {name, data} objects)
 * and return the structured results.
 *
 * @param {Array<File|{name:string, data:ArrayBuffer|Uint8Array}>} fileList
 * @param {object} [opts] - Forwarded to doParse.
 * @returns {Promise<ParseResult[]>}
 */
export async function parseDoc(fileList, opts = {}) {
  try {
    const pdfFileNames = [];
    const pdfBytesList = [];

    for (const f of fileList) {
      let name, data;
      if (f instanceof File) {
        name = f.name.replace(/\.[^/.]+$/, ''); // stem
        data = new Uint8Array(await f.arrayBuffer());
      } else {
        name = (f.name || 'document').replace(/\.[^/.]+$/, '');
        data = f.data instanceof ArrayBuffer ? new Uint8Array(f.data) : f.data;
      }
      pdfFileNames.push(name);
      pdfBytesList.push(data);
    }

    return await doParse({ pdfFileNames, pdfBytesList, ...opts });
  } catch (e) {
    console.error(e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Browser entry point helper
// ---------------------------------------------------------------------------

/**
 * Wire up a file input element so that selecting a PDF automatically parses it.
 *
 * Example usage in HTML:
 *   <input id="pdf-input" type="file" accept=".pdf,.png,.jpg,.jpeg">
 *   <script type="module">
 *     import { bindFileInput } from './demo.js';
 *     bindFileInput(document.getElementById('pdf-input'), result => {
 *       console.log('Markdown:', result.mdContent);
 *     });
 *   </script>
 *
 * @param {HTMLInputElement} inputEl - File input element.
 * @param {function(ParseResult):void} onResult - Called for each parsed file.
 * @param {object} [opts] - Options forwarded to parseDoc.
 */
export function bindFileInput(inputEl, onResult, opts = {}) {
  inputEl.addEventListener('change', async () => {
    const files = Array.from(inputEl.files || []);
    if (!files.length) return;

    try {
      const results = await parseDoc(files, opts);
      for (const result of results) {
        onResult(result);
      }
    } catch (e) {
      console.error('parseDoc error:', e);
    }
  });
}
