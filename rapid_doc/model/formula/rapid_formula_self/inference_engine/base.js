// Copyright (c) Opendatalab. All rights reserved.
// PORTING NOTE: inference_engine/base.py → base.js
// Python abc.ABC abstract class → JS throw-on-abstract pattern

/**
 * Abstract inference session base class.
 * PORTING NOTE: InferSession ABC → JS class with abstract method guards
 */
export class InferSession {
  /**
   * Run inference with the given input tensors.
   * @param {Object<string, import('onnxruntime-web').Tensor>} inputContent
   * @returns {Promise<import('onnxruntime-web').InferenceSession.OnnxValueMapType>}
   */
  async run(inputContent) {
    throw new Error("InferSession.run() is abstract — must be implemented by subclass");
  }

  /**
   * Get list of input tensor names.
   * @returns {readonly string[]}
   */
  getInputNames() {
    throw new Error("InferSession.getInputNames() is abstract");
  }

  /**
   * Get list of output tensor names.
   * @returns {readonly string[]}
   */
  getOutputNames() {
    throw new Error("InferSession.getOutputNames() is abstract");
  }

  /**
   * Get character list from model metadata.
   * @param {string} [key]
   * @returns {string[]}
   */
  getCharacterList(key) {
    throw new Error("InferSession.getCharacterList() is abstract");
  }
}

/**
 * Get engine class by engine type string.
 * @param {string} engineType
 * @returns {typeof InferSession}
 */
export function getEngine(engineType) {
  if (engineType === "onnxruntime") {
    // Lazy import to avoid circular deps — caller must import OrtInferSession directly
    throw new Error(
      "getEngine: import OrtInferSession from './onnxruntime/main.js' directly"
    );
  }
  if (engineType === "torch") {
    throw new Error("getEngine: 'torch' engine is not supported in browser");
  }
  throw new Error(`getEngine: unknown engine type '${engineType}'`);
}

export default InferSession;
