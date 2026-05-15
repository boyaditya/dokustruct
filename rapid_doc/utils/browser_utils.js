/**
 * Browser-specific utilities consolidated from multiple pipeline files.
 * Replaces duplicated yieldToBrowser in batch_analyze.js and pipeline_analyze.js.
 * Provides consistent error formatting for pipeline stages.
 */

/**
 * Yields control back to the browser event loop.
 * Prevents UI freeze during long-running pipeline operations.
 * @returns {Promise<void>}
 */
export async function yieldToBrowser() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Formats a pipeline error into a consistent, context-rich message string.
 *
 * Output format:
 *   [ModuleName] stage: message (page N) [recoverable]
 *   [ModuleName] stage: message [non-recoverable]
 *
 * @param {object} err - Error descriptor object
 * @param {string} err.stage - Pipeline stage name (e.g. 'layout', 'formula', 'ocr', 'table')
 * @param {string} err.module - Module name that produced the error
 * @param {string} err.message - Error message text
 * @param {number} [err.pageIndex] - Page index where the error occurred (optional)
 * @param {boolean} err.recoverable - Whether the pipeline can continue after this error
 * @returns {string} Formatted error message
 */
export function formatPipelineError({ stage, module, message, pageIndex, recoverable }) {
  const parts = [`[${module || 'Unknown'}]`];

  if (stage) {
    parts.push(`${stage}:`);
  }

  if (message) {
    parts.push(message);
  }

  if (pageIndex != null) {
    parts.push(`(page ${pageIndex})`);
  }

  parts.push(recoverable ? '[recoverable]' : '[non-recoverable]');

  return parts.join(' ');
}
