// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: pdf_page_id.py → pdf_page_id.js
 * Direct translation — no platform-specific dependencies.
 */

/**
 * Clamp end_page_id within [0, pdf_page_num - 1].
 * @param {number|null|undefined} endPageId
 * @param {number} pdfPageNum
 * @returns {number}
 */
export function getEndPageId(endPageId, pdfPageNum) {
  let result = (endPageId != null && endPageId >= 0) ? endPageId : pdfPageNum - 1;
  if (result > pdfPageNum - 1) {
    console.warn('[pdf_page_id] end_page_id is out of range, use images length');
    result = pdfPageNum - 1;
  }
  return result;
}
