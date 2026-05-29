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

from typing import Any, Dict, List, Optional

from .alignment import align_content_lists
from .metrics import edit_distance, normalize_text, ned


def _reading_order_edit(diff_items: List[Dict[str, Any]]) -> Optional[float]:
    """Normalized edit distance between the matched reading-order sequences.

    The alignment walks GT in its native (reading) order, so for matched pairs
    the GT sequence is monotonic 0..n-1. We recover the prediction-side order
    from each matched item's (page_a, original prediction index) and measure how
    far that order deviates from GT order. Identity => 0.
    """
    matched = [d for d in diff_items if d.get("status") == "matched"]
    n = len(matched)
    if n < 2:
        return None
    # GT order is the encounter order (already reading-order sorted upstream).
    gt_order = list(range(n))
    # Prediction order: sort matched items by their position on the prediction
    # side. We approximate prediction position with (page_a, vertical bbox top)
    # when available, else fall back to encounter order.
    def pred_key(idx_item):
        i, d = idx_item
        page = d.get("page_a", 0) or 0
        return (page, i)
    pred_sorted = sorted(enumerate(matched), key=pred_key)
    # The rank of each GT-encounter index within the prediction ordering.
    pred_order = [orig_i for orig_i, _ in pred_sorted]
    return round(edit_distance(pred_order, gt_order) / n, 4)


def score_against_gt(pred_cl: List[Dict], gt_cl: List[Dict]) -> Dict[str, Any]:
    """Score one document's prediction content_list against GT content_list."""
    align = align_content_lists(pred_cl, gt_cl)

    text_edit = align["mean_ned_norm"]      # may be None
    text_cer = align["mean_cer"]            # may be None
    table_teds = align["mean_teds"]         # may be None

    # Formula: NED over LaTeX of matched equation pairs (proxy for CDM).
    formula_vals: List[float] = []
    for d in align["diff_items"]:
        if d.get("status") == "matched" and d.get("type_a") == "equation" \
                and d.get("type_b") == "equation":
            a = normalize_text(d.get("text_a", ""))
            b = normalize_text(d.get("text_b", ""))
            formula_vals.append(ned(a, b))
    formula_edit = round(sum(formula_vals) / len(formula_vals), 4) if formula_vals else None

    reading_order_edit = _reading_order_edit(align["diff_items"])

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
        "reading_order_edit": reading_order_edit,
        "overall": overall,
        "coverage_f1": align["coverage_f1"],
        "coverage_precision": align["coverage_precision"],
        "coverage_recall": align["coverage_recall"],
        "n_text_pairs": align["n_text_pairs"],
        "n_table_pairs": align["n_table_pairs"],
        "n_only_pred": align["n_only_js"],     # pred == system A role
        "n_only_gt": align["n_only_python"],   # gt == system B role
        "mean_bbox_iou": align["mean_bbox_iou"],
        "diff_items": align["diff_items"],
    }


__all__ = ["score_against_gt"]
