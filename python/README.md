# Python Reference — Minimal Reproducible Subset

> **Jangan upgrade** — `python/rapid_doc/` harus tetap **v0.9.4** (MinerU base 2.6.4, `version.py`) agar identik dengan baseline. Patch graf (operator & tensor shape PP-DocLayout & SLANet Plus, ADP-26) hanya di **JS** (`rapid_doc/model/...`), bukan di Python.

Subset minimal untuk reproduksi benchmark (272 files, ~3 MB vs ~47 MB full upstream):

- `rapid_doc/` — 267 files, kanon porting (file-per-file ke `rapid_doc/` JS, lihat `PORTING NOTE`)
- `demo/demo_batch.py` (36 KB) + `demo/demo_run.py` (18 KB) + `demo/__init__.py` — batch runners JS-parity (EP config: layout+OCR → DirectML/CPU, formula+table → CPU; bandingkan dengan JS WebGPU/WASM)
- `pyproject.toml` — `pip install -e ./python` (deps: `rapidocr`, `pypdfium2`, `onnxruntime` etc; CPU/GPU via `[cpu]`/`[gpu]`)
- `LICENSE` — Apache 2.0 (upstream)

Dikeluarkan: `demo/images`, `demo/pdfs` (~40 MB), `docker/`, `chunker/`, `docs/`, `tests/` — tidak relevan untuk `Content List` evaluator atau OmniDocBench v1.6 (1651 hal, N=350/50).

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ./python
pip install -r benchmark/requirements.txt
PYTHONPATH=python python -m demo.demo_batch --pdfs path/to/pdfs --repeat 10 --warmup 2 --formula --table
```

Lihat root `README.md` (Reproducibility + Dataset) dan `benchmark/README.md` (Prerequisites, GT mode, sampler N=350/50 seed 42).
