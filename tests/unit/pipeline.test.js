/**
 * Property: Pipeline Resilience on Non-Critical Errors
 *
 * Tests that when a non-critical error occurs (e.g., one table fails, one formula fails
 * recognition), the pipeline continues processing other pages/elements. Also verifies
 * that AbortException IS propagated (not caught).
 *
 * Validates pipeline stage orchestration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AbortException } from '@rapid_doc/utils/exceptions.js';
import { formatPipelineError } from '@rapid_doc/utils/browser_utils.js';

/**
 * Helper: creates a minimal mock of the BatchAnalyze class's error handling pattern.
 * This simulates the stage-level try/catch pattern used in the real pipeline.
 */
function createStageLevelHandler(stageName, moduleName = 'BatchAnalyze') {
  /**
   * Simulates the pipeline's stage-level error handling:
   * - AbortException is always re-thrown (propagated)
   * - Other errors are logged and the stage continues
   */
  return async function runStageWithErrorHandling(stageOperation) {
    try {
      return await stageOperation();
    } catch (err) {
      if (err instanceof AbortException) throw err;
      console.warn(formatPipelineError({
        stage: stageName,
        module: moduleName,
        message: err.message,
        recoverable: true,
      }));
      return null; // Stage failed but pipeline continues
    }
  };
}

/**
 * Helper: simulates the element-level error handling pattern used for
 * individual table/formula processing within a page loop.
 */
function createElementLevelHandler(stageName, moduleName = 'BatchAnalyze') {
  return async function processElementWithErrorHandling(elementOperation, pageIndex) {
    try {
      return await elementOperation();
    } catch (err) {
      if (err instanceof AbortException) throw err;
      console.warn(formatPipelineError({
        stage: stageName,
        module: moduleName,
        message: `element processing skipped: ${err.message}`,
        pageIndex,
        recoverable: true,
      }));
      return null; // Element failed but loop continues
    }
  };
}

describe('Pipeline Resilience on Non-Critical Errors', () => {
  let warnSpy;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('Stage-level error handling pattern', () => {
    it('continues pipeline when formula stage throws a non-critical error', async () => {
      const runFormula = createStageLevelHandler('formula');
      const runOcr = createStageLevelHandler('ocr');
      const runTable = createStageLevelHandler('table');

      const results = [];

      // Formula stage fails
      const formulaResult = await runFormula(async () => {
        throw new Error('Model inference failed');
      });
      results.push({ stage: 'formula', result: formulaResult });

      // OCR stage succeeds
      const ocrResult = await runOcr(async () => {
        return [{ text: 'Hello world', confidence: 0.95 }];
      });
      results.push({ stage: 'ocr', result: ocrResult });

      // Table stage succeeds
      const tableResult = await runTable(async () => {
        return { html: '<table><tr><td>data</td></tr></table>' };
      });
      results.push({ stage: 'table', result: tableResult });

      // Formula failed but OCR and table succeeded
      expect(results[0].result).toBeNull();
      expect(results[1].result).toEqual([{ text: 'Hello world', confidence: 0.95 }]);
      expect(results[2].result).toEqual({ html: '<table><tr><td>data</td></tr></table>' });

      // Warning was logged for the formula failure
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('[BatchAnalyze]');
      expect(warnSpy.mock.calls[0][0]).toContain('formula');
      expect(warnSpy.mock.calls[0][0]).toContain('Model inference failed');
    });

    it('continues pipeline when table stage throws a non-critical error', async () => {
      const runFormula = createStageLevelHandler('formula');
      const runOcr = createStageLevelHandler('ocr');
      const runTable = createStageLevelHandler('table');

      // Formula succeeds
      const formulaResult = await runFormula(async () => {
        return { latex: '\\frac{1}{2}' };
      });

      // OCR succeeds
      const ocrResult = await runOcr(async () => {
        return [{ text: 'Page content' }];
      });

      // Table fails
      const tableResult = await runTable(async () => {
        throw new Error('Table model timeout');
      });

      expect(formulaResult).toEqual({ latex: '\\frac{1}{2}' });
      expect(ocrResult).toEqual([{ text: 'Page content' }]);
      expect(tableResult).toBeNull();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('table');
      expect(warnSpy.mock.calls[0][0]).toContain('Table model timeout');
      expect(warnSpy.mock.calls[0][0]).toContain('[recoverable]');
    });

    it('continues pipeline when OCR stage throws a non-critical error', async () => {
      const runOcr = createStageLevelHandler('ocr');
      const runTable = createStageLevelHandler('table');

      // OCR fails
      const ocrResult = await runOcr(async () => {
        throw new Error('OCR session destroyed');
      });

      // Table still succeeds
      const tableResult = await runTable(async () => {
        return { html: '<table></table>' };
      });

      expect(ocrResult).toBeNull();
      expect(tableResult).toEqual({ html: '<table></table>' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('continues when model is null (model failed to load)', async () => {
      // Simulates the pattern: if (!this.model.formulaModel) { warn; return; }
      const formulaModel = null;

      const runFormulaStage = async () => {
        if (!formulaModel) {
          console.warn(formatPipelineError({
            stage: 'formula',
            module: 'BatchAnalyze',
            message: 'formulaModel is null (likely failed to load), skipping formula recognition',
            recoverable: true,
          }));
          return null;
        }
        return await formulaModel.batchPredict([]);
      };

      const result = await runFormulaStage();
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('formulaModel is null');
      expect(warnSpy.mock.calls[0][0]).toContain('[recoverable]');
    });
  });

  describe('Element-level error handling (per-page/per-element)', () => {
    it('processes remaining tables when one table fails', async () => {
      const processElement = createElementLevelHandler('table');

      const tables = [
        { id: 0, data: 'valid table 1' },
        { id: 1, data: null }, // will cause error
        { id: 2, data: 'valid table 3' },
      ];

      const results = [];
      for (const table of tables) {
        const result = await processElement(async () => {
          if (table.data === null) {
            throw new Error('Cannot process null table data');
          }
          return { html: `<table>${table.data}</table>` };
        }, table.id);
        results.push(result);
      }

      // Table 0 and 2 succeeded, table 1 failed
      expect(results[0]).toEqual({ html: '<table>valid table 1</table>' });
      expect(results[1]).toBeNull();
      expect(results[2]).toEqual({ html: '<table>valid table 3</table>' });

      // Only one warning for the failed table
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('(page 1)');
      expect(warnSpy.mock.calls[0][0]).toContain('Cannot process null table data');
    });

    it('processes remaining formulas when one formula fails recognition', async () => {
      const processElement = createElementLevelHandler('formula');

      const formulas = [
        { idx: 0, img: 'valid_img_1' },
        { idx: 1, img: 'corrupt_img' },
        { idx: 2, img: 'valid_img_2' },
        { idx: 3, img: 'valid_img_3' },
      ];

      const results = [];
      for (const formula of formulas) {
        const result = await processElement(async () => {
          if (formula.img === 'corrupt_img') {
            throw new Error('Failed to decode formula image');
          }
          return { latex: `\\text{formula_${formula.idx}}` };
        }, formula.idx);
        results.push(result);
      }

      // 3 out of 4 formulas succeeded
      expect(results[0]).toEqual({ latex: '\\text{formula_0}' });
      expect(results[1]).toBeNull();
      expect(results[2]).toEqual({ latex: '\\text{formula_2}' });
      expect(results[3]).toEqual({ latex: '\\text{formula_3}' });

      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('processes remaining pages when one page OCR fails', async () => {
      const processElement = createElementLevelHandler('ocr');

      const pages = [
        { pageIdx: 0, content: 'page 0 text' },
        { pageIdx: 1, content: 'page 1 text' },
        { pageIdx: 2, content: null }, // will fail
        { pageIdx: 3, content: 'page 3 text' },
      ];

      const results = [];
      for (const page of pages) {
        const result = await processElement(async () => {
          if (page.content === null) {
            throw new Error('OCR model returned empty result');
          }
          return { text: page.content, pageIdx: page.pageIdx };
        }, page.pageIdx);
        results.push(result);
      }

      // Pages 0, 1, 3 succeeded; page 2 failed
      expect(results[0]).toEqual({ text: 'page 0 text', pageIdx: 0 });
      expect(results[1]).toEqual({ text: 'page 1 text', pageIdx: 1 });
      expect(results[2]).toBeNull();
      expect(results[3]).toEqual({ text: 'page 3 text', pageIdx: 3 });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('(page 2)');
    });

    it('handles multiple element failures across different pages', async () => {
      const processElement = createElementLevelHandler('table');

      const elements = [
        { pageIdx: 0, shouldFail: false },
        { pageIdx: 0, shouldFail: true },
        { pageIdx: 1, shouldFail: false },
        { pageIdx: 1, shouldFail: true },
        { pageIdx: 2, shouldFail: false },
      ];

      const results = [];
      for (const el of elements) {
        const result = await processElement(async () => {
          if (el.shouldFail) {
            throw new Error('Element processing error');
          }
          return { success: true, pageIdx: el.pageIdx };
        }, el.pageIdx);
        results.push(result);
      }

      // 3 succeeded, 2 failed
      const successes = results.filter(r => r !== null);
      const failures = results.filter(r => r === null);
      expect(successes).toHaveLength(3);
      expect(failures).toHaveLength(2);

      // Two warnings logged
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('AbortException propagation (critical exception)', () => {
    it('propagates AbortException from formula stage', async () => {
      const runFormula = createStageLevelHandler('formula');

      await expect(
        runFormula(async () => {
          throw new AbortException('User cancelled');
        })
      ).rejects.toThrow(AbortException);

      // No warning logged — AbortException is re-thrown, not caught
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('propagates AbortException from OCR stage', async () => {
      const runOcr = createStageLevelHandler('ocr');

      await expect(
        runOcr(async () => {
          throw new AbortException('Pipeline aborted');
        })
      ).rejects.toThrow(AbortException);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('propagates AbortException from table stage', async () => {
      const runTable = createStageLevelHandler('table');

      await expect(
        runTable(async () => {
          throw new AbortException('Abort requested');
        })
      ).rejects.toThrow(AbortException);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('propagates AbortException from element-level processing', async () => {
      const processElement = createElementLevelHandler('table');

      await expect(
        processElement(async () => {
          throw new AbortException('User abort during table');
        }, 5)
      ).rejects.toThrow(AbortException);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('AbortException stops the pipeline loop immediately', async () => {
      const processElement = createElementLevelHandler('table');

      const pages = [
        { pageIdx: 0, shouldAbort: false },
        { pageIdx: 1, shouldAbort: true }, // AbortException here
        { pageIdx: 2, shouldAbort: false }, // should never be reached
      ];

      const results = [];
      let aborted = false;

      for (const page of pages) {
        try {
          const result = await processElement(async () => {
            if (page.shouldAbort) {
              throw new AbortException('User cancelled pipeline');
            }
            return { pageIdx: page.pageIdx, processed: true };
          }, page.pageIdx);
          results.push(result);
        } catch (err) {
          if (err instanceof AbortException) {
            aborted = true;
            break; // Pipeline stops
          }
        }
      }

      // Only page 0 was processed before abort
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ pageIdx: 0, processed: true });
      expect(aborted).toBe(true);
    });

    it('distinguishes AbortException from regular errors with same message', async () => {
      const runStage = createStageLevelHandler('formula');

      // Regular error with "abort" in message — should be caught
      const result = await runStage(async () => {
        throw new Error('Something about abort happened');
      });
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockClear();

      // Actual AbortException — should propagate
      await expect(
        runStage(async () => {
          throw new AbortException('Real abort');
        })
      ).rejects.toThrow(AbortException);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('Multi-stage pipeline simulation', () => {
    it('completes full pipeline when one stage fails mid-way', async () => {
      const runLayout = createStageLevelHandler('layout');
      const runFormula = createStageLevelHandler('formula');
      const runOcr = createStageLevelHandler('ocr');
      const runTable = createStageLevelHandler('table');
      const runPostprocess = createStageLevelHandler('postprocess');

      const pipelineResults = {};

      // Simulate full pipeline execution
      pipelineResults.layout = await runLayout(async () => {
        return [{ category_id: 1, poly: [0, 0, 100, 0, 100, 50, 0, 50], score: 0.9 }];
      });

      pipelineResults.formula = await runFormula(async () => {
        throw new Error('ONNX session error: out of memory');
      });

      pipelineResults.ocr = await runOcr(async () => {
        return [{ text: 'Detected text', confidence: 0.88 }];
      });

      pipelineResults.table = await runTable(async () => {
        return { html: '<table><tr><td>Cell</td></tr></table>' };
      });

      pipelineResults.postprocess = await runPostprocess(async () => {
        return { markdown: '# Title\n\nDetected text' };
      });

      // Layout, OCR, table, postprocess all succeeded
      expect(pipelineResults.layout).not.toBeNull();
      expect(pipelineResults.formula).toBeNull(); // failed
      expect(pipelineResults.ocr).not.toBeNull();
      expect(pipelineResults.table).not.toBeNull();
      expect(pipelineResults.postprocess).not.toBeNull();

      // Only one warning for formula failure
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('completes pipeline when multiple stages fail', async () => {
      const runLayout = createStageLevelHandler('layout');
      const runFormula = createStageLevelHandler('formula');
      const runOcr = createStageLevelHandler('ocr');
      const runTable = createStageLevelHandler('table');

      const pipelineResults = {};

      pipelineResults.layout = await runLayout(async () => {
        return [{ category_id: 1, score: 0.9 }];
      });

      pipelineResults.formula = await runFormula(async () => {
        throw new Error('Formula model not loaded');
      });

      pipelineResults.ocr = await runOcr(async () => {
        throw new Error('OCR det model failed');
      });

      pipelineResults.table = await runTable(async () => {
        return { html: '<table></table>' };
      });

      // Layout and table succeeded, formula and OCR failed
      expect(pipelineResults.layout).not.toBeNull();
      expect(pipelineResults.formula).toBeNull();
      expect(pipelineResults.ocr).toBeNull();
      expect(pipelineResults.table).not.toBeNull();

      // Two warnings logged
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    it('AbortException in any stage stops the entire pipeline', async () => {
      const stages = ['layout', 'formula', 'ocr', 'table', 'postprocess'];
      const stageHandlers = stages.map(s => createStageLevelHandler(s));

      const pipelineResults = {};
      let abortedAtStage = null;

      for (let i = 0; i < stages.length; i++) {
        try {
          pipelineResults[stages[i]] = await stageHandlers[i](async () => {
            if (stages[i] === 'ocr') {
              throw new AbortException('Pipeline cancelled by user');
            }
            return { stage: stages[i], success: true };
          });
        } catch (err) {
          if (err instanceof AbortException) {
            abortedAtStage = stages[i];
            break;
          }
        }
      }

      // Only layout and formula ran before abort at OCR
      expect(pipelineResults.layout).toEqual({ stage: 'layout', success: true });
      expect(pipelineResults.formula).toEqual({ stage: 'formula', success: true });
      expect(abortedAtStage).toBe('ocr');
      expect(pipelineResults.table).toBeUndefined();
      expect(pipelineResults.postprocess).toBeUndefined();
    });
  });

  describe('Error logging format verification', () => {
    it('logs recoverable errors with correct format', async () => {
      const runStage = createStageLevelHandler('table', 'TableProcessor');

      await runStage(async () => {
        throw new Error('Timeout after 30s');
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const loggedMessage = warnSpy.mock.calls[0][0];
      expect(loggedMessage).toContain('[TableProcessor]');
      expect(loggedMessage).toContain('table:');
      expect(loggedMessage).toContain('Timeout after 30s');
      expect(loggedMessage).toContain('[recoverable]');
    });

    it('logs element-level errors with page index', async () => {
      const processElement = createElementLevelHandler('formula', 'FormulaModel');

      await processElement(async () => {
        throw new Error('Decode failed');
      }, 7);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const loggedMessage = warnSpy.mock.calls[0][0];
      expect(loggedMessage).toContain('[FormulaModel]');
      expect(loggedMessage).toContain('formula:');
      expect(loggedMessage).toContain('(page 7)');
      expect(loggedMessage).toContain('[recoverable]');
    });
  });
});
