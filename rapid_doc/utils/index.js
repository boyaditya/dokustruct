// Copyright (c) Opendatalab. All rights reserved.
/**
 * Barrel re-export for rapid_doc/utils/
 * PORTING NOTE: rapid_doc/utils/__init__.py → rapid_doc/utils/index.js
 *
 * The Python __init__.py is empty; this barrel exists for convenience so that
 * downstream code can do:
 *   import { BlockType, calculateIou, ... } from '../utils/index.js'
 *
 * Modules that are import-heavy (cv2, pdfjs, etc.) are re-exported here only
 * as module re-exports so they are only loaded on demand.
 */

// ── Enum / constants ──────────────────────────────────────────────────────────
export * from './enum_class.js';

// ── Geometry / bbox utilities ─────────────────────────────────────────────────
export * from './boxbase.js';

// ── Hash utilities ────────────────────────────────────────────────────────────
export * from './hash_utils.js';

// ── Configuration ─────────────────────────────────────────────────────────────
export * from './config_reader.js';
export * from './os_env_config.js';
export * from './check_sys_env.js';

// ── PDF utilities ─────────────────────────────────────────────────────────────
export * from './pdf_page_id.js';
export * from './pdf_reader.js';
export * from './pdf_text_tool.js';
export * from './pdf_classify.js';
export * from './pdf_image_tools.js';
export * from './PyPDFium2Parser.js';

// ── Image / OCR utilities ─────────────────────────────────────────────────────
export * from './ocr_utils.js';
export * from './cut_image.js';
export * from './draw_bbox.js';
export * from './model_utils.js';

// ── Block processing ──────────────────────────────────────────────────────────
export * from './block_pre_proc.js';
export * from './block_sort.js';
export * from './span_block_fix.js';
export * from './span_pre_proc.js';

// ── Table ─────────────────────────────────────────────────────────────────────
export * from './table_merge.js';

// ── Language / text ───────────────────────────────────────────────────────────
export * from './language.js';
export * from './magic_model_utils.js';

// ── Checkbox ──────────────────────────────────────────────────────────────────
export * from './checkbox_det_cls.js';

// ── Model download ────────────────────────────────────────────────────────────
export * from './models_download_utils.js';

// ── Markdown output ───────────────────────────────────────────────────────────
export * from './markdown_to_html.js';
export * from './markdown_to_word.js';

// ── Download utilities ────────────────────────────────────────────────────────
export * from './download_file.js';
