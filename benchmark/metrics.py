"""
benchmark/metrics.py
====================
Pure metric primitives for the comparative benchmark, kept separate from I/O and
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
# LaTeX normalization (formula construct validity)
# ---------------------------------------------------------------------------
#
# Raw-string NED on LaTeX is sensitive to non-semantic differences (\dfrac vs
# \frac, spacing macros, redundant braces, \left/\right). We normalize and
# tokenize before measuring edit distance so the formula metric reflects
# content rather than cosmetic markup. This remains a PROXY for the official
# OmniDocBench CDM metric (documented deviation), not CDM itself.

# Spacing / sizing macros that carry no semantic content.
_LATEX_DROP = [
    r"\left", r"\right", r"\bigl", r"\bigr", r"\Bigl", r"\Bigr",
    r"\big", r"\Big", r"\bigg", r"\Bigg", r"\,", r"\;", r"\:", r"\!",
    r"\quad", r"\qquad", r"\displaystyle", r"\textstyle", r"\scriptstyle",
    r"\limits", r"\nolimits", r"\mathrm", r"\mathbf", r"\boldsymbol",
]
# Synonymous commands collapsed to a canonical form.
_LATEX_CANON = {
    r"\dfrac": r"\frac", r"\tfrac": r"\frac", r"\cfrac": r"\frac",
    r"\rightarrow": r"\to", r"\longrightarrow": r"\to",
    r"\ge": r"\geq", r"\le": r"\leq", r"\ne": r"\neq",
    r"\cdot": r"*", r"\times": r"*", r"\ast": r"*",
}
_LATEX_TOKEN_RE = re.compile(r"\\[a-zA-Z]+|\\.|[{}]|[a-zA-Z0-9]|[^\s]")


def normalize_latex(s: Optional[str]) -> str:
    """Canonicalize a LaTeX string for semantic-ish comparison.

    Strips math-mode delimiters, drops spacing/sizing macros, collapses
    synonymous commands, and removes whitespace. Substitutions operate on whole
    command TOKENS (not raw substrings) so prefixes like ``\\le`` do not corrupt
    longer commands like ``\\left``. Returns the canonical string.
    """
    if not s:
        return ""
    out = unicodedata.normalize("NFC", s).strip()
    # strip surrounding math delimiters
    for delim in ("$$", "$", r"\(", r"\)", r"\[", r"\]"):
        out = out.replace(delim, "")

    drop = set(_LATEX_DROP)
    canon = dict(_LATEX_CANON)
    pieces: List[str] = []
    # Walk the string, treating \command as an atomic token.
    i = 0
    n = len(out)
    cmd_re = re.compile(r"\\[a-zA-Z]+")
    while i < n:
        ch = out[i]
        if ch == "\\":
            m = cmd_re.match(out, i)
            if m:
                tok = m.group(0)
                if tok in drop:
                    pass  # cosmetic macro, drop it
                elif tok in canon:
                    pieces.append(canon[tok])
                else:
                    pieces.append(tok)
                i = m.end()
                continue
            # escaped non-letter (e.g. \{ \} \,)
            two = out[i:i + 2]
            if two not in drop:   # drop cosmetic \, \; \: \!
                pieces.append(two)
            i += 2
            continue
        pieces.append(ch)
        i += 1

    joined = "".join(pieces)
    # remove all whitespace (LaTeX is whitespace-insensitive in math mode)
    return re.sub(r"\s+", "", joined)


def latex_tokens(s: Optional[str]) -> List[str]:
    """Tokenize LaTeX into commands, braces, and single symbols after
    normalization, so edit distance counts semantic units not characters."""
    norm = normalize_latex(s)
    if not norm:
        return []
    return _LATEX_TOKEN_RE.findall(norm)


def latex_ned(a: Optional[str], b: Optional[str]) -> float:
    """Normalized token-level edit distance between two LaTeX strings in [0,1]."""
    ta, tb = latex_tokens(a), latex_tokens(b)
    return ned(ta, tb)


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


def _strip_text(node: "_Node") -> None:
    """Recursively blank out cell text so only structure remains."""
    node.text = ""
    for c in node.children:
        _strip_text(c)


def teds_struct(html_a: str, html_b: str) -> float:
    """Structure-only TEDS (TEDS-Struct): ignores cell text, compares the
    table tree shape (rows/cells/headers) alone. Reported alongside TEDS so the
    thesis can separate STRUCTURE parity from CONTENT parity."""
    ta = _build_table_tree(html_a)
    tb = _build_table_tree(html_b)
    _strip_text(ta)
    _strip_text(tb)
    size_a = _tree_size(ta)
    size_b = _tree_size(tb)
    denom = max(size_a, size_b)
    if denom <= 1:
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


def geometric_mean_ci(vals: Sequence[float], confidence: float = 0.95,
                      n_boot: int = 5000, seed: int = 42) -> Dict[str, Any]:
    """Bootstrap confidence interval for the geometric mean of ratios.

    Resamples the log-ratios with replacement (percentile bootstrap) so the
    headline ratio comes with an interval, not just a point estimate. Returns
    {gm, ci_low, ci_high, n}. Falls back to a log-normal analytic CI when the
    sample is tiny.
    """
    pos = [v for v in vals if v is not None and v > 0]
    n = len(pos)
    out: Dict[str, Any] = {"gm": None, "ci_low": None, "ci_high": None, "n": n}
    if n == 0:
        return out
    gm = geometric_mean(pos)
    out["gm"] = round(gm, 4)
    if n == 1:
        out["ci_low"] = out["ci_high"] = round(gm, 4)
        return out

    logs = [math.log(v) for v in pos]
    import random as _random
    rng = _random.Random(seed)
    alpha = 1.0 - confidence
    try:
        boots: List[float] = []
        for _ in range(n_boot):
            sample = [logs[rng.randrange(n)] for _ in range(n)]
            boots.append(math.exp(sum(sample) / n))
        boots.sort()
        lo_idx = max(0, int(math.floor((alpha / 2.0) * len(boots))))
        hi_idx = min(len(boots) - 1, int(math.ceil((1.0 - alpha / 2.0) * len(boots)) - 1))
        out["ci_low"] = round(boots[lo_idx], 4)
        out["ci_high"] = round(boots[hi_idx], 4)
    except Exception:
        # analytic log-normal fallback
        import statistics as _st
        mean_log = _st.mean(logs)
        sd_log = _st.stdev(logs)
        z = Z.get(confidence, 1.96)
        half = z * sd_log / math.sqrt(n)
        out["ci_low"] = round(math.exp(mean_log - half), 4)
        out["ci_high"] = round(math.exp(mean_log + half), 4)
    return out


def paired_diff_ci(a: Sequence[float], b: Sequence[float],
                   confidence: float = 0.95, n_boot: int = 5000,
                   seed: int = 42) -> Dict[str, Any]:
    """Bootstrap CI for the mean PAIRED difference (a - b).

    Used for accuracy metrics (e.g. GT Overall) where the quantity of interest
    is an additive difference between two systems on the SAME documents, not a
    ratio. Resamples the paired differences with replacement (percentile
    bootstrap). Returns {mean_diff, ci_low, ci_high, n, excludes_zero}.

    `excludes_zero` is True when the 95% CI does not contain 0, i.e. the
    difference is significant at the corresponding level — a CI-based companion
    to the Wilcoxon p-value that also conveys effect magnitude and direction.
    """
    pairs = [(x, y) for x, y in zip(a, b)
             if isinstance(x, (int, float)) and isinstance(y, (int, float))]
    n = len(pairs)
    out: Dict[str, Any] = {
        "mean_diff": None, "ci_low": None, "ci_high": None,
        "n": n, "excludes_zero": None,
    }
    if n == 0:
        return out
    diffs = [x - y for x, y in pairs]
    mean_diff = sum(diffs) / n
    out["mean_diff"] = round(mean_diff, 4)
    if n == 1:
        out["ci_low"] = out["ci_high"] = round(mean_diff, 4)
        out["excludes_zero"] = False  # cannot establish significance with n=1
        return out

    import random as _random
    rng = _random.Random(seed)
    alpha = 1.0 - confidence
    boots: List[float] = []
    for _ in range(n_boot):
        sample = [diffs[rng.randrange(n)] for _ in range(n)]
        boots.append(sum(sample) / n)
    boots.sort()
    lo_idx = max(0, int(math.floor((alpha / 2.0) * len(boots))))
    hi_idx = min(len(boots) - 1, int(math.ceil((1.0 - alpha / 2.0) * len(boots)) - 1))
    lo = boots[lo_idx]
    hi = boots[hi_idx]
    out["ci_low"] = round(lo, 4)
    out["ci_high"] = round(hi, 4)
    out["excludes_zero"] = bool(lo > 0 or hi < 0)
    return out


def holm_bonferroni(pvals: Sequence[Optional[float]], alpha: float = 0.05) -> List[Dict[str, Any]]:
    """Holm-Bonferroni step-down correction for a family of p-values.

    Controls family-wise error rate across the multiple Wilcoxon tests run in
    one report. Returns, in the ORIGINAL order, per-test dicts with the
    adjusted threshold and a reject (significant) flag. None p-values pass
    through untouched.
    """
    indexed = [(i, p) for i, p in enumerate(pvals) if p is not None]
    m = len(indexed)
    results: List[Dict[str, Any]] = [
        {"p_value": p, "adjusted_alpha": None, "significant": None}
        for p in pvals
    ]
    if m == 0:
        return results
    indexed.sort(key=lambda t: t[1])
    still_rejecting = True
    for rank, (orig_i, p) in enumerate(indexed):
        adj_alpha = alpha / (m - rank)
        reject = still_rejecting and (p < adj_alpha)
        if not reject:
            still_rejecting = False  # once we fail, all larger p's fail too
        results[orig_i]["adjusted_alpha"] = round(adj_alpha, 6)
        results[orig_i]["significant"] = bool(reject)
    return results


# Z-scores for confidence levels (shared with sample_size semantics).
Z = {0.90: 1.645, 0.95: 1.96, 0.99: 2.576}


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
        import warnings as _warnings
        with _warnings.catch_warnings():
            _warnings.simplefilter("ignore")
            tau, _ = stats.kendalltau(seq_a, seq_b)
            rho, _ = stats.spearmanr(seq_a, seq_b)
        out["kendall_tau"] = None if tau is None or math.isnan(tau) else round(float(tau), 4)
        out["spearman_rho"] = None if rho is None or math.isnan(rho) else round(float(rho), 4)
    except Exception:
        pass
    return out


__all__ = [
    "edit_distance", "ned", "normalize_text", "cer", "wer", "bbox_iou",
    "normalize_latex", "latex_tokens", "latex_ned",
    "teds", "teds_struct", "geometric_mean", "geometric_mean_ci",
    "holm_bonferroni", "wilcoxon_signed_rank", "rank_correlation",
    "paired_diff_ci",
]
