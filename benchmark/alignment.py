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
    latex_ned,
    normalize_text,
    rank_correlation,
    teds,
    teds_struct,
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


def _is_latex(item: Dict) -> bool:
    return item_type(item) == "equation" or item.get("text_format") == "latex"


def _text_distance(a: Dict, b: Dict) -> float:
    """Normalized distance in [0,1] between two same-type items' content.

    Uses LaTeX-aware token edit distance for equations, char NED for text,
    and (1 - TEDS) for tables, so the matching cost reflects real content
    similarity rather than raw-string noise.
    """
    ta, tb = item_type(a), item_type(b)
    if ta == "table" and tb == "table":
        return 1.0 - teds(item_text(a), item_text(b))
    if _is_latex(a) and _is_latex(b):
        return latex_ned(item_text(a), item_text(b))
    return ned(normalize_text(item_text(a)), normalize_text(item_text(b)))


def _alignment_cost(a: Dict, b: Dict) -> float:
    """Cheap matching cost used inside DP alignment.

    Final reported metrics are still computed exactly after alignment. This
    shortcut only avoids O(N*M) edit-distance calls on many long paragraph pairs
    while choosing candidate matches.
    """
    ta, tb = item_type(a), item_type(b)
    if ta == "text" and tb == "text":
        sa, sb = normalize_text(item_text(a)), normalize_text(item_text(b))
        max_len = max(len(sa), len(sb))
        if max_len > 320:
            def sketch(s: str) -> str:
                return s[:160] + "\n" + s[-160:]
            prefix_cost = ned(sketch(sa), sketch(sb))
            length_cost = abs(len(sa) - len(sb)) / max_len if max_len else 0.0
            return min(1.0, 0.8 * prefix_cost + 0.2 * length_cost)
    return _text_distance(a, b)


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
                # Content-aware substitution cost in [0,1]: text/equation use
                # (LaTeX-aware) NED, tables use 1-TEDS, other same-type items 0.
                if item_type(ta) in COMPARABLE_TYPES or item_type(ta) == "table":
                    sub = _alignment_cost(ta, tb)
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


def _reading_order_correlation(
    pages_a: Dict[int, List[Tuple[int, Dict]]],
    pages_b: Dict[int, List[Tuple[int, Dict]]],
) -> Dict[str, Any]:
    """Order-INDEPENDENT reading-order correlation.

    The main page DP alignment is monotonic by construction, so correlating its
    matched indices is tautological (always ~1.0). Here we instead match items
    across systems WITHOUT any positional constraint — greedily by content
    similarity (and bbox IoU as tie-break) within a page — then measure how the
    two systems ORDER those same items. Only if the systems disagree on reading
    order will tau/rho drop below 1, so the metric is now meaningful.

    Returns kendall_tau, spearman_rho, and the number of items compared.
    """
    order_a: List[int] = []
    order_b: List[int] = []
    all_pages = sorted(set(pages_a) | set(pages_b))

    for p in all_pages:
        pa = pages_a.get(p, [])
        pb = pages_b.get(p, [])
        # positions within the page = encounter rank in each system
        used_b = set()
        candidates: List[Tuple[int, int]] = []  # (rank_a, rank_b)
        for rank_a, (_, a) in enumerate(pa):
            best_j = -1
            best_cost = float("inf")
            for rank_b, (_, b) in enumerate(pb):
                if rank_b in used_b:
                    continue
                if item_type(a) != item_type(b):
                    continue
                # content distance, with bbox IoU as a tie-breaker
                if item_type(a) in COMPARABLE_TYPES or item_type(a) == "table":
                    cost = _alignment_cost(a, b)
                else:
                    iou = bbox_iou(a.get("bbox"), b.get("bbox"))
                    cost = 1.0 - (iou if iou is not None else 0.0)
                if cost < best_cost:
                    best_cost = cost
                    best_j = rank_b
            # only accept reasonably confident matches
            if best_j >= 0 and best_cost <= 0.6:
                used_b.add(best_j)
                candidates.append((rank_a, best_j))
        # the matched pairs' ranks form the two order sequences for this page
        for ra, rb in candidates:
            order_a.append(ra)
            order_b.append(rb)

    corr = rank_correlation(order_a, order_b)
    corr["n_order_items"] = len(order_a)
    return corr


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
    latex_ned_vals: List[float] = []
    teds_vals: List[float] = []
    teds_struct_vals: List[float] = []
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
            # equations: also track LaTeX-aware (tokenized) NED so cosmetic
            # markup differences do not inflate the formula divergence.
            if _is_latex(a) and _is_latex(b):
                lned = latex_ned(sa, sb)
                latex_ned_vals.append(lned)
                rec["latex_ned"] = round(lned, 4)
        elif ta == "table" and tb == "table":
            score = teds(item_text(a), item_text(b))
            sstruct = teds_struct(item_text(a), item_text(b))
            teds_vals.append(score)
            teds_struct_vals.append(sstruct)
            rec.update({
                "teds": round(score, 4),
                "teds_struct": round(sstruct, 4),
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

    # ---- reading-order correlation (ORDER-INDEPENDENT) ---------------------
    # The page DP alignment is monotonic, so correlating its matched indices is
    # tautological. Instead, match items across systems by content (ignoring
    # position) and compare the orders they were emitted in. tau/rho now only
    # drop when the systems genuinely disagree on reading order.
    corr = _reading_order_correlation(pages_a, pages_b)

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
        "mean_latex_ned": _avg(latex_ned_vals),
        "n_formula_pairs": len(latex_ned_vals),
        "mean_teds": _avg(teds_vals),
        "mean_teds_struct": _avg(teds_struct_vals),
        "n_table_pairs": len(teds_vals),
        "mean_bbox_iou": _avg(iou_vals),
        "n_bbox_pairs": len(iou_vals),
        "reading_order_kendall_tau": corr.get("kendall_tau"),
        "reading_order_spearman_rho": corr.get("spearman_rho"),
        "n_reading_order_items": corr.get("n_order_items", 0),
        "diff_items": diff_items,
    }


__all__ = [
    "align_content_lists", "extract_type_sequence", "COMPARABLE_TYPES",
]
