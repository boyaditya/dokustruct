# RapidDoc-JS Pipeline Flow

This is the canonical flow for the browser-native JavaScript pipeline. It is intended for agents that need to debug, extend, or validate the RapidDoc-JS engine.

## 1. UI Flow

Main files:

- `ui/app.js` wires UI controls.
- `ui/state/appState.js` stores files, parse options, feature toggles, output flags, timings, and results.
- `ui/utils/pipelineAdapter.js` maps UI state to the RapidDoc engine.

Flow:

```text
User selects file and options
  -> AppState stores file, toggles, model choices, output flags
  -> PipelineAdapter.run(state)
  -> PipelineAdapter._runSingle(...)
  -> PipelineAdapter._runFullAnalysis(...)
  -> rapid_doc/index.js exports are loaded lazily
```

Important adapter responsibilities:

- Read the current `File` as bytes.
- Convert image input to PDF bytes when using the full pipeline.
- Build engine config with `_buildConfig`.
- Call `docAnalyze`.
- Convert raw model output to middle JSON with `resultToMiddleJson`.
- Convert middle JSON to Markdown/content list with `unionMake`.
- Normalize outputs for the UI with `_normaliseResult`.
- Record timings and memory estimates.

## 2. Config Flow

`PipelineAdapter._buildConfig` produces the engine config from `AppState`.

Common fields:

- Input: `file_name`, `parse_method`, `language`, `start_page_id`, `end_page_id`, `max_pages`.
- Features: `formula_enable`, `table_enable`, `checkbox_enable`.
- Model configs: `layout_config`, `ocr_config`, `formula_config`, `table_config`, `checkbox_config`.
- Output flags: `dump_md`, `dump_middle_json`, `dump_model_output`, `dump_content_list`, `dump_md_html`, `dump_md_docx`, `make_mode`.
- Runtime: `execution_provider`, `pdf_pages_batch`.

Default page-window batching is chosen by active execution provider:

- WebGPU: smaller windows.
- WASM: larger windows.

## 3. Engine Entry Flow

Main file: `rapid_doc/backend/pipeline/pipeline_analyze.js`.

Public entry:

```javascript
docAnalyze(pdfBytesList, {
  lang_list,
  parse_method,
  formula_enable,
  table_enable,
  layout_config,
  ocr_config,
  formula_config,
  table_config,
  checkbox_config,
  start_page_id,
  end_page_id,
  pdf_pages_batch,
})
```

High-level flow:

```text
docAnalyze
  -> normalize pdfBytesList
  -> convert image bytes to a one-page PDF when needed
  -> optionally process page windows when pdf_pages_batch > 0
  -> optionally slice pages by start/end page
  -> classify parse method and decide OCR enablement
  -> render PDF pages to image dictionaries
  -> extract PDF text/page dictionaries
  -> flatten pages across documents into page batches
  -> batchImageAnalyze
  -> regroup per-page results by source document
```

Return shape:

```text
[
  inferResults,     // per-document pages with layout_dets and page_info
  allImageLists,    // rendered page images and scale values
  allPdfDocs,       // PDF text/page dictionaries
  langList,         // final language list
  ocrEnabledList,   // per-document OCR mode decision
  pipelineTimings   // layout, formula, ocr, table, reading_order, postprocessing
]
```

Windowed processing uses `_docAnalyzeWindowed` and `_docAnalyzeSingleWindow` to reduce memory pressure on large PDFs.

## 4. Model Lifecycle

Main file: `rapid_doc/backend/pipeline/model_init.js`.

Model layers:

- `ModelSingleton` caches complete `MineruPipelineModel` objects.
- `MineruPipelineModel` holds layout, OCR, formula, and table model references for one config.
- `AtomModelSingleton` caches atomic models by model type and config key.
- `atomModelInit` dispatches to layout, OCR, formula, table, or orientation init functions.

Important behavior:

- Layout model is always required for full analysis.
- OCR model is required for full analysis and postprocessing.
- Formula model loads only when formula is enabled.
- Table model loads only when table is enabled.
- Table model initialization also prepares an OCR engine configured for table detection.
- Orientation model is retained when document orientation classification is enabled.
- Cache eviction and disposal are important for browser memory.

## 5. Batch Analysis Flow

Main file: `rapid_doc/backend/pipeline/batch_analyze.js`.

Entry:

```javascript
batchImageAnalyze(imagesWithExtraInfo, config)
  -> new BatchAnalyze(modelManager, batchRatio, ...)
  -> BatchAnalyze.call(imagesWithExtraInfo)
```

Each page item is:

```text
[pageImage, scale, ocrEnable, lang, pdfDict]
```

`BatchAnalyze.call` stages:

```text
1. Initialize or reuse models
2. Convert page images to BGR cv.Mat objects
3. Optionally classify and correct page orientation
4. Run layout detection
5. Collect OCR, table, and formula regions from layout output
6. Run formula recognition when enabled
7. Run OCR:
   - custom OCR path when a custom batchPredict model is configured
   - traditional OCR path otherwise
8. Run table recognition when enabled
9. Run OCR recognition postprocess
10. Run seal OCR for seal-labeled layout regions
11. Restore rotated polygons when needed
12. Release owned Mats and record stage timings
```

Stage timings are attached to the returned result array as `_stageTimings`.

## 6. OCR Flow

Traditional OCR uses helpers from `rapid_doc/backend/pipeline/analyze_utils.js`.

Flow:

```text
_runTraditionalOcr
  -> extractTextFromPdf when detection mode is not "ocr"
  -> runOcrDetBatch for OCR detection and recognition preparation
  -> runOcrRecPostprocess after table/formula stages
```

OCR mode depends on:

- `parse_method`: `auto`, `ocr`, or `txt`.
- PDF classification result from `pdf_classify.js`.
- `ocr_config.use_det_mode`.

Searchable PDF text can be used before OCR recognition. OCR is still used when extraction is insufficient or when forced by config.

## 7. Formula Flow

Formula regions come from layout detections.

Flow:

```text
layout detections
  -> getResListFromLayoutRes
  -> crop formula regions
  -> formulaModel.batchPredict
  -> write LaTeX back onto formula layout results
```

If formula is disabled, inline equation layout items are filtered similarly to formula-level behavior in the baseline.

## 8. Table Flow

Table regions come from layout detections.

Flow:

```text
layout table region
  -> crop table image
  -> processSingleTable
  -> table OCR detection
  -> PDF text extraction for table when allowed
  -> OCR recognition fallback when needed
  -> table model predict
  -> write HTML to table layout result
```

Important table config knobs:

- `force_ocr`
- `use_word_box`
- `table_formula_enable`
- `table_image_enable`
- `skip_text_in_image`
- `use_img2table`
- `use_compare_table`

Required OCR result format for table model handoff:

```text
[
  boxes,   // array of quadrilateral boxes or point arrays
  texts,   // array of recognized strings
  scores   // array of confidence values
]
```

All three arrays should have matching lengths.

## 9. Middle JSON Flow

Main file: `rapid_doc/backend/pipeline/model_json_to_middle_json.js`.

Entry:

```javascript
resultToMiddleJson(modelList, imagesList, pageDictList, imageWriter, opts)
```

Flow:

```text
raw model page output
  -> MagicModel groups detections into text, title, image, table, equation, discarded blocks
  -> prepare block bboxes
  -> filter and assign spans
  -> extract searchable PDF text when OCR is disabled
  -> cut image/table/equation crops
  -> fill spans into blocks
  -> sort blocks by reading order
  -> make page_info dict
  -> OCR postprocess when not using custom VL OCR
  -> paraSplit
  -> crossPageTableMerge
```

Middle JSON root shape:

```text
{
  pdf_info: [...],
  _backend: "pipeline",
  _version_name: "..."
}
```

Each `pdf_info` page contains:

- `preproc_blocks`
- `page_idx`
- `page_size`
- `discarded_blocks`

## 10. Markdown and Content-List Flow

Main file: `rapid_doc/backend/pipeline/pipeline_middle_json_mkcontent.js`.

Entry:

```javascript
unionMake(pdfInfoDict, makeMode, imgBuketPath)
```

Supported modes:

- `mm_markdown`: Markdown with multimodal image/table references.
- `nlp_markdown`: text-focused Markdown.
- `content_list`: structured content list objects.

Important behavior:

- Paragraph text is merged from lines and spans.
- Title levels are normalized.
- Inline and display equations use configured LaTeX delimiters.
- Image and table blocks can emit image paths or table HTML.
- Content-list bboxes are normalized to a 0-1000 page coordinate space.

## 11. UI Result Normalization

`PipelineAdapter._normaliseResult` converts engine output into the UI result contract.

Common UI result fields:

- `markdown`
- `raw_text`
- `content_list`
- `middle_json`
- `model_output`
- `layout_label_blocks`
- `layout_bboxes`
- `span_bboxes`
- `layout_dets`
- `page_info`
- `page_count`
- `images`
- `_config`
- `_file`
- `_timingBreakdown`
- `_raw`

Output flags decide whether large fields such as middle JSON, model output, and images are retained.

## 12. Troubleshooting Map

- Nothing renders in UI: check `ui/app*.js`, `appState.js`, and browser console.
- Config toggle ignored: check `AppState` derived getters and `PipelineAdapter._buildConfig`.
- Pipeline does not start: check lazy import of `rapid_doc/index.js` in `pipelineAdapter.js`.
- Page count or slicing wrong: check `docAnalyze`, `convertPdfBytesToBytesByPypdfium2`, and windowed processing.
- OCR text wrong: check `analyze_utils.js`, `pdf_text_tool.js`, OCR config, and `RapidOcrModel`.
- Table cells empty: check `processSingleTable`, table OCR result format, and `RapidTableModel.predict`.
- Formula text missing: check formula enablement, formula crop collection, and selected formula model.
- Markdown malformed: check `resultToMiddleJson`, `paraSplit`, and `unionMake`.
- Memory grows across runs: check model cache retention, PDF proxy cleanup, Mat deletion, and image/canvas release.
