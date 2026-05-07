// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: rapid_table_self/inference_engine/base.py → base.js
// Adds OPENVINO branch (stub) compared to formula version.

/**
 * Abstract inference session base class.
 */
export class InferSession {
  async run(inputContent) {
    throw new Error("InferSession.run() is abstract");
  }
  getInputNames() { throw new Error("InferSession.getInputNames() is abstract"); }
  getOutputNames() { throw new Error("InferSession.getOutputNames() is abstract"); }
  getCharacterList(key) { throw new Error("InferSession.getCharacterList() is abstract"); }
}

/**
 * Get engine class by type string.
 * @param {string} engineType
 * @returns {string}
 */
export function getEngine(engineType) {
  if (engineType === "onnxruntime") {
    throw new Error("getEngine: import OrtInferSession from './onnxruntime/main.js' directly");
  }
  if (engineType === "torch") {
    throw new Error("getEngine: 'torch' engine not supported in browser");
  }
  if (engineType === "openvino") {
    throw new Error("getEngine: 'openvino' engine not supported in browser");
  }
  throw new Error(`getEngine: unknown engine type '${engineType}'`);
}

export default InferSession;
