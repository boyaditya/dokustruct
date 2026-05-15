// Copyright (c) Opendatalab. All rights reserved.
// img2table OCRInstance wrapper — not browser-compatible.

/**
 * Stub for RapidOcrTable (img2table OCRInstance wrapper).
 * Not available in browser. Use the RapidOCR JS module directly.
 */
export class RapidOcrTable {
  constructor() {
    throw new Error(
      "img2table_self.RapidOcrTable: img2table is not available in the browser. " +
      "Use the RapidOCR JS module directly."
    );
  }
}
