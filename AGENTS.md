# RapidDoc-JS Agent Context

RapidDoc-JS ports the RapidDoc document intelligence engine to a browser-native JavaScript implementation using ONNXRuntime Web. The JavaScript/browser path is the active target. Python files in this repo are the reference baseline for behavior and parity.

## Read Order

1. `AGENTS.md` - fast orientation and agent rules.
2. `.kiro/steering/product.md` - product intent and success criteria.
3. `.kiro/steering/structure.md` - repository map and ownership boundaries.
4. `.kiro/steering/tech.md` - runtime, build, and validation commands.
5. `documentation/AI_AGENT_PROJECT_GUIDE.md` - detailed agent guide.
6. `documentation/PIPELINE_FLOW.md` - canonical pipeline flow.

## Core Paths

- `rapid_doc/index.js` - public browser-port exports.
- `rapid_doc/backend/pipeline/` - main analysis pipeline, batching, middle JSON, model lifecycle.
- `rapid_doc/model/` - JS model wrappers and model-specific logic.
- `rapid_doc/utils/` - shared PDF, image, geometry, OCR, config, and output helpers.
- `ui/` - Vite browser UI, state store, and pipeline adapter.
- `demo/` - Python and sample-file reference workflows.
- `public/models/` - browser-served ONNX/model assets.
- `documentation/` - audits, parity notes, and detailed implementation guides.

## Working Rules

- Prefix shell commands with `rtk`.
- Prefer JS/browser implementation work unless the user explicitly asks for Python.
- Use Python as the source-of-truth baseline when checking behavior parity.
- Keep changes surgical. Do not add speculative abstractions or broad refactors.
- Preserve user changes in this dirty worktree. Do not revert unrelated edits.
- Avoid generated/heavy folders unless explicitly needed: `node_modules/`, `dist/`, `output/`, `__pycache__/`, `.venv/`.
- Keep agent-facing docs concise; place long explanations in `documentation/`.