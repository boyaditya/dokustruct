// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: img2table_self/RapidOcrTable.py → RapidOcrTable.js
// img2table OCRInstance wrapper — not browser-compatible.
// PORTING NOTE: img2table requires server-side OCR engines — use RapidOCR JS port instead.

/**
 * Stub for RapidOcrTable (img2table OCRInstance wrapper).
 * PORTING NOTE: Not available in browser. Use the RapidOCR JS module directly.
 */
export class RapidOcrTable {
  constructor() {
    throw new Error(
      "img2table_self.RapidOcrTable: img2table is not available in the browser. " +
      "Use the RapidOCR JS module directly."
    );
  }
}

export default RapidOcrTable;
