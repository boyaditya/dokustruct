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
  IMAGE: 'image',
  TABLE: 'table',
  CHART: 'chart',
  IMAGE_BODY: 'image_body',
  TABLE_BODY: 'table_body',
  CHART_BODY: 'chart_body',
  CAPTION: 'caption',
  IMAGE_CAPTION: 'image_caption',
  TABLE_CAPTION: 'table_caption',
  CHART_CAPTION: 'chart_caption',
  ALGORITHM_CAPTION: 'algorithm_caption',
  FOOTNOTE: 'footnote',
  IMAGE_FOOTNOTE: 'image_footnote',
  TABLE_FOOTNOTE: 'table_footnote',
  CHART_FOOTNOTE: 'chart_footnote',
  TEXT: 'text',
  TITLE: 'title',
  INTERLINE_EQUATION: 'interline_equation',
  EQUATION: 'equation',
  LIST: 'list',
  INDEX: 'index',
  DISCARDED: 'discarded',
  // VLM 2.5 types
  CODE: 'code',
  CODE_BODY: 'code_body',
  CODE_CAPTION: 'code_caption',
  CODE_FOOTNOTE: 'code_footnote',
  ALGORITHM: 'algorithm',
  REF_TEXT: 'ref_text',
  PHONETIC: 'phonetic',
  HEADER: 'header',
  FOOTER: 'footer',
  PAGE_NUMBER: 'page_number',
  ASIDE_TEXT: 'aside_text',
  PAGE_FOOTNOTE: 'page_footnote',
  // PP-DocLayoutV2 types
  ABSTRACT: 'abstract',
  DOC_TITLE: 'doc_title',
  PARAGRAPH_TITLE: 'paragraph_title',
  VERTICAL_TEXT: 'vertical_text',
  SEAL: 'seal',
  HEADER_IMAGE: 'header_image',
  FOOTER_IMAGE: 'footer_image',
  FORMULA_NUMBER: 'formula_number',
});

/**
 * @readonly
 * @enum {string}
 */
export const ContentType = Object.freeze({
  IMAGE: 'image',
  TABLE: 'table',
  CHART: 'chart',
  TEXT: 'text',
  INTERLINE_EQUATION: 'interline_equation',
  INLINE_EQUATION: 'inline_equation',
  EQUATION: 'equation',
  CHECKBOX: 'checkbox',
  HYPERLINK: 'hyperlink',
  SEAL: 'seal',
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
  CONTENT_LIST_V2: 'content_list_v2',
});

/**
 * @readonly
 * @enum {string}
 */
export const ImageType = Object.freeze({
  PIL: 'pil_img',
  BASE64: 'base64_img',
});

/**
 * @readonly
 * @enum {string}
 */
export const SplitFlag = Object.freeze({
  CROSS_PAGE: 'cross_page',
  LINES_DELETED: 'lines_deleted',
});
