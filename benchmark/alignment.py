"""
benchmark/alignment.py
======================
Content-list alignment and output-equivalence metrics.

Improves on the old by-type global alignment:
  - Aligns per page (uses page_idx) instead of one global sequence.
  - Content-aware matching: among same-type candidates, prefer the pairing that
    minimizes normalized edit distance (so two "text" blocks are not matched
    just because they sit at the same position).
  - Reports coverage (precision / recall / F1) so dropped or extra items are
    captured explicitly, not hidden.
  - Computes bbox IoU for matched items and reading-order rank correlation.
  - Emits a per-item diff record for auditing (the "string dump").

Convention: system A == JS (hypothesis), system B == Python (reference baseline).
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from .metrics import (
    bbox_iou,
    cer,
    ned,
    normalize_text,
    rank_correlation,
    teds,
    wer,
)

COMPARABLE_TYPES = {"text", "equation"}


def item_type(item: Dict) -> str:
    return item.get("type", "unknown")


def item_text(item: Dict) -> str:
    t = item.get("type", "")
    if t == "table":
        return item.get("table_body") or item.get("html") or ""
    return item.get("text") or item.get("content") or ""


def extract_type_sequence(content_list: List[Dict]) -> List[str]:
    return [item_type(it) for it in content_list if item_type(it) != "discarded"]


def _page_of(item: Dict) -> int:
    pid = item.get("page_idx")
    return int(pid) if isinstance(pid, (int, float)) else 0


def _group_by_page(content_list: List[Dict]) -> Dict[int, List[Tuple[int, Dict]]]:
    groups: Dict[int, List[Tuple[int, Dict]]] = {}
    for gi, item in enumerate(content_list):
        if item_type(item) == "discarded":
            continue
        groups.setdefault(_page_of(item), []).append((gi, item))
    return groups


def _align_one_page(
    items_a: List[Tuple[int, Dict]],
    items_b: List[Tuple[int, Dict]],
) -> Tuple[List[Tuple[int, int]], List[int], List[int]]:
    """Type-constrained, content-aware DP alignment within a single page.

    Returns (matched_pairs, unmatched_a_global_idx, unmatched_b_global_idx)
    where matched_pairs holds (global_idx_a, global_idx_b).

    Substitution is only allowed between same-type items; its cost is the
    normalized edit distance of their text (0..1) for comparable types, else 0.
    Cross-type pairing is forbidden (cost > 1 so insert+delete is cheaper).
    """
    m, n = len(items_a), len(items_b)
    INF = float("inf")
    dp = [[0.0] * (n + 1) for _ in range(m + 1)]
    bt = [[0] * (n + 1) for _ in range(m + 1)]  # 0=diag,1=up(del A),2=left(del B)

    for i in range(1, m + 1):
        dp[i][0] = i
        bt[i][0] = 1
    for j in range(1, n + 1):
        dp[0][j] = j
        bt[0][j] = 2

    for i in range(1, m + 1):
        ta = items_a[i - 1][1]
        for j in range(1, n + 1):
            tb = items_b[j - 1][1]
            if item_type(ta) == item_type(tb):
                if item_type(ta) in COMPARABLE_TYPES:
                    sub = ned(normalize_text(item_text(ta)), normalize_text(item_text(tb)))
                else:
                    sub = 0.0
            else:
                sub = INF  # forbid cross-type substitution
            diag = dp[i - 1][j - 1] + sub
            up = dp[i - 1][j] + 1.0   # delete from A (extra in A)
            left = dp[i][j - 1] + 1.0  # delete from B (missing in A)
            best = min(diag, up, left)
            dp[i][j] = best
            bt[i][j] = 0 if best == diag else (1 if best == up else 2)

    pairs: List[Tuple[int, int]] = []
    only_a: List[int] = []
    only_b: List[int] = []
    i, j = m, n
    while i > 0 or j > 0:
        move = bt[i][j]
        if i > 0 and j > 0 and move == 0:
            pairs.append((items_a[i - 1][0], items_b[j - 1][0]))
            i -= 1
            j -= 1
        elif i > 0 and (j == 0 or move == 1):
            only_a.append(items_a[i - 1][0])
            i -= 1
        else:
            only_b.append(items_b[j - 1][0])
            j -= 1

    pairs.reverse()
    only_a.reverse()
    only_b.reverse()
    return pairs, only_a, only_b


def align_content_lists(cl_a: List[Dict], cl_b: List[Dict]) -> Dict[str, Any]:
    """Align two content lists page-by-page and compute equivalence metrics.

    Returns a dict with summary metrics plus a per-item diff list.
    """
    pages_a = _group_by_page(cl_a)
    pages_b = _group_by_page(cl_b)
    all_pages = sorted(set(pages_a) | set(pages_b))

    matched: List[Tuple[int, int]] = []
    only_a_all: List[int] = []
    only_b_all: List[int] = []

    for p in all_pages:
        pa = pages_a.get(p, [])
        pb = pages_b.get(p, [])
        pairs, oa, ob = _align_one_page(pa, pb)
        matched.extend(pairs)
        only_a_all.extend(oa)
        only_b_all.extend(ob)

    # ---- text/equation NED (raw + normalized) ------------------------------
    ned_raw: List[float] = []
    ned_norm: List[float] = []
    cer_vals: List[float] = []
    wer_vals: List[float] = []
    teds_vals: List[float] = []
    iou_vals: List[float] = []
    type_matched = 0

    diff_items: List[Dict[str, Any]] = []

    for ia, ib in matched:
        a, b = cl_a[ia], cl_b[ib]
        ta, tb = item_type(a), item_type(b)
        if ta == tb:
            type_matched += 1
        rec: Dict[str, Any] = {
            "status": "matched",
            "type_a": ta,
            "type_b": tb,
            "page_a": _page_of(a),
            "page_b": _page_of(b),
        }
        # bbox IoU
        iou = bbox_iou(a.get("bbox"), b.get("bbox"))
        if iou is not None:
            iou_vals.append(iou)
            rec["bbox_iou"] = round(iou, 4)

        if ta in COMPARABLE_TYPES and tb in COMPARABLE_TYPES:
            sa, sb = item_text(a), item_text(b)
            na, nb = normalize_text(sa), normalize_text(sb)
            r = ned(sa, sb)
            nn = ned(na, nb)
            ned_raw.append(r)
            ned_norm.append(nn)
            # CER/WER: reference = Python (B)
            cer_vals.append(cer(nb, na))
            wer_vals.append(wer(nb, na))
            rec.update({
                "ned_raw": round(r, 4),
                "ned_norm": round(nn, 4),
                "cer": round(cer(nb, na), 4),
                "wer": round(wer(nb, na), 4),
                "text_a": sa,
                "text_b": sb,
            })
        elif ta == "table" and tb == "table":
            score = teds(item_text(a), item_text(b))
            teds_vals.append(score)
            rec.update({
                "teds": round(score, 4),
                "text_a": item_text(a),
                "text_b": item_text(b),
            })
        diff_items.append(rec)

    for ia in only_a_all:
        a = cl_a[ia]
        diff_items.append({
            "status": "only_in_js",
            "type_a": item_type(a),
            "type_b": None,
            "page_a": _page_of(a),
            "text_a": item_text(a),
        })
    for ib in only_b_all:
        b = cl_b[ib]
        diff_items.append({
            "status": "only_in_python",
            "type_a": None,
            "type_b": item_type(b),
            "page_b": _page_of(b),
            "text_b": item_text(b),
        })

    # ---- coverage: precision/recall/F1 over item count ----------------------
    n_match = len(matched)
    n_a = n_match + len(only_a_all)
    n_b = n_match + len(only_b_all)
    precision = n_match / n_a if n_a else 0.0
    recall = n_match / n_b if n_b else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    type_consistency = type_matched / n_match if n_match else 0.0

    # ---- reading-order correlation -----------------------------------------
    # Use matched pairs' global positions in each system.
    order_a = [ia for ia, _ in matched]
    order_b = [ib for _, ib in matched]
    # Rank within each system (positions are already ascending per the alignment)
    corr = rank_correlation(order_a, order_b)

    def _avg(v: List[float]) -> Optional[float]:
        # Return None (not 0.0) when there is nothing to average, so that
        # "no tables / no text pairs" is not scored as "completely wrong"
        # and is excluded from downstream aggregates.
        return round(sum(v) / len(v), 4) if v else None

    return {
        "n_matched": n_match,
        "n_only_js": len(only_a_all),
        "n_only_python": len(only_b_all),
        "coverage_precision": round(precision, 4),
        "coverage_recall": round(recall, 4),
        "coverage_f1": round(f1, 4),
        "type_consistency": round(type_consistency, 4),
        "mean_ned_raw": _avg(ned_raw),
        "mean_ned_norm": _avg(ned_norm),
        "n_text_pairs": len(ned_norm),
        "mean_cer": _avg(cer_vals),
        "mean_wer": _avg(wer_vals),
        "mean_teds": _avg(teds_vals),
        "n_table_pairs": len(teds_vals),
        "mean_bbox_iou": _avg(iou_vals),
        "n_bbox_pairs": len(iou_vals),
        "reading_order_kendall_tau": corr.get("kendall_tau"),
        "reading_order_spearman_rho": corr.get("spearman_rho"),
        "diff_items": diff_items,
    }


__all__ = ["align_content_lists", "extract_type_sequence", "COMPARABLE_TYPES"]
