// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: img2table_self/image.py → image.js
// img2table is a Python library for extracting tables from images/PDFs.
// It is NOT available in the browser — this is a stub with porting notes.

/**
 * Stub for img2table Image/Document wrapper.
 * PORTING NOTE: img2table requires OpenCV + PyMuPDF + tesseract/easyocr — not browser-compatible.
 * For browser table extraction, use PPTableStructurer or TSRUnetStructurer instead.
 */
export class Image {
  constructor() {
    throw new Error(
      "img2table_self.Image: img2table is not available in the browser. " +
      "Use PPTableStructurer or TSRUnetStructurer instead."
    );
  }
}

export default Image;
