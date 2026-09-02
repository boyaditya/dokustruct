// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: table_structure/unitable/post_process.py → post_process.js
// Stub — original uses PyTorch directly; ONNX-based implementation possible but complex.
// PORTING NOTE: UniTable post-processing decodes token IDs to HTML using HTML_BBOX_HTML_TOKENS + BBOX_TOKENS.

import { HTML_BBOX_HTML_TOKENS, BBOX_TOKENS, EOS_TOKEN } from "./consts.js";

/**
 * Build vocabulary mapping from UniTable token lists.
 * @returns {{ idToToken: string[], tokenToId: Map<string, number> }}
 */
export function buildUniTableVocab() {
  const vocab = [EOS_TOKEN, ...HTML_BBOX_HTML_TOKENS, ...BBOX_TOKENS];
  const tokenToId = new Map(vocab.map((t, i) => [t, i]));
  return { idToToken: vocab, tokenToId };
}

/**
 * Decode UniTable model output tensor to HTML structure.
 * PORTING NOTE: Original uses torch.Tensor ops; this ports the decoding logic to JS.
 * @param {import('onnxruntime-web').Tensor} outputTensor - [N, SeqLen] int64 or float32
 * @param {{ idToToken: string[] }} vocab
 * @returns {string[]} HTML strings per batch item
 */
export function decodeUniTableOutput(outputTensor, vocab) {
  const { idToToken } = vocab;
  const data = Array.from(outputTensor.cpuData ?? outputTensor.data);
  const dims = outputTensor.dims;
  const [N, SeqLen] = dims.length === 2 ? dims : [1, dims[0]];

  const results = [];
  for (let n = 0; n < N; n++) {
    const tokens = [];
    for (let s = 0; s < SeqLen; s++) {
      const id = Math.round(Number(data[n * SeqLen + s]));
      if (id === 0) break; // EOS
      const token = idToToken[id];
      if (token && token !== EOS_TOKEN) tokens.push(token);
    }
    results.push(`<table>${tokens.join("")}</table>`);
  }
  return results;
}
