// Copyright (c) RapidAI. All rights reserved.
// PORTING NOTE: model_list.py → model_list.js
// Python class with string constants → JS class with static string properties

/**
 * Atomic model name constants.
 * PORTING NOTE: Python class AtomicModel → same JS class with static string properties.
 */
export class AtomicModel {
  static Layout = "layout";
  static FORMULA = "formula";
  static OCR = "ocr";
  static Table = "table";
}
