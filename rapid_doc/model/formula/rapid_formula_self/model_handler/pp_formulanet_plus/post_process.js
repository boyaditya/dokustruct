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
   * Handles both Model S (wrapped in \begin{aligned}) and Model M (clean output).
   * @param {string} text
   * @returns {string}
   */
  _postProcess(text) {
    let result = text.trim();
    
    // 1. Strip leading <s> token text if present
    result = result.replace(/^<s>\s*/g, '');
    
    // 2. Extract formula from \begin{aligned} wrapper (Model S specific)
    //    Model S wraps output like:
    //      \begin{aligned} { } & { { } FORMULA } \\ { } & { { } } \\ ...garbage...
    //    We extract FORMULA from the first row's content.
    result = this._unwrapAligned(result);
    
    // 3. Strip bare aligned-row markers (inline formula without \begin{aligned})
    //    Model S inline formulas often contain: "NOISE & { { } FORMULA }"
    //    e.g.: "{  delta & { { } E_{E} = ... }}" → "E_{E} = ..."
    result = this._stripAlignedRowMarkers(result);

    // 4. Fix missing backslashes before known LaTeX commands
    //    Model noise: "rmathrm yr" → "\mathrm{yr}", "\  epsilon" → "\epsilon"
    result = this._fixMissingBackslashes(result);

    // 5. Strip \boxed{...} wrapper if present
    const boxedMatch = result.match(/^\\boxed\s*\{([\s\S]*)\}\s*$/);
    if (boxedMatch) {
      result = boxedMatch[1].trim();
    }
    
    // 6. Truncate at degeneration boundary (garbage suffix after real formula)
    const degenPatterns = [
      /(\\\\?\s*\{\s*\}\s*&\s*\{)/,    // next aligned row: \\ { } & {
      /\\\s+\\\s+/,                       // "\ \ " (backslash-space repeated) = Model S noise
      /(\\\s*){5,}/,                      // 5+ consecutive backslashes
      /(\{\s*\}\s*){4,}/,               // 4+ consecutive empty braces
    ];
    for (const pat of degenPatterns) {
      const match = pat.exec(result);
      if (match) {
        result = result.substring(0, match.index).trim();
        break;
      }
    }
    
    // 5. Balance braces
    let depth = 0;
    for (const ch of result) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth > 0) {
      result += '}'.repeat(depth);
    } else if (depth < 0) {
      result = result.replace(/\}+$/, (m) => m.substring(0, Math.max(0, m.length + depth)));
    }
    
    // 7. Apply standard LaTeX fixes
    return fixLatex(result.trim());
  }

  /**
   * Strip bare aligned-row markers from inline formula content.
   * Model S outputs inline formulas as bare aligned-row content (no \begin{aligned})
   * Pattern: "SOMETHING & { { } FORMULA }" or "{ } & { { } FORMULA }"
   * @param {string} text
   * @returns {string}
   */
  _stripAlignedRowMarkers(text) {
    // Only strip if & is present AND we're not inside a known env
    const firstRow = text.split(/\\\\(?!\w)/)[0];
    if (!firstRow.includes('&')) return text;

    // Extract content after the last & in the first row
    const afterAmpersand = firstRow.substring(firstRow.lastIndexOf('&') + 1).trim();
    // Strip leading { { } wrapper (aligned column wrapper)
    let cleaned = afterAmpersand.replace(/^\s*\{\s*\{\s*\}\s*/, '');
    // Remove matching trailing } if we stripped an opening { { }
    if (afterAmpersand.trimStart().startsWith('{') && cleaned.endsWith('}')) {
      cleaned = cleaned.substring(0, cleaned.length - 1);
    }
    return cleaned.trim() || text;
  }

  /**
   * Fix missing backslashes before known LaTeX commands emitted as plain text.
   * Model noise: "rmathrm" instead of "\mathrm", "\  epsilon" instead of "\epsilon"
   * Reference: No Python equivalent — this is a JS-side quality fix for model artifacts.
   * @param {string} text
   * @returns {string}
   */
  _fixMissingBackslashes(text) {
    // Fix "\ command" patterns (backslash + whitespace + word) → "\command"
    text = text.replace(/\\\s{1,3}([a-zA-Z]+)/g, (_, word) => `\\${word}`);

    // Specific common model typo: rmathrm (missing backslash, wrong prefix r)
    text = text.replace(/\brmathrm\b/g, '\\mathrm');

    // Known single-letter/short commands emitted without backslash
    // Only match when preceded by space/brace/start and NOT already by \
    const bareCmds = [
      'mathrm','mathbf','mathit','mathbb','mathcal','mathsf','mathfrak',
      'text','mbox','operatorname',
      'bar','hat','tilde','vec','dot','ddot','breve','check','acute','grave','widehat','widetilde',
    ];
    for (const cmd of bareCmds) {
      const re = new RegExp(`(?<!\\\\)(?<=[\\s{(,]|^)(${cmd})(?=[\\s{(^_\\\\])`, 'gm');
      text = text.replace(re, `\\$1`);
    }
    return text;
  }

  /**
   * Unwrap \begin{aligned} environment, extracting the first row's formula.
   * Model S often wraps output in aligned with garbage rows after the first.
   * Model M output doesn't use aligned and passes through unchanged.
   * @param {string} text
   * @returns {string}
   */
  _unwrapAligned(text) {
    // Check if wrapped in \begin{aligned}...\end{aligned}
    const alignedMatch = text.match(/^\\begin\{aligned\}([\s\S]*)\\end\{aligned\}\s*$/);
    if (!alignedMatch) {
      // Also handle case where \end{aligned} is missing (truncated)
      const partialMatch = text.match(/^\\begin\{aligned\}([\s\S]*)$/);
      if (!partialMatch) return text; // Not aligned — return as-is (Model M path)
      // Use the partial content
      return this._extractFirstAlignedRow(partialMatch[1]);
    }
    return this._extractFirstAlignedRow(alignedMatch[1]);
  }

  /**
   * Extract the meaningful formula content from the first row of an aligned env.
   * Input format: " { } & { { } FORMULA } \\ { } & ..."
   * @param {string} alignedContent
   * @returns {string}
   */
  _extractFirstAlignedRow(alignedContent) {
    // Split by \\ (row separator in aligned environments)
    const rows = alignedContent.split(/\\\\/);
    if (rows.length === 0) return alignedContent.trim();

    // Take the first non-empty row with real content
    let firstRow = rows[0].trim();

    // Strip leading { } & alignment marker
    firstRow = firstRow.replace(/^\s*\{\s*\}\s*&\s*/, '');

    // Strip wrapping { { } ... } column wrapper
    firstRow = firstRow.replace(/^\s*\{\s*\{\s*\}\s*/, '');
    if (firstRow.endsWith('}')) {
      firstRow = firstRow.substring(0, firstRow.length - 1);
    }

    // Strip orphaned \begin commands inside extracted row
    // Model S sometimes nests "\begin aligned" (with space) inside the row body:
    // e.g. "\begin aligned  \hat { } _ { 0 }" → "\hat { } _ { 0 }"
    firstRow = firstRow.replace(/\\begin\s+\w+\s*/g, '').trim();
    firstRow = firstRow.replace(/\\begin\{[^}]*\}\s*/g, '').trim();

    return firstRow.trim();
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
