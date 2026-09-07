import { describe, it, expect } from 'vitest';

describe('import smoke — core modules load without throwing', () => {
  it('model modules import', async () => {
    const layout = await import('@rapid_doc/model/layout/rapid_layout.js');
    expect(layout.RapidLayoutModel || layout.default || layout).toBeDefined();

    const ocr = await import('@rapid_doc/model/ocr/rapid_ocr.js');
    expect(ocr.RapidOcrModel || ocr.default || ocr).toBeDefined();

    const formula = await import('@rapid_doc/model/formula/rapid_formula_model.js');
    expect(formula.RapidFormulaModel || formula.default || formula).toBeDefined();

    const table = await import('@rapid_doc/model/table/rapid_table.js');
    expect(table.RapidTableModel || table.default || table).toBeDefined();

    const orient = await import('@rapid_doc/model/orientation/rapid_orientation_model.js');
    expect(orient.RapidOrientationModel || orient.default || orient).toBeDefined();
  });

  it('reading order modules import', async () => {
    const xycut = await import('@rapid_doc/model/reading_order/xycut_plus.js');
    expect(typeof xycut.xycutPlusSort).toBe('function');
    expect(typeof xycut.projectionByBboxes).toBe('function');

    const blockSort = await import('@rapid_doc/utils/block_sort.js');
    expect(typeof blockSort.sortBlocksByBbox).toBe('function');
    expect(typeof blockSort.getLineHeight).toBe('function');

    const layoutParsing = await import('@rapid_doc/model/reading_order/layout_parsing/xycut_plus_v3.js');
    expect(layoutParsing).toBeDefined();
  });

  it('pipeline modules import', async () => {
    const pipeline = await import('@rapid_doc/backend/pipeline/pipeline_analyze.js');
    expect(typeof pipeline.docAnalyze).toBe('function');
    expect(typeof pipeline.engineReset).toBe('function');
    expect(pipeline.ModelSingleton).toBeDefined();

    const batch = await import('@rapid_doc/backend/pipeline/batch_analyze.js');
    expect(batch.BatchAnalyze).toBeDefined();

    const middle = await import('@rapid_doc/backend/pipeline/model_json_to_middle_json.js');
    expect(typeof middle.resultToMiddleJson).toBe('function');

    const mk = await import('@rapid_doc/backend/pipeline/pipeline_middle_json_mkcontent.js');
    expect(typeof mk.unionMake).toBe('function');
    expect(typeof mk.makeBlocksToMarkdown).toBe('function');
  });

  it('utils modules import', async () => {
    const boxbase = await import('@rapid_doc/utils/boxbase.js');
    expect(typeof boxbase.calculateIou).toBe('function');

    const bbox = await import('@rapid_doc/utils/bbox_utils.js');
    expect(typeof bbox.normalizeToIntBbox).toBe('function');

    const hash = await import('@rapid_doc/utils/hash_utils.js');
    expect(typeof hash.bytesMd5).toBe('function');

    const lang = await import('@rapid_doc/utils/language.js');
    expect(typeof lang.detectLang).toBe('function');

    const md = await import('@rapid_doc/utils/markdown_to_html.js');
    expect(typeof md.markdownToHtml).toBe('function');

    const cut = await import('@rapid_doc/utils/cut_image.js');
    expect(cut).toBeDefined();

    const cfg = await import('@rapid_doc/utils/config_reader.js');
    expect(typeof cfg.getDevice).toBe('function');

    const data = await import('@rapid_doc/data/data_reader_writer/index.js');
    expect(data.MemoryDataWriter).toBeDefined();
  });

  it('rapid_doc index exports remain stable', async () => {
    const mod = await import('@rapid_doc/index.js');
    const required = [
      'docAnalyze', 'ModelSingleton', 'unionMake', 'resultToMiddleJson',
      'BatchAnalyze', 'MakeMode', 'BlockType', 'CategoryId', 'AbortException',
      'MemoryDataWriter', 'engineReset', 'AtomModelSingleton',
    ];
    for (const name of required) {
      expect(mod[name], `missing export ${name}`).toBeDefined();
    }
  });
});
