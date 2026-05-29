"""
benchmark/metrics.py
====================
Pure metric primitives for the skripsi benchmark, kept separate from I/O and
Excel formatting so they can be unit-tested and reused.

Covers:
  - Sequence edit distance + NED
  - String normalization (Unicode NFC + whitespace collapse)
  - CER / WER (character / word error rate against a reference)
  - Tree-Edit-Distance Similarity (TEDS) for HTML tables (Zhang-Shasha)
  - Bounding-box IoU
  - Geometric mean
  - Wilcoxon signed-rank wrapper + rank-biserial effect size
"""

from __future__ import annotations

import html as _html
import math
import re
import unicodedata
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Sequence, Tuple


# ---------------------------------------------------------------------------
# Sequence edit distance (Levenshtein) over arbitrary tokens
# ---------------------------------------------------------------------------

def edit_distance(a: Sequence, b: Sequence) -> int:
    m, n = len(a), len(b)
    if m == 0:
        return n
    if n == 0:
        return m
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        curr = [i] + [0] * n
        ai = a[i - 1]
        for j in range(1, n + 1):
            cost = 0 if ai == b[j - 1] else 1
            curr[j] = min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
        prev = curr
    return prev[n]


def ned(s_a: Sequence, s_b: Sequence) -> float:
    """Normalized edit distance in [0, 1]. 0 == identical."""
    denom = max(len(s_a), len(s_b))
    if denom == 0:
        return 0.0
    return edit_distance(s_a, s_b) / denom


# ---------------------------------------------------------------------------
# String normalization
# ---------------------------------------------------------------------------

_WS_RE = re.compile(r"\s+")


def normalize_text(s: Optional[str], form: str = "NFC") -> str:
    """Unicode-normalize and collapse whitespace.

    Used so that cosmetic differences (full/half width, line breaks, repeated
    spaces) do not inflate edit distance without a real semantic difference.
    """
    if not s:
        return ""
    s = unicodedata.normalize(form, s)
    s = _WS_RE.sub(" ", s)
    return s.strip()


# ---------------------------------------------------------------------------
# CER / WER  (reference = system B / Python by convention)
# ---------------------------------------------------------------------------

def cer(reference: str, hypothesis: str) -> float:
    """Character Error Rate = edit_distance(ref, hyp) / len(ref).

    Falls back to length of hypothesis when reference is empty.
    """
    ref = reference or ""
    hyp = hypothesis or ""
    denom = len(ref) if len(ref) > 0 else len(hyp)
    if denom == 0:
        return 0.0
    return edit_distance(ref, hyp) / denom


def wer(reference: str, hypothesis: str) -> float:
    """Word Error Rate over whitespace-split tokens."""
    ref = (reference or "").split()
    hyp = (hypothesis or "").split()
    denom = len(ref) if len(ref) > 0 else len(hyp)
    if denom == 0:
        return 0.0
    return edit_distance(ref, hyp) / denom


# ---------------------------------------------------------------------------
# Bounding-box IoU
# ---------------------------------------------------------------------------

def bbox_iou(a: Optional[Sequence[float]], b: Optional[Sequence[float]]) -> Optional[float]:
    """Intersection-over-Union for two [x0, y0, x1, y1] boxes.

    Returns None if either box is missing or malformed.
    """
    if not a or not b or len(a) < 4 or len(b) < 4:
        return None
    ax0, ay0, ax1, ay1 = a[0], a[1], a[2], a[3]
    bx0, by0, bx1, by1 = b[0], b[1], b[2], b[3]
    # Normalize ordering
    ax0, ax1 = min(ax0, ax1), max(ax0, ax1)
    ay0, ay1 = min(ay0, ay1), max(ay0, ay1)
    bx0, bx1 = min(bx0, bx1), max(bx0, bx1)
    by0, by1 = min(by0, by1), max(by0, by1)

    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    iw, ih = max(0.0, ix1 - ix0), max(0.0, iy1 - iy0)
    inter = iw * ih
    area_a = max(0.0, ax1 - ax0) * max(0.0, ay1 - ay0)
    area_b = max(0.0, bx1 - bx0) * max(0.0, by1 - by0)
    union = area_a + area_b - inter
    if union <= 0:
        return 0.0
    return inter / union


# ---------------------------------------------------------------------------
# TEDS — Tree Edit Distance Similarity for HTML tables
# ---------------------------------------------------------------------------

class _Node:
    __slots__ = ("tag", "text", "children")

    def __init__(self, tag: str, text: str = "") -> None:
        self.tag = tag
        self.text = text
        self.children: List["_Node"] = []


class _TableTreeBuilder(HTMLParser):
    """Builds a simplified DOM tree from table HTML.

    Only structural tags relevant to tables are kept; cell text is normalized
    and attached to the nearest open cell node.
    """

    STRUCTURAL = {"table", "thead", "tbody", "tr", "td", "th"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = _Node("root")
        self.stack: List[_Node] = [self.root]

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in self.STRUCTURAL:
            node = _Node(tag)
            self.stack[-1].children.append(node)
            self.stack.append(node)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in self.STRUCTURAL:
            # Pop until matching tag (tolerant of malformed HTML)
            for i in range(len(self.stack) - 1, 0, -1):
                if self.stack[i].tag == tag:
                    del self.stack[i:]
                    break

    def handle_data(self, data):
        text = normalize_text(data)
        if text:
            self.stack[-1].text = (self.stack[-1].text + " " + text).strip()


def _build_table_tree(html_str: str) -> _Node:
    parser = _TableTreeBuilder()
    try:
        parser.feed(html_str or "")
    except Exception:
        pass
    return parser.root


def _tree_size(node: _Node) -> int:
    return 1 + sum(_tree_size(c) for c in node.children)


def _postorder(node: _Node) -> List[_Node]:
    out: List[_Node] = []

    def walk(n: _Node):
        for c in n.children:
            walk(c)
        out.append(n)

    walk(node)
    return out


def _node_cost(a: Optional[_Node], b: Optional[_Node]) -> float:
    """Relabel/insert/delete cost. Tag mismatch = 1. For matching cell tags,
    add normalized text edit distance (in [0,1]) so content differences count."""
    if a is None or b is None:
        return 1.0
    if a.tag != b.tag:
        return 1.0
    if a.tag in ("td", "th") and (a.text or b.text):
        return ned(a.text, b.text)
    return 0.0


def _zhang_shasha(t1: _Node, t2: _Node) -> float:
    """Zhang-Shasha tree edit distance between two ordered labeled trees."""
    n1 = _postorder(t1)
    n2 = _postorder(t2)
    idx1 = {id(n): i for i, n in enumerate(n1)}
    idx2 = {id(n): i for i, n in enumerate(n2)}

    def leftmost(node: _Node) -> _Node:
        cur = node
        while cur.children:
            cur = cur.children[0]
        return cur

    l1 = [idx1[id(leftmost(n))] for n in n1]
    l2 = [idx2[id(leftmost(n))] for n in n2]

    def keyroots(l):
        seen = {}
        for i in range(len(l) - 1, -1, -1):
            if l[i] not in seen:
                seen[l[i]] = i
        return sorted(seen.values())

    kr1 = keyroots(l1)
    kr2 = keyroots(l2)

    INF = float("inf")
    treedist = [[0.0] * len(n2) for _ in range(len(n1))]

    def treedist_calc(i, j):
        m = i - l1[i] + 2
        n = j - l2[j] + 2
        fd = [[0.0] * n for _ in range(m)]
        ioff = l1[i]
        joff = l2[j]
        for x in range(1, m):
            fd[x][0] = fd[x - 1][0] + _node_cost(n1[ioff + x - 1], None)
        for y in range(1, n):
            fd[0][y] = fd[0][y - 1] + _node_cost(None, n2[joff + y - 1])
        for x in range(1, m):
            for y in range(1, n):
                na = n1[ioff + x - 1]
                nb = n2[joff + y - 1]
                if l1[ioff + x - 1] == l1[i] and l2[joff + y - 1] == l2[j]:
                    cost = fd[x - 1][y - 1] + _node_cost(na, nb)
                    fd[x][y] = min(
                        fd[x - 1][y] + _node_cost(na, None),
                        fd[x][y - 1] + _node_cost(None, nb),
                        cost,
                    )
                    treedist[ioff + x - 1][joff + y - 1] = fd[x][y]
                else:
                    p = l1[ioff + x - 1] - 1 - ioff + 1
                    q = l2[joff + y - 1] - 1 - joff + 1
                    fd[x][y] = min(
                        fd[x - 1][y] + _node_cost(na, None),
                        fd[x][y - 1] + _node_cost(None, nb),
                        fd[p][q] + treedist[ioff + x - 1][joff + y - 1],
                    )

    for i in kr1:
        for j in kr2:
            treedist_calc(i, j)

    return treedist[len(n1) - 1][len(n2) - 1]


def teds(html_a: str, html_b: str) -> float:
    """Tree-Edit-Distance Similarity in [0, 1]. 1.0 == identical structure+text.

    TEDS = 1 - EditDist(Ta, Tb) / max(|Ta|, |Tb|)
    """
    ta = _build_table_tree(html_a)
    tb = _build_table_tree(html_b)
    size_a = _tree_size(ta)
    size_b = _tree_size(tb)
    denom = max(size_a, size_b)
    if denom <= 1:  # only the synthetic root
        return 1.0 if (html_a or "") == (html_b or "") else 0.0
    dist = _zhang_shasha(ta, tb)
    sim = 1.0 - dist / denom
    return max(0.0, min(1.0, sim))


# ---------------------------------------------------------------------------
# Aggregate / statistical helpers
# ---------------------------------------------------------------------------

def geometric_mean(vals: Sequence[float]) -> float:
    """Geometric mean of positive values. Ignores non-positive entries."""
    pos = [v for v in vals if v is not None and v > 0]
    if not pos:
        return 0.0
    log_sum = sum(math.log(v) for v in pos)
    return math.exp(log_sum / len(pos))


def wilcoxon_signed_rank(a: Sequence[float], b: Sequence[float]) -> Dict[str, Any]:
    """Paired Wilcoxon signed-rank test (a vs b).

    Returns statistic, p-value, n_pairs, and rank-biserial effect size.
    Uses scipy when available; degrades gracefully when not.
    """
    pairs = [(x, y) for x, y in zip(a, b)
             if x is not None and y is not None]
    n = len(pairs)
    result: Dict[str, Any] = {
        "n_pairs": n,
        "statistic": None,
        "p_value": None,
        "effect_size_r": None,
        "median_diff": None,
        "note": "",
    }
    if n < 1:
        result["note"] = "no paired samples"
        return result

    diffs = [x - y for x, y in pairs]
    import statistics as _st
    result["median_diff"] = round(_st.median(diffs), 6)

    nonzero = [d for d in diffs if d != 0]
    if len(nonzero) < 1:
        result["note"] = "all differences are zero"
        result["p_value"] = 1.0
        result["effect_size_r"] = 0.0
        return result

    try:
        from scipy import stats  # type: ignore
        stat, p = stats.wilcoxon([x for x, _ in pairs], [y for _, y in pairs])
        result["statistic"] = round(float(stat), 6)
        result["p_value"] = round(float(p), 6)
        # rank-biserial effect size from signed ranks
        import numpy as np  # type: ignore
        d = np.array(nonzero, dtype=float)
        ranks = stats.rankdata(np.abs(d))
        r_plus = float(np.sum(ranks[d > 0]))
        r_minus = float(np.sum(ranks[d < 0]))
        total = r_plus + r_minus
        result["effect_size_r"] = round((r_plus - r_minus) / total, 6) if total else 0.0
    except Exception as exc:  # pragma: no cover
        result["note"] = f"scipy unavailable ({exc})"
    return result


def rank_correlation(seq_a: Sequence[int], seq_b: Sequence[int]) -> Dict[str, Any]:
    """Kendall's tau and Spearman's rho between two paired index sequences."""
    out: Dict[str, Any] = {"kendall_tau": None, "spearman_rho": None, "n": len(seq_a)}
    if len(seq_a) < 2 or len(seq_a) != len(seq_b):
        return out
    try:
        from scipy import stats  # type: ignore
        tau, _ = stats.kendalltau(seq_a, seq_b)
        rho, _ = stats.spearmanr(seq_a, seq_b)
        out["kendall_tau"] = None if tau is None or math.isnan(tau) else round(float(tau), 4)
        out["spearman_rho"] = None if rho is None or math.isnan(rho) else round(float(rho), 4)
    except Exception:
        pass
    return out


__all__ = [
    "edit_distance", "ned", "normalize_text", "cer", "wer", "bbox_iou",
    "teds", "geometric_mean", "wilcoxon_signed_rank", "rank_correlation",
]
