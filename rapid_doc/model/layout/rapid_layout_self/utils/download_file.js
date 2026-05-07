/**
 * rapid_doc/model/layout/rapid_layout_self/utils/download_file.js
 * PORTING NOTE: Re-export proxy so inference_engine/onnxruntime/main.js can
 * import downloadFile with a relative path from within the layout module tree.
 *
 * The real implementation lives at rapid_doc/utils/download_file.js.
 */
export { downloadFile, DownloadFile, DownloadFileInput, CPU_MODEL } from '../../../../utils/download_file.js';
