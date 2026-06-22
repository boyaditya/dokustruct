/**
 * Re-export proxy so inference_engine/onnxruntime/main.js can
 * import downloadFile with a relative path from within the layout module tree.
 */
export { downloadFile, DownloadFile, DownloadFileInput, CPU_MODEL } from '../../../../utils/download_file.js';
