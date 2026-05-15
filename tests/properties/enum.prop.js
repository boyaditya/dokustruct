/**
 * Property-based test for enum parity with Python baseline.
 *
 * Feature: rapid-doc-js-refactor, Property 5: Enum Parity with Python Baseline
 *
 * Validates: Requirements 7.6
 */
import { describe, it, expect } from 'vitest';
import { CategoryId } from '../../rapid_doc/utils/enum_class.js';

/**
 * Python baseline CategoryId values extracted from rapid_doc/utils/enum_class.py.
 * These are the authoritative reference values that the JS implementation must match.
 */
const PYTHON_CATEGORY_ID_BASELINE = Object.freeze({
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

describe('Feature: rapid-doc-js-refactor, Property 5: Enum Parity with Python Baseline', () => {
  it('every Python CategoryId entry exists in JS with the same numeric value', () => {
    for (const [key, pythonValue] of Object.entries(PYTHON_CATEGORY_ID_BASELINE)) {
      expect(CategoryId).toHaveProperty(key);
      expect(CategoryId[key]).toBe(pythonValue);
    }
  });

  it('JS CategoryId has no extra entries beyond the Python baseline', () => {
    const jsKeys = Object.keys(CategoryId);
    const pythonKeys = Object.keys(PYTHON_CATEGORY_ID_BASELINE);

    for (const jsKey of jsKeys) {
      expect(pythonKeys).toContain(jsKey);
    }
  });

  it('CategoryId entry count matches Python baseline exactly', () => {
    const jsEntryCount = Object.keys(CategoryId).length;
    const pythonEntryCount = Object.keys(PYTHON_CATEGORY_ID_BASELINE).length;
    expect(jsEntryCount).toBe(pythonEntryCount);
  });

  it('all CategoryId values are numbers', () => {
    for (const [key, value] of Object.entries(CategoryId)) {
      expect(typeof value).toBe('number');
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('CategoryId is frozen (immutable)', () => {
    expect(Object.isFrozen(CategoryId)).toBe(true);
  });
});
