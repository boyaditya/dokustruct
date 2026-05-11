// Copyright (c) Opendatalab. All rights reserved.
/**
 * Character utility functions for text normalization
 * PORTING NOTE: char_utils.py → char_utils.js
 */

// PDF text extraction: English cross-line word breaks may be encoded as various hyphen characters.
// Only used to detect "line-end English word break", don't extend to en/em dash.
const LINE_END_HYPHEN_CHARS = "-\u00ad\u2010\u2011\u2043";
const LINE_END_HYPHEN_RE = new RegExp(`[A-Za-z]+[${LINE_END_HYPHEN_CHARS.replace(/[-]/g, '\\-')}]\\s*$`);

/**
 * Check if text line ends with English word hyphenation.
 * Only recognizes word break scenarios where letters are followed by line-end hyphen.
 * Does not handle intra-word hyphens or regular dashes.
 * 
 * @param {string} line - Text line to check
 * @returns {boolean} True if line ends with hyphenated word
 */
export function isHyphenAtLineEnd(line) {
  return LINE_END_HYPHEN_RE.test(line);
}

/**
 * Convert full-width characters to half-width (letters and numbers only).
 * Excludes punctuation marks.
 * 
 * @param {string} text - String containing full-width characters
 * @returns {string} String with full-width letters/numbers converted to half-width
 */
export function fullToHalfExcludeMarks(text) {
  const result = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    // Full-width letters and numbers (FF21-FF3A for A-Z, FF41-FF5A for a-z, FF10-FF19 for 0-9)
    if ((code >= 0xFF21 && code <= 0xFF3A) || 
        (code >= 0xFF41 && code <= 0xFF5A) || 
        (code >= 0xFF10 && code <= 0xFF19)) {
      result.push(String.fromCharCode(code - 0xFEE0)); // Shift to ASCII range
    } else {
      result.push(char);
    }
  }
  return result.join('');
}

/**
 * Convert full-width characters to half-width (all characters).
 * Includes letters, numbers, and punctuation.
 * 
 * @param {string} text - String containing full-width characters
 * @returns {string} String with full-width characters converted to half-width
 */
export function fullToHalf(text) {
  const result = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    // Full-width letters, numbers and punctuation (FF01-FF5E)
    if (code >= 0xFF01 && code <= 0xFF5E) {
      result.push(String.fromCharCode(code - 0xFEE0)); // Shift to ASCII range
    } else {
      result.push(char);
    }
  }
  return result.join('');
}
