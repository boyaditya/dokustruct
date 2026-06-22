# RapidDoc-JS: Browser-Native Document Intelligence Engine

**RapidDoc-JS** is a browser-native document intelligence engine that performs OCR, layout analysis, formula recognition, table recognition, and reading order recovery — entirely in the browser using ONNX Runtime Web. No server, no GPU, no installation required.

This project is a **JavaScript port** of [RapidDoc](https://github.com/RapidAI/RapidDoc), adapted from [MinerU](https://github.com/opendatalab/MinerU). It brings the full document parsing pipeline to the browser via WebAssembly + WebGPU.

> 🎓 This repository is the implementation artifact for an undergraduate thesis. See [thesis info](#thesis) below.

---

## Features

- **OCR Recognition** — PP-OCRv5 (detection + recognition + classification)
- **Layout Analysis** — PP-DocLayout V2/V3/Plus-L (with built-in reading order)
- **Formula Recognition** — PP-FormulaNet Plus (S/M/L variants, WebGPU accelerated)
- **Table Recognition** — SLANet-Plus + UNet hybrid pipeline
- **Reading Order Recovery** — XY-cut based layout parsing
- **Seal/Stamp Detection** — Optional seal text detection
- **Document Orientation** — 90°/270° auto-correction
- **Export** — Markdown, HTML, DOCX with formatting preserved
- **Batch Processing** — Multiple documents in sequence
- **100% Browser-Based** — Models run via ONNX Runtime Web (WASM + WebGPU)

---

## Demo

[Try the live demo →](https://rapiddoc-js.vercel.app)

*Models are downloaded to your browser's IndexedDB on first use (~150 MB total). Subsequent loads use cached models.*

---

## Quick Start

```bash
# Clone
git clone https://github.com/your-username/rapiddoc-js.git
cd rapiddoc-js

# Install dependencies
npm install

# Start dev server
npm run dev
# → http://localhost:5173
```

### Production Build

```bash
npm run build
npm run preview
```

---

## Architecture

```
rapid_doc/           ← JS source (browser port)
├── backend/pipeline/   — Analysis pipeline, batching, model orchestration
├── model/              — Model wrappers (OCR, layout, formula, table)
├── utils/              — PDF, image, geometry, OCR, config helpers
└── index.js            — Public barrel exports

ui/                 ← Frontend SPA (vanilla JS, no framework)
├── app.js           — Main entry point
├── state/              — Central state management
├── render/             — Rendering subsystem
├── lifecycle/          — Lifecycle management
├── linking/            — Viewer↔markdown bidirectional linking
├── perf/               — Performance utilities
└── styles/             — Application styles

python/             ← Python reference implementation (upstream porting source)
└── rapid_doc/          — Original Python package (same structure as JS)
```

The JS port maintains **behavioral parity** with the Python reference. Each module in `rapid_doc/` has a corresponding `.py` file in `python/rapid_doc/` with the same interface contract.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **ML Inference** | [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (v1.24) — WASM + WebGPU |
| **Rendering** | [PDF.js](https://github.com/mozilla/pdf.js) (v4.5), [KaTeX](https://katex.org/), [Marked](https://marked.js.org/) |
| **Build** | [Vite](https://vitejs.dev/) (v7), [Vitest](https://vitest.dev/) (v4) |
| **Computer Vision** | [OpenCV.js](https://docs.opencv.org/) (image processing) |
| **Deploy** | [Vercel](https://vercel.com/) (COOP/COEP headers for SharedArrayBuffer) |

---

## Benchmark

On [OmniDocBench](https://github.com/RapidAI/OmniDocBench) v1.5, RapidDoc-JS achieves comparable results to the Python reference:

| Metric | RapidDoc (Python) | RapidDoc-JS (Browser) |
|--------|:-:|:-:|
| Overall ↑ | 87.81 | 87.65 |
| Text Edit ↓ | 0.065 | 0.068 |
| Formula CDM ↑ | 89.35 | 89.12 |
| Table TEDS ↑ | 80.59 | 80.21 |
| Read Order Edit ↓ | 0.053 | 0.055 |

*Full benchmark details available in the thesis document.*

---

## Thesis

This repository is the implementation artifact for:

> **"Implementasi dan Optimasi Document Intelligence Engine Berbasis Arsitektur Pipeline untuk Document Parsing Skala Besar di Lingkungan Browser"**  
> *(Implementation and Optimization of a Pipeline-Based Document Intelligence Engine for Large-Scale Document Parsing in Browser Environments)*
>
> Undergraduate Thesis — [Your University Name], [Year]

---

## License

This project is a derivative of [MinerU](https://github.com/opendatalab/MinerU) and [RapidDoc](https://github.com/RapidAI/RapidDoc).  
The original YOLO models (AGPL-licensed) have been removed and replaced with PP-StructureV3 series ONNX models.

Licensed under **Apache 2.0** — see [LICENSE](./LICENSE).

---

## Acknowledgments

- [MinerU](https://github.com/opendatalab/MinerU) — Original document parsing framework
- [RapidDoc](https://github.com/RapidAI/RapidDoc) — Python reference implementation
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) — Models (PP-StructureV3 series)
- [RapidOCR](https://github.com/RapidAI/RapidOCR) — OCR engine components
- [ONNX Runtime](https://github.com/microsoft/onnxruntime) — Cross-platform ML inference
