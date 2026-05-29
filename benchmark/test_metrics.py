"""
benchmark/test_metrics.py
=========================
Unit tests for the benchmark metric primitives and content-list alignment.

Run:
    rtk python -m pytest benchmark/test_metrics.py -q
    .venv\\Scripts\\python.exe -m pytest benchmark/test_metrics.py -q
"""

from __future__ import annotations

import math

from benchmark.metrics import (
    bbox_iou,
    cer,
    edit_distance,
    geometric_mean,
    ned,
    normalize_text,
    rank_correlation,
    teds,
    wer,
    wilcoxon_signed_rank,
)
from benchmark.alignment import align_content_lists


# ---------------------------------------------------------------------------
# Edit distance / NED
# ---------------------------------------------------------------------------

def test_edit_distance_basic():
    assert edit_distance("kitten", "sitting") == 3
    assert edit_distance("", "abc") == 3
    assert edit_distance("abc", "") == 3
    assert edit_distance("same", "same") == 0


def test_ned_bounds():
    assert ned("abc", "abc") == 0.0
    assert ned("", "") == 0.0
    assert 0.0 < ned("abc", "abd") <= 1.0
    assert ned("abc", "xyz") == 1.0


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

def test_normalize_collapses_whitespace():
    assert normalize_text("  hello\n\tworld  ") == "hello world"
    assert normalize_text(None) == ""
    assert normalize_text("") == ""


def test_normalize_unicode_nfc():
    # NFC composes combining sequences; result should be stable + idempotent.
    s = normalize_text("e\u0301")  # e + combining acute
    assert s == normalize_text(s)


# ---------------------------------------------------------------------------
# CER / WER
# ---------------------------------------------------------------------------

def test_cer_wer():
    assert cer("hello", "hello") == 0.0
    assert math.isclose(cer("hello world", "helo world"), 1 / 11, rel_tol=1e-6)
    assert wer("a b c d", "a b c d") == 0.0
    assert math.isclose(wer("a b c d", "a x c d"), 0.25, rel_tol=1e-6)
    assert cer("", "") == 0.0


# ---------------------------------------------------------------------------
# bbox IoU
# ---------------------------------------------------------------------------

def test_bbox_iou():
    assert bbox_iou([0, 0, 10, 10], [0, 0, 10, 10]) == 1.0
    assert bbox_iou(None, [0, 0, 1, 1]) is None
    assert bbox_iou([0, 0, 10, 10], [20, 20, 30, 30]) == 0.0
    assert math.isclose(bbox_iou([0, 0, 10, 10], [5, 0, 15, 10]), 1 / 3, rel_tol=1e-6)


# ---------------------------------------------------------------------------
# TEDS
# ---------------------------------------------------------------------------

def test_teds_identical_and_diff():
    same = "<table><tr><td>a</td><td>b</td></tr></table>"
    assert teds(same, same) == 1.0
    less = "<table><tr><td>a</td></tr></table>"
    score = teds(same, less)
    assert 0.0 <= score < 1.0


def test_teds_cell_text_matters():
    a = "<table><tr><td>hello</td></tr></table>"
    b = "<table><tr><td>world</td></tr></table>"
    assert teds(a, b) < 1.0


# ---------------------------------------------------------------------------
# Aggregates / stats
# ---------------------------------------------------------------------------

def test_geometric_mean():
    assert math.isclose(geometric_mean([1, 4]), 2.0, rel_tol=1e-9)
    assert geometric_mean([]) == 0.0
    # geomean differs from arithmetic mean of ratios
    assert geometric_mean([0.5, 2.0]) == 1.0


def test_wilcoxon_and_effect_size():
    a = [1.0, 2.0, 3.0, 4.0, 5.0]
    b = [1.5, 2.6, 3.7, 4.9, 6.1]  # consistently larger
    res = wilcoxon_signed_rank(a, b)
    assert res["n_pairs"] == 5
    assert res["p_value"] is not None
    assert res["effect_size_r"] is not None
    assert res["median_diff"] < 0  # a - b negative


def test_wilcoxon_all_equal():
    res = wilcoxon_signed_rank([1, 2, 3], [1, 2, 3])
    assert res["p_value"] == 1.0
    assert res["effect_size_r"] == 0.0


def test_rank_correlation_perfect():
    res = rank_correlation([0, 1, 2, 3], [0, 1, 2, 3])
    assert res["kendall_tau"] == 1.0
    assert res["spearman_rho"] == 1.0


# ---------------------------------------------------------------------------
# Alignment
# ---------------------------------------------------------------------------

def _doc(types_texts, page=0):
    out = []
    for t, txt in types_texts:
        item = {"type": t, "page_idx": page}
        if t == "table":
            item["table_body"] = txt
        else:
            item["text"] = txt
        out.append(item)
    return out


def test_alignment_perfect_match():
    cl = _doc([("text", "hello"), ("equation", "x=1")])
    res = align_content_lists(cl, cl)
    assert res["n_matched"] == 2
    assert res["coverage_f1"] == 1.0
    assert res["mean_ned_norm"] == 0.0
    assert res["type_consistency"] == 1.0


def test_alignment_detects_missing_item():
    a = _doc([("text", "hello"), ("text", "world")])
    b = _doc([("text", "hello")])
    res = align_content_lists(a, b)
    assert res["n_only_js"] == 1
    assert res["n_only_python"] == 0
    assert res["coverage_recall"] == 1.0   # all of B matched
    assert res["coverage_precision"] < 1.0  # extra in A


def test_alignment_is_per_page():
    # Same types but different pages should not cross-match incorrectly.
    a = _doc([("text", "alpha")], page=0) + _doc([("text", "beta")], page=1)
    b = _doc([("text", "beta")], page=1) + _doc([("text", "alpha")], page=0)
    res = align_content_lists(a, b)
    # Per-page alignment should match alpha↔alpha (p0) and beta↔beta (p1)
    assert res["n_matched"] == 2
    assert res["mean_ned_norm"] == 0.0


def test_alignment_content_aware_text():
    a = _doc([("text", "completely different aaaa")])
    b = _doc([("text", "totally unrelated bbbb")])
    res = align_content_lists(a, b)
    assert res["n_matched"] == 1
    assert res["mean_ned_norm"] > 0.0


# ---------------------------------------------------------------------------
# OmniDocBench converter + GT scoring
# ---------------------------------------------------------------------------

def _omnidoc_page():
    return {
        "layout_dets": [
            {"category_type": "title", "text": "Title",
             "poly": [10, 10, 90, 10, 90, 30, 10, 30], "order": 0},
            {"category_type": "text_block", "text": "Body text here.",
             "poly": [10, 40, 90, 40, 90, 80, 10, 80], "order": 1},
            {"category_type": "equation_isolated", "latex": "a^2+b^2=c^2",
             "poly": [10, 90, 50, 90, 50, 110, 10, 110], "order": 2},
            {"category_type": "table", "html": "<table><tr><td>x</td></tr></table>",
             "poly": [10, 120, 90, 120, 90, 180, 10, 180], "order": 3},
            {"category_type": "page_number", "text": "1",
             "poly": [45, 190, 55, 190, 55, 198, 45, 198], "order": 4},
        ],
        "page_info": {"image_path": "doc_1.jpg", "height": 200, "width": 100,
                      "page_attribute": {"data_source": "academic", "language": "english"}},
    }


def test_omnidoc_convert_types_and_drop_discarded():
    from benchmark.omnidocbench import gt_page_to_content_list
    cl = gt_page_to_content_list(_omnidoc_page())
    assert [it["type"] for it in cl] == ["text", "text", "equation", "table"]
    assert cl[2]["text_format"] == "latex"
    assert cl[2]["text"] == "a^2+b^2=c^2"
    assert cl[3]["table_body"] == "<table><tr><td>x</td></tr></table>"


def test_omnidoc_bbox_normalized_to_1000():
    from benchmark.omnidocbench import gt_page_to_content_list
    cl = gt_page_to_content_list(_omnidoc_page())
    # title poly x range 10..90 of width 100 -> 100..900 in 0..1000 space
    assert cl[0]["bbox"][0] == 100.0
    assert cl[0]["bbox"][2] == 900.0


def test_omnidoc_reading_order_sorted():
    from benchmark.omnidocbench import gt_page_to_content_list
    page = _omnidoc_page()
    # shuffle order field; converter must re-sort by `order`
    page["layout_dets"][0]["order"] = 5
    cl = gt_page_to_content_list(page)
    # title now last among the 4 kept items
    assert cl[-1]["text"] == "Title"


def test_gt_scoring_perfect_and_imperfect():
    from benchmark.omnidocbench import gt_page_to_content_list
    from benchmark.gt_scoring import score_against_gt
    gt = gt_page_to_content_list(_omnidoc_page())
    perfect = score_against_gt(gt, gt)
    assert perfect["text_edit"] == 0.0
    assert perfect["table_teds"] == 1.0
    assert perfect["overall"] == 100.0

    # introduce a text error
    pred = [dict(it) for it in gt]
    pred[1] = dict(pred[1], text="Body txt here.")
    imperfect = score_against_gt(pred, gt)
    assert imperfect["text_edit"] > 0.0
    assert imperfect["overall"] < 100.0


def test_gt_scoring_missing_modalities_are_none():
    from benchmark.gt_scoring import score_against_gt
    gt = [{"type": "text", "text": "only text", "page_idx": 0}]
    pred = [{"type": "text", "text": "only text", "page_idx": 0}]
    s = score_against_gt(pred, gt)
    assert s["table_teds"] is None   # no tables → not scored as 0
    assert s["formula_edit"] is None
    assert s["overall"] is not None  # text-only still has an overall


if __name__ == "__main__":
    # Run without pytest: discover and execute all test_* functions.
    import sys
    import traceback

    tests = {name: fn for name, fn in sorted(globals().items())
             if name.startswith("test_") and callable(fn)}
    passed = failed = 0
    for name, fn in tests.items():
        try:
            fn()
            passed += 1
        except Exception:
            failed += 1
            print(f"FAIL: {name}")
            traceback.print_exc()
    print(f"\n{passed} passed, {failed} failed (of {len(tests)})")
    sys.exit(1 if failed else 0)
