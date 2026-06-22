"""
benchmark/omnidocbench.py
=========================
Adapter for the OmniDocBench dataset (https://github.com/opendatalab/OmniDocBench).

OmniDocBench ships 1651 page IMAGES plus a single ground-truth JSON
(`OmniDocBench.json`) with block-level annotations: localized boxes carrying
text / LaTeX (formula) / HTML+LaTeX (table) recognition results, reading order,
and page/block attribute labels (document type, language, etc.).

This module converts that GT JSON into the SAME `content_list` shape the
RapidDoc pipeline emits (one list per page), so both systems can be scored
against real ground truth — not just against each other. It also extracts the
page attributes used for stratified (per-category / per-language) reporting.

What this gives the thesis:
  - Absolute accuracy (edit distance / CER / TEDS) vs human-annotated GT.
  - Stratification by document type and language (OmniDocBench's own taxonomy).
  - A fair, published benchmark instead of an ad-hoc PDF set.

Scope note (documented deviation from the official leaderboard):
  - The official formula metric is CDM, which needs a full LaTeX rendering
    toolchain (TeX Live + ImageMagick + Ghostscript). That is heavy and not
    relevant to a browser port, so formulas are scored with normalized-LaTeX
    edit distance (a recognized proxy). State this in the methodology chapter.

GT JSON shape (per page, fields used here):
  {
    "layout_dets": [
      {"category_type": "text_block", "text": "...", "poly": [x0,y0,x1,y1,x2,y2,x3,y3],
       "order": 3, "anno_id": 12, ...},
      {"category_type": "table", "html": "<table>...", "latex": "...", "poly": [...], "order": 5},
      {"category_type": "equation_isolated", "latex": "E=mc^2", "poly": [...], "order": 7},
      ...
    ],
    "page_info": {
      "image_path": "xxx.jpg", "height": 2339, "width": 1654,
      "page_attribute": {"data_source": "...", "language": "english",
                          "layout": "single_column", ...}
    },
    "extra": {...}
  }

Category mapping (OmniDocBench category_type -> our content_list type):
  text_block, title, ...            -> "text"
  equation_isolated                 -> "equation"
  table                             -> "table"
  figure / image                    -> "image"
  page_*, abandon, header, footer   -> "discarded" (or skipped)
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# Category names that should be treated as plain text in the content list.
# Aligned with the REAL OmniDocBench.json category_type values (v1.x).
_TEXT_CATEGORIES = {
    "text_block", "title", "text", "paragraph", "list", "index",
    "code_txt", "code_txt_caption", "reference",
    "table_caption", "table_footnote", "figure_caption", "image_caption",
    "figure_footnote", "image_footnote", "code_caption",
    "equation_caption", "equation_explanation",
}
_EQUATION_CATEGORIES = {"equation_isolated", "equation", "formula", "isolate_formula"}
_TABLE_CATEGORIES = {"table"}
_IMAGE_CATEGORIES = {"figure", "image", "chart"}
# Page furniture: kept as "discarded" (excluded from content scoring, but
# mirrors OmniDocBench's ignore semantics).
_DISCARDED_CATEGORIES = {
    "abandon", "page_number", "page_footnote", "page_header", "page_footer",
    "header", "footer", "watermark",
}
# Span-level masks, grouping containers, and inline/semantic items that the
# RapidDoc pipeline does NOT emit as content_list entries. These are skipped
# entirely so they neither appear nor distort alignment. Checked BEFORE the
# text fallback (important: "text_mask" contains "text").
_SKIP_CATEGORIES = {
    "text_mask", "chart_mask", "table_mask", "unknown_mask",
    "organic_chemical_formula_mask", "need_mask", "algorithm_mask",
    "list_group", "equation_semantic", "line", "text_span",
    "inline_formula", "equation_inline", "subscript", "superscript",
}


def _poly_to_bbox(poly: Optional[List[float]],
                  bbox: Optional[List[float]]) -> Optional[List[float]]:
    """Convert an 8-point polygon (or a 4-value bbox) to [x0, y0, x1, y1]."""
    if bbox and len(bbox) >= 4:
        return [float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])]
    if not poly:
        return None
    xs = poly[0::2]
    ys = poly[1::2]
    if not xs or not ys:
        return None
    return [float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))]


def _normalize_bbox(bbox: Optional[List[float]],
                    width: float, height: float) -> Optional[List[float]]:
    """Scale pixel bbox to the 0..1000 space the RapidDoc content_list uses."""
    if not bbox or width <= 0 or height <= 0:
        return bbox
    x0, y0, x1, y1 = bbox
    return [
        round(x0 * 1000.0 / width, 2),
        round(y0 * 1000.0 / height, 2),
        round(x1 * 1000.0 / width, 2),
        round(y1 * 1000.0 / height, 2),
    ]


def _map_type(category: str) -> Optional[str]:
    c = (category or "").lower()
    if c in _SKIP_CATEGORIES:
        return None
    if c in _DISCARDED_CATEGORIES:
        return "discarded"
    if c in _EQUATION_CATEGORIES:
        return "equation"
    if c in _TABLE_CATEGORIES:
        return "table"
    if c in _IMAGE_CATEGORIES:
        return "image"
    if c in _TEXT_CATEGORIES:
        return "text"
    # Unknown categories: skip masks/spans defensively, else treat caption/title
    # -ish things as text. (Masks already handled above.)
    if "mask" in c or "span" in c or "inline" in c:
        return None
    if "text" in c or "title" in c or "caption" in c or "footnote" in c:
        return "text"
    return None


def gt_page_to_content_list(page: Dict[str, Any],
                            include_discarded: bool = False) -> List[Dict[str, Any]]:
    """Convert one OmniDocBench GT page into a RapidDoc-style content_list.

    Items are ordered by the annotation `order` field (reading order) when
    present, so reading-order comparison is meaningful.
    """
    page_info = page.get("page_info", {}) or {}
    width = float(page_info.get("width") or page_info.get("page_width") or 0) or 0.0
    height = float(page_info.get("height") or page_info.get("page_height") or 0) or 0.0

    dets = page.get("layout_dets", []) or []
    items: List[Tuple[float, Dict[str, Any]]] = []

    for det in dets:
        cat = det.get("category_type") or det.get("category") or det.get("type") or ""
        # Respect OmniDocBench's own ignore flag (these are excluded from eval).
        if det.get("ignore") is True:
            if not include_discarded:
                continue
        mapped = _map_type(cat)
        if mapped is None:
            continue
        if mapped == "discarded" and not include_discarded:
            continue

        bbox = _normalize_bbox(_poly_to_bbox(det.get("poly"), det.get("bbox")), width, height)
        order = det.get("order")
        order_key = float(order) if isinstance(order, (int, float)) else 1e9

        item: Dict[str, Any] = {"type": mapped, "page_idx": 0}
        if bbox is not None:
            item["bbox"] = bbox

        if mapped == "table":
            item["table_body"] = det.get("html") or det.get("table_body") or ""
            if det.get("latex"):
                item["latex"] = det["latex"]
        elif mapped == "equation":
            item["text"] = det.get("latex") or det.get("text") or ""
            item["text_format"] = "latex"
        elif mapped == "image":
            item["img_path"] = det.get("image_path") or ""
        else:  # text / discarded
            item["text"] = det.get("text") or det.get("content") or ""

        items.append((order_key, item))

    items.sort(key=lambda t: t[0])
    return [it for _, it in items]


def extract_page_attributes(page: Dict[str, Any]) -> Dict[str, Any]:
    """Pull page-level attribute labels for stratified reporting."""
    page_info = page.get("page_info", {}) or {}
    attrs = page_info.get("page_attribute", {}) or page_info.get("attribute", {}) or {}
    image_path = page_info.get("image_path") or page_info.get("image_name") or ""
    return {
        "image_path": image_path,
        "stem": Path(image_path).stem if image_path else "",
        "data_source": attrs.get("data_source") or attrs.get("type"),
        "language": attrs.get("language"),
        "layout": attrs.get("layout"),
        "subset": attrs.get("subset"),
        "attributes": attrs,
        "page_width": page_info.get("width"),
        "page_height": page_info.get("height"),
    }


def convert_dataset(gt_json_path: Path, out_dir: Path,
                    include_discarded: bool = False) -> Dict[str, Dict[str, Any]]:
    """Convert a full OmniDocBench.json into per-page GT content lists.

    Writes `<stem>_content_list.json` per page into out_dir, plus an
    `omnidocbench_index.json` mapping stems to page attributes (for
    stratification). Returns the index dict.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    data = json.loads(gt_json_path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "data" in data:
        pages = data["data"]
    else:
        pages = data
    if not isinstance(pages, list):
        raise ValueError("Unexpected OmniDocBench JSON structure (expected a list of pages).")

    index: Dict[str, Dict[str, Any]] = {}
    for page in pages:
        attrs = extract_page_attributes(page)
        stem = attrs["stem"]
        if not stem:
            continue
        cl = gt_page_to_content_list(page, include_discarded=include_discarded)
        (out_dir / f"{stem}_content_list.json").write_text(
            json.dumps(cl, ensure_ascii=False, indent=2), encoding="utf-8")
        # Content-complexity signals so the timing corpus can be stratified by
        # what actually drives runtime (text/table/formula counts), not just
        # document type and language.
        type_counts: Dict[str, int] = {}
        for it in cl:
            t = it.get("type", "unknown")
            type_counts[t] = type_counts.get(t, 0) + 1
        n_items = len(cl)
        complexity = "simple" if n_items <= 5 else ("medium" if n_items <= 15 else "complex")
        index[stem] = {
            "n_items": n_items,
            "complexity": complexity,
            "n_text": type_counts.get("text", 0),
            "n_table": type_counts.get("table", 0),
            "n_equation": type_counts.get("equation", 0),
            "n_image": type_counts.get("image", 0),
            "data_source": attrs["data_source"],
            "language": attrs["language"],
            "layout": attrs["layout"],
            "subset": attrs["subset"],
            "image_path": attrs["image_path"],
        }

    (out_dir / "omnidocbench_index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    return index


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(
        description="Convert OmniDocBench GT JSON into per-page content lists.")
    parser.add_argument("--gt-json", required=True, type=Path,
                        help="Path to OmniDocBench.json")
    parser.add_argument("--out-dir", default=Path("benchmark/omnidocbench_gt"), type=Path,
                        help="Where to write per-page GT content lists")
    parser.add_argument("--include-discarded", action="store_true", default=False)
    args = parser.parse_args()

    if not args.gt_json.exists():
        raise SystemExit(f"GT JSON not found: {args.gt_json}")
    index = convert_dataset(args.gt_json, args.out_dir, args.include_discarded)
    print(f"[omnidocbench] Converted {len(index)} pages -> {args.out_dir}")
    # Quick stratification summary
    from collections import Counter
    langs = Counter(v.get("language") for v in index.values())
    sources = Counter(v.get("data_source") for v in index.values())
    print(f"  languages: {dict(langs)}")
    print(f"  doc types: {dict(sources)}")


if __name__ == "__main__":
    main()
