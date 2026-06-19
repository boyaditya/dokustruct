"""
benchmark/gt_scoring.py
=======================
Score a system's content_list against OmniDocBench ground truth (absolute
accuracy), reusing the page-aware alignment + metric primitives.

Produces, per document and aggregated:
  - text_edit       : mean normalized edit distance on text blocks (lower better)
  - text_cer        : mean CER on text blocks
  - formula_edit    : mean normalized LaTeX edit distance on display formulas
                      (proxy for the official CDM metric — documented deviation)
  - table_teds      : mean TEDS on tables (higher better)
  - reading_order_edit : normalized edit distance of reading-order index sequence
  - overall         : OmniDocBench-style end-to-end score
                      = ((1 - text_edit) * 100 + table_teds*100 + formula_score*100) / 3
                      reported on a 0..100 scale (higher better)

Convention: GT is the reference (system B role), prediction is the hypothesis.
"""

from __future__ import annotations

from typing import Any, Dict, List

from .alignment import align_content_lists
from .metrics import latex_ned


def _item_type(item: Dict) -> str:
    return item.get("type", "unknown")


def _item_text(item: Dict) -> str:
    if _item_type(item) == "table":
        return item.get("table_body") or item.get("html") or ""
    return item.get("text") or item.get("content") or ""


def _count_type(content_list: List[Dict], typ: str) -> int:
    return sum(1 for item in content_list if _item_type(item) == typ)


def score_against_gt(pred_cl: List[Dict], gt_cl: List[Dict]) -> Dict[str, Any]:
    """Score one document's prediction content_list against GT content_list."""
    align = align_content_lists(pred_cl, gt_cl)

    n_text_gt = _count_type(gt_cl, "text")
    n_formula_gt = _count_type(gt_cl, "equation")
    n_table_gt = _count_type(gt_cl, "table")
    n_formula_pred = _count_type(pred_cl, "equation")
    n_table_pred = _count_type(pred_cl, "table")

    text_edit = align["mean_ned_norm"]      # may be None
    text_cer = align["mean_cer"]            # may be None
    if n_text_gt and text_edit is None:
        # A prediction that misses all GT text should not disappear from the
        # composite. Use maximal edit/CER cost; coverage still captures count.
        text_edit = 1.0
        text_cer = 1.0

    # Formula: LaTeX-aware NED over GT equations. Missing GT formulas are
    # penalized as 1.0; pages without GT formulas remain N/A rather than 0.
    formula_vals: List[float] = []
    for d in align["diff_items"]:
        if d.get("status") == "matched" and d.get("type_a") == "equation" \
                and d.get("type_b") == "equation":
            formula_vals.append(latex_ned(d.get("text_a", ""), d.get("text_b", "")))
        elif d.get("status") == "only_in_python" and d.get("type_b") == "equation":
            formula_vals.append(1.0)
    formula_edit = (
        round(sum(formula_vals) / n_formula_gt, 4)
        if n_formula_gt else None
    )

    # Tables follow the same GT-denominator policy: missing GT tables score 0,
    # while documents with no GT table are N/A.
    table_teds_vals: List[float] = []
    table_teds_struct_vals: List[float] = []
    for d in align["diff_items"]:
        if d.get("status") == "matched" and d.get("type_a") == "table" \
                and d.get("type_b") == "table":
            table_teds_vals.append(d.get("teds", 0.0))
            table_teds_struct_vals.append(d.get("teds_struct", 0.0))
        elif d.get("status") == "only_in_python" and d.get("type_b") == "table":
            table_teds_vals.append(0.0)
            table_teds_struct_vals.append(0.0)
    table_teds = (
        round(sum(table_teds_vals) / n_table_gt, 4)
        if n_table_gt else None
    )
    table_teds_struct = (
        round(sum(table_teds_struct_vals) / n_table_gt, 4)
        if n_table_gt else None
    )

    # Reading order: use the order-INDEPENDENT correlation from alignment, then
    # express it as an edit-like cost in [0,1] (0 = identical order). Kendall's
    # tau in [-1,1] -> (1 - tau) / 2.
    tau = align.get("reading_order_kendall_tau")
    reading_order_edit = round((1.0 - tau) / 2.0, 4) if tau is not None else None

    # OmniDocBench-style Overall (0..100). Missing modalities are dropped from
    # the average rather than scored as zero, so a text-only page is not
    # penalised for having no tables/formulas.
    components: List[float] = []
    if text_edit is not None:
        components.append((1.0 - text_edit) * 100.0)
    if table_teds is not None:
        components.append(table_teds * 100.0)
    if formula_edit is not None:
        components.append((1.0 - formula_edit) * 100.0)
    overall = round(sum(components) / len(components), 2) if components else None

    return {
        "text_edit": text_edit,
        "text_cer": text_cer,
        "formula_edit": formula_edit,
        "table_teds": table_teds,
        "table_teds_struct": table_teds_struct,
        "reading_order_edit": reading_order_edit,
        "overall": overall,
        "coverage_f1": align["coverage_f1"],
        "coverage_precision": align["coverage_precision"],
        "coverage_recall": align["coverage_recall"],
        "n_text_pairs": align["n_text_pairs"],
        "n_table_pairs": align["n_table_pairs"],
        "n_text_gt": n_text_gt,
        "n_formula_gt": n_formula_gt,
        "n_formula_pred": n_formula_pred,
        "n_formula_pairs": align["n_formula_pairs"],
        "n_formula_scored": len(formula_vals),
        "n_table_gt": n_table_gt,
        "n_table_pred": n_table_pred,
        "n_table_scored": len(table_teds_vals),
        "n_only_pred": align["n_only_js"],     # pred == system A role
        "n_only_gt": align["n_only_python"],   # gt == system B role
        "mean_bbox_iou": align["mean_bbox_iou"],
        "diff_items": align["diff_items"],
    }


__all__ = ["score_against_gt"]
