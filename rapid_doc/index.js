/**
 * rapid_doc/index.js
 *
 * Barrel export for the RapidDoc browser port.
 *
 * Public API surface — consumers import from this file for a single, stable
 * entry point. This file MUST only contain import/export declarations.
 *
 * Usage:
 *   import { docAnalyze, MakeMode, ModelSingleton } from './rapid_doc/index.js';
 */

// ---------------------------------------------------------------------------
// Pipeline — main entry points
// ---------------------------------------------------------------------------

export { docAnalyze, ModelSingleton } from './backend/pipeline/pipeline_analyze.js';
export { unionMake } from './backend/pipeline/pipeline_middle_json_mkcontent.js';
export { resultToMiddleJson } from './backend/pipeline/model_json_to_middle_json.js';
export { BatchAnalyze } from './backend/pipeline/batch_analyze.js';
export { paraSplit } from './backend/pipeline/para_split.js';
export { MagicModel } from './backend/pipeline/pipeline_magic_model.js';
export { AtomicModel } from './backend/pipeline/model_list.js';

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

export {
  convertPdfBytesToBytesByPypdfium2,
  convertPdfToBytesByPypdfium2,
  prepareEnv,
  readFn,
} from './cli/common.js';

// ---------------------------------------------------------------------------
// Data I/O
// ---------------------------------------------------------------------------

export {
  FileBasedDataWriter,
  MemoryDataWriter,
} from './data/data_reader_writer/index.js';

// ---------------------------------------------------------------------------
// Utilities — enumerations & schemas
// ---------------------------------------------------------------------------

export {
  MakeMode,
  BlockType,
  ContentType,
  CategoryId,
  SupportedPdfParseMethod,
  ImageType,
  SplitFlag,
} from './utils/enum_class.js';

export * from './utils/schemas.js';

// ---------------------------------------------------------------------------
// Utilities — PDF reading & parsing
// ---------------------------------------------------------------------------

export { classify as classifyPdf } from './utils/pdf_classify.js';
export { getCropImg } from './utils/pdf_image_tools.js';
export { getPage } from './utils/pdf_text_tool.js';
export { getEndPageId } from './utils/pdf_page_id.js';

// ---------------------------------------------------------------------------
// Utilities — image processing
// ---------------------------------------------------------------------------

export { cutImage } from './utils/cut_image.js';
export { drawLayoutBbox, drawSpanBbox } from './utils/draw_bbox.js';

// ---------------------------------------------------------------------------
// Utilities — bbox / geometry
// ---------------------------------------------------------------------------

export * from './utils/boxbase.js';
export { sortBlocksByXycutPlus } from './utils/block_sort.js';

// ---------------------------------------------------------------------------
// Utilities — span & block post-processing
// ---------------------------------------------------------------------------

export { mergeTable } from './utils/table_merge.js';

// ---------------------------------------------------------------------------
// Utilities — OCR & language
// ---------------------------------------------------------------------------

export { detectLang, removeInvalidSurrogates } from './utils/language.js';

// ---------------------------------------------------------------------------
// Utilities — model downloads & config
// ---------------------------------------------------------------------------

export { downloadFile, DownloadFile, DownloadFileInput, CPU_MODEL } from './utils/download_file.js';
export { UI_MODEL_URL_MAP, downloadModel, getRequiredModels } from './utils/model_url_map.js';
export { getDevice, setConfig, readConfig } from './utils/config_reader.js';
export { makeHashable, bytesMd5, strMd5, strSha256 } from './utils/hash_utils.js';

// ---------------------------------------------------------------------------
// Utilities — OCR standalone
// ---------------------------------------------------------------------------

export { RapidOcrModel } from './model/ocr/rapid_ocr.js';
export { AtomModelSingleton, disposeModelResource, ocrModelInit } from './backend/pipeline/model_init.js';
export { initVramDetection, getBatchRatio } from './utils/model_utils.js';

// ---------------------------------------------------------------------------
// Utilities — output conversion
// ---------------------------------------------------------------------------

export { markdownToHtml } from './utils/markdown_to_html.js';
export { markdownToDocx } from './utils/markdown_to_word.js';

// ---------------------------------------------------------------------------
// Utilities — miscellaneous
// ---------------------------------------------------------------------------

export {
  FileNotExistsException,
  EmptyDataException,
  InvalidParams,
  AbortException,
} from './utils/exceptions.js';
