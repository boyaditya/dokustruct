/**
 * PORTING NOTE: enum_class.py → enum_class.js
 *
 * WORKAROUND: Python uses `class X(Enum)` with `.value` access pattern
 * REASON: JavaScript has no built-in Enum type
 * SOLUTION: Object.freeze() to create immutable enum-like objects; values are
 *           plain strings/numbers matching the Python Enum `.value` equivalents.
 *
 * AFFECTED METHODS: All enum classes → Object.freeze() constants
 */

/**
 * @readonly
 * @enum {string}
 */
export const SupportedPdfParseMethod = Object.freeze({
  AUTO: 'auto',
  TXT: 'txt',
  OCR: 'ocr',
});

/**
 * @readonly
 * @enum {string}
 */
export const BlockType = Object.freeze({
  TEXT: 'text',
  TITLE: 'title',
  IMAGE: 'image',
  IMAGE_BODY: 'image_body',
  IMAGE_CAPTION: 'image_caption',
  IMAGE_FOOTNOTE: 'image_footnote',
  TABLE: 'table',
  TABLE_BODY: 'table_body',
  TABLE_CAPTION: 'table_caption',
  TABLE_FOOTNOTE: 'table_footnote',
  INTERLINE_EQUATION: 'interline_equation',
  DISCARDED: 'discarded',
});

/**
 * @readonly
 * @enum {string}
 */
export const ContentType = Object.freeze({
  IMAGE: 'image',
  TABLE: 'table',
  TEXT: 'text',
  INTERLINE_EQUATION: 'interline_equation',
  INLINE_EQUATION: 'inline_equation',
  EQUATION: 'equation',
  CHECKBOX: 'checkbox',
  CODE: 'code',
});

/**
 * @readonly
 * @enum {number}
 */
export const CategoryId = Object.freeze({
  Title: 0,
  Text: 1,
  Abandon: 2,
  ImageBody: 3,
  ImageCaption: 4,
  TableBody: 5,
  TableCaption: 6,
  TableFootnote: 7,
  InterlineEquation_Layout: 8,
  InterlineEquationNumber_Layout: 9,
  InlineEquation: 13,
  InterlineEquation_YOLO: 14,
  OcrText: 15,
  LowScoreText: 16,
  ImageFootnote: 101,
  CheckBox: 200,
});

/**
 * @readonly
 * @enum {string}
 */
export const MakeMode = Object.freeze({
  MM_MD: 'mm_markdown',
  NLP_MD: 'nlp_markdown',
  CONTENT_LIST: 'content_list',
});

/**
 * @readonly
 * @enum {string}
 */
export const DocElementType = Object.freeze({
  PARAGRAPH: 'paragraph',
  INDEX: 'index',
});

/**
 * @readonly
 * @enum {string}
 */
export const ImageType = Object.freeze({
  PIL:    'pil_img',
  BASE64: 'base64_img',
});

/**
 * @readonly
 * @enum {string}
 */
export const SplitFlag = Object.freeze({
  CROSS_PAGE:    'cross_page',
  LINES_DELETED: 'lines_deleted',
});