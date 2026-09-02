// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: model_handler/pp_formulanet_plus/post_process.py → post_process.js
// Python `tokenizers` (HuggingFace) library → JS JSON-based tokenizer from model metadata.
// `ftfy.fix_text` → identity (optional text cleanup not critical for browser).

import { fixLatex, gpt2BytesToUnicodeInverse, decodeByteLevelToken } from "./utils.js";

/**
 * UniMERNet token decoder using vocabulary stored in ONNX model metadata.
 * PORTING NOTE: UniMERNetDecode loads a fast_tokenizer from model metadata JSON.
 * In browser, the tokenizer JSON is resolved from model metadata or bundled fallback assets.
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
    // Porting fix: HuggingFace byte-level BPE inverse map for Greek/CJK token decoding
    const tokens = [];
    for (const id of tokenIds) {
      if (this.specialIds.has(id)) continue;
      if (id === this.eosId || id === this.padId || id === this.sosId) continue;
      let token = this.idToToken.get(id);
      if (token == null) continue;
      // Skip special token strings that may have slipped through ID-based filtering
      if (token === '<s>' || token === '</s>' || token === '<pad>' || token === '<unk>') continue;
      tokens.push(token);
    }

    // Porting fix: Python calls HuggingFace tokenizer.decode on the full id sequence.
    // Decode after concatenation so multi-byte UTF-8 sequences split across BPE tokens survive.
    const inverseMap = gpt2BytesToUnicodeInverse();
    const decoded = decodeByteLevelToken(tokens.join(""), inverseMap);
    return this._postProcess(decoded);
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
    
    // Porting fix: _normalize workaround removed — F1 BGR/RGB swap fixed in pre_process.js
    
    return result.trim();
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
