/**
 * rapid_doc/model/layout/rapid_layout_self/utils/logger.js
 * PORTING NOTE: rapid_layout_self/utils/logger.py → logger.js
 *
 * Re-exports the shared getLogger factory from the top-level utils module so
 * rapid_layout_self code can import from a local relative path.
 */
export { Logger, getLogger } from '../../../../utils/logger.js';
