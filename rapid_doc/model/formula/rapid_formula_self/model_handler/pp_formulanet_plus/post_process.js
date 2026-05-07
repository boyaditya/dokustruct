// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: model_handler/pp_formulanet_plus/post_process.py → post_process.js
// Python `tokenizers` (HuggingFace) library → JS JSON-based tokenizer from model metadata.
// `ftfy.fix_text` → identity (optional text cleanup not critical for browser).

import { fixLatex } from "./utils.js";

/**
 * UniMERNet token decoder using vocabulary stored in ONNX model metadata.
 * PORTING NOTE: UniMERNetDecode loads a fast_tokenizer from model metadata JSON.
 * In browser, the tokenizer JSON is read from `session.customMetadataMap["fast_tokenizer_file"]`.
 *
 * The tokenizer is stored as a JSON object with fields:
 *   - model.vocab: { token → id } mapping
 *   - added_tokens: [{id, content, special}]
 *   - post_processor (optional)
 */
export class UniMERNetDecode {
  /**
   * @param {string} tokenizerJson - Raw JSON string from model metadata
   */
  constructor(tokenizerJson) {
    const tokData = JSON.parse(tokenizerJson);
    this._buildVocab(tokData);
  }

  /**
   * Build id→token map from tokenizer JSON.
   * @param {object} tokData
   */
  _buildVocab(tokData) {
    /** @type {Map<number, string>} */
    this.idToToken = new Map();
    /** @type {Set<number>} */
    this.specialIds = new Set();

    // Determine format: is it { token: id } or { id: token }?
    // We check the first entry.
    const entries = Object.entries(tokData?.model?.vocab ?? tokData?.vocab ?? tokData ?? {});
    if (entries.length > 0) {
      const [key, val] = entries[0];
      const isIdKey = !isNaN(parseInt(key)) && typeof val === 'string';
      
      for (const [k, v] of entries) {
        if (isIdKey) {
          this.idToToken.set(parseInt(k), v);
        } else {
          this.idToToken.set(v, k);
        }
      }
    }

    // added_tokens (special tokens like <eos>, <sos>, <pad>, <unk>)
    const addedTokens = tokData?.added_tokens ?? [];
    for (const entry of addedTokens) {
      const { id, content, special } = entry;
      this.idToToken.set(id, content);
      if (special) this.specialIds.add(id);
    }

    // Detect EOS/SOS/PAD ids
    // CRITICAL: Python hardcodes these (post_process.py lines 83-85):
    //   self.bos_token_id = 0, self.pad_token_id = 1, self.eos_token_id = 2
    // _findSpecialId can fail if the vocab JSON format doesn't expose token strings.
    // Use hardcoded values as primary, _findSpecialId as fallback.
    this.sosId = this._findSpecialId(["<sos>", "<s>", "[SOS]"]) ?? 0;
    this.padId = this._findSpecialId(["<pad>", "[PAD]"]) ?? 1;
    this.eosId = this._findSpecialId(["<eos>", "</s>", "[EOS]"]) ?? 2;
    this.unkId = this._findSpecialId(["<unk>", "[UNK]"]);
    
    // Also add BOS/EOS/PAD to specialIds so they get filtered in tokenToStr
    if (this.sosId != null) this.specialIds.add(this.sosId);
    if (this.padId != null) this.specialIds.add(this.padId);
    if (this.eosId != null) this.specialIds.add(this.eosId);
    
    console.log(`[UniMERNetDecode] vocab size=${this.idToToken.size}, eosId=${this.eosId}, sosId=${this.sosId}, padId=${this.padId}`);
  }

  /**
   * @param {string[]} candidates
   * @returns {number|null}
   */
  _findSpecialId(candidates) {
    for (const [id, token] of this.idToToken) {
      if (candidates.includes(token)) return id;
    }
    return null;
  }

  /**
   * Decode an array of token IDs to a LaTeX string, skipping special tokens.
   * PORTING NOTE: tokenizer.decode(ids, skip_special_tokens=True)
   * @param {number[]} tokenIds
   * @returns {string}
   */
  tokenToStr(tokenIds) {
    const tokens = [];
    for (const id of tokenIds) {
      if (this.specialIds.has(id)) continue;
      if (id === this.eosId || id === this.padId || id === this.sosId) continue;
      let token = this.idToToken.get(id);
      if (token == null) continue;
      // Skip special token strings that may have slipped through ID-based filtering
      if (token === '<s>' || token === '</s>' || token === '<pad>' || token === '<unk>') continue;
      // GPT-2 BPE: Ġ (U+0120) is the space marker — replace with actual space
      // Reference: Python post_process.py line 266: toks[b][i].replace("Ġ", " ")
      token = token.replace(/\u0120/g, ' ');
      tokens.push(token);
    }
    return this._postProcess(tokens.join(""));
  }

  /**
   * Post-process decoded LaTeX string.
   * @param {string} text
   * @returns {string}
   */
  _postProcess(text) {
    let result = text.trim();
    
    // 1. Remove Chinese text wrapping (Python: remove_chinese_text_wrapping)
    result = this._removeChineseTextWrapping(result);
    
    // 2. Fix LaTeX (Python: fix_latex -> calls utils functions)
    result = fixLatex(result);
    
    // 3. ftfy.fix_text - skip in JS (optional text cleanup)
    
    // 4. Normalize whitespace (Python: self.normalize, commented out in Python
    //    but needed in JS because PIL/OpenCV resize differences cause the decoder
    //    to produce space-separated character tokens like "1 7 0 9" instead of "1709")
    result = this._normalize(result);
    
    return result.trim();
  }

  /**
   * Normalize LaTeX by collapsing unnecessary spaces between tokens.
   * Targeted approach: only collapse specific patterns that the decoder
   * produces due to PIL/OpenCV resize differences (space-separated digits,
   * spaces inside subscripts/superscripts, etc.)
   * @param {string} s
   * @returns {string}
   */
  _normalize(s) {
    // 1. Collapse spaces between digits: '1 7 0 9' -> '1709'
    s = s.replace(/(\d)\s+(?=\d)/g, '$1');

    // 2. Collapse spaces around decimal points: '6 . 8' -> '6.8'
    s = s.replace(/(\d)\s*\.\s*(\d)/g, '$1.$2');

    // 3. Remove space before subscript/superscript: 'Q _{' -> 'Q_{', 'r ^{' -> 'r^{'
    s = s.replace(/\s+([_^])/g, '$1');

    // 4. Collapse spaces inside braces after _/^: '_{ 0 }' -> '_{0}'
    s = s.replace(/([_^])\s*\{\s*([^}]+?)\s*\}/g, '$1{$2}');

    // 5. Collapse space after minus sign when followed by digit: '- 6' -> '-6'
    s = s.replace(/([-])\s+(\d)/g, '$1$2');

    // 6. Collapse multiple spaces to single space
    s = s.replace(/\s{2,}/g, ' ');

    return s;
  }

  /**
   * Remove Chinese text wrapping from formula.
   * PORTING NOTE: Python's remove_chinese_text_wrapping (line 329-335)
   * @param {string} formula
   * @returns {string}
   */
  _removeChineseTextWrapping(formula) {
    // Pattern: \text{ ...Chinese chars... }
    const pattern = /\\text\s*\{\s*([^}]*?[\u4e00-\u9fff]+[^}]*?)\s*\}/g;
    const replaced = formula.replace(pattern, (_match, p1) => p1);
    return replaced.replace(/"/g, '');
  }

  /**
   * Decode batched model output (argmax over vocab axis).
   * @param {import('onnxruntime-web').Tensor} preds - shape [N, SeqLen, VocabSize] or [N, SeqLen]
   * @returns {string[]}
   */
  run(preds) {
    const data = preds.cpuData || preds.data;
    const dims = preds.dims;
    console.log(`[UniMERNetDecode] run dims: ${Array.from(dims)}`);

    let tokenIdBatches;
    if (dims.length === 3) {
      // [N, SeqLen, VocabSize] — argmax over last dim
      const [N, SeqLen, VocabSize] = dims;
      tokenIdBatches = [];
      for (let n = 0; n < N; n++) {
        const ids = [];
        for (let s = 0; s < SeqLen; s++) {
          let maxIdx = 0, maxVal = -Infinity;
          const offset = (n * SeqLen + s) * VocabSize;
          for (let v = 0; v < VocabSize; v++) {
            if (data[offset + v] > maxVal) { maxVal = data[offset + v]; maxIdx = v; }
          }
          ids.push(maxIdx);
          if (maxIdx === this.eosId) break;
        }
        tokenIdBatches.push(ids);
      }
    } else if (dims.length === 2) {
      // [N, SeqLen] — already argmaxed
      const [N, SeqLen] = dims;
      tokenIdBatches = [];
      for (let n = 0; n < N; n++) {
        const ids = [];
        for (let s = 0; s < SeqLen; s++) {
          let id = data[n * SeqLen + s];
          if (typeof id === 'bigint') id = Number(id);
          ids.push(id);
          if (id === this.eosId) break;
        }
        tokenIdBatches.push(ids);
      }
    } else {
      throw new Error(`UniMERNetDecode: unexpected predictions tensor dims ${dims}`);
    }

    const result = tokenIdBatches.map(ids => this.tokenToStr(ids));
    console.log(`[UniMERNetDecode] Decoded ${result.length} formulas. First 5 tokens of first batch: ${tokenIdBatches[0]?.slice(0, 5)}`);
    return result;
  }
}

/**
 * PPPostProcess wraps UniMERNetDecode for the PPFormulaNetPlus model.
 */
export class PPPostProcess {
  /**
   * @param {string} tokenizerJson - tokenizer JSON from model metadata
   */
  constructor(tokenizerJson) {
    this.decoder = new UniMERNetDecode(tokenizerJson);
  }

  /**
   * Decode model predictions to LaTeX strings.
   * @param {import('onnxruntime-web').Tensor} preds
   * @returns {string[]}
   */
  run(preds) {
    return this.decoder.run(preds);
  }
}

export default PPPostProcess;
