"""
benchmark/sampler.py
====================
Stratified sampling for OmniDocBench so the benchmark is feasible on a single
machine without running all 1651 pages x N repeats x 2 systems.

Rationale (document this in the methodology chapter):
  - Accuracy is deterministic per system (verified by content_stability), so a
    stratified sample run ONCE per system is enough to estimate accuracy.
  - Timing varies run-to-run, so it needs repeats — but only on a small subset.
  - We therefore draw two corpora:
      * accuracy corpus  : larger stratified sample, 1 run/system
      * timing corpus    : small stratified SUBSET of the accuracy corpus,
                           run with repeats (e.g. 10) per system
  - Proportional allocation by stratum (document type x language) with a fixed
    random seed, a minimum per stratum so rare categories are never dropped,
    and largest-remainder rounding to hit the exact target size.

Input: the omnidocbench_index.json produced by `benchmark.omnidocbench`.
Output: a sample manifest (reproducible) + optionally copied image folders that
can be fed directly to demo_batch.py (Python) and benchmark.html (JS).

Usage:
  python -m benchmark.sampler \
      --index benchmark/omnidocbench_gt/omnidocbench_index.json \
      --images path/to/omnidocbench/images \
      --out-dir benchmark/sample \
      --accuracy-n 200 --timing-n 30 --min-per-stratum 3 --seed 42
"""

from __future__ import annotations

import argparse
import json
import math
import random
import shutil
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def _stratum_key(meta: Dict[str, Any], by: List[str]) -> str:
    parts = [str(meta.get(k) or "unknown") for k in by]
    return " | ".join(parts)


def _largest_remainder_alloc(
    sizes: Dict[str, int], target: int, min_per: int
) -> Dict[str, int]:
    """Allocate `target` samples across strata proportional to `sizes`,
    enforcing `min_per` per stratum (capped at the stratum size), using the
    largest-remainder method to hit the exact target where possible."""
    strata = list(sizes.keys())
    total = sum(sizes.values())
    if total == 0:
        return {s: 0 for s in strata}

    # Cap target at total available.
    target = min(target, total)

    # Step 1: minimum allocation (capped at availability).
    alloc = {s: min(min_per, sizes[s]) for s in strata}
    used = sum(alloc.values())

    if used >= target:
        # Minimums already meet/exceed target; trim from largest strata.
        over = used - target
        # Trim from strata with the most allocated above 0, largest first.
        order = sorted(strata, key=lambda s: alloc[s], reverse=True)
        i = 0
        while over > 0 and any(alloc[s] > 0 for s in strata):
            s = order[i % len(order)]
            if alloc[s] > 0:
                alloc[s] -= 1
                over -= 1
            i += 1
        return alloc

    # Step 2: distribute the remainder proportionally to leftover capacity.
    remaining = target - used
    leftover_cap = {s: sizes[s] - alloc[s] for s in strata}
    leftover_total = sum(leftover_cap.values())
    if leftover_total == 0:
        return alloc

    ideal = {s: remaining * leftover_cap[s] / leftover_total for s in strata}
    floor = {s: int(math.floor(ideal[s])) for s in strata}
    # Respect capacity.
    for s in strata:
        floor[s] = min(floor[s], leftover_cap[s])
    assigned = sum(floor.values())
    leftover = remaining - assigned

    # Distribute leftover by largest fractional remainder, respecting capacity.
    frac_order = sorted(
        strata, key=lambda s: (ideal[s] - math.floor(ideal[s])), reverse=True
    )
    i = 0
    guard = 0
    while leftover > 0 and guard < 10000:
        s = frac_order[i % len(frac_order)]
        if floor[s] < leftover_cap[s]:
            floor[s] += 1
            leftover -= 1
        i += 1
        guard += 1

    for s in strata:
        alloc[s] += floor[s]
    return alloc


def stratified_sample(
    index: Dict[str, Dict[str, Any]],
    target: int,
    by: List[str],
    seed: int,
    min_per_stratum: int,
    restrict_to: Optional[List[str]] = None,
) -> Tuple[List[str], Dict[str, int]]:
    """Return (selected_stems, per_stratum_counts)."""
    rng = random.Random(seed)
    pool = index if restrict_to is None else {k: index[k] for k in restrict_to if k in index}

    groups: Dict[str, List[str]] = defaultdict(list)
    for stem, meta in pool.items():
        groups[_stratum_key(meta, by)].append(stem)
    for s in groups:
        groups[s].sort()  # deterministic before shuffle

    sizes = {s: len(v) for s, v in groups.items()}
    alloc = _largest_remainder_alloc(sizes, target, min_per_stratum)

    selected: List[str] = []
    counts: Dict[str, int] = {}
    for s, stems in groups.items():
        k = min(alloc.get(s, 0), len(stems))
        chosen = rng.sample(stems, k) if k > 0 else []
        selected.extend(chosen)
        counts[s] = len(chosen)
    selected.sort()
    return selected, counts


def _copy_images(stems: List[str], index: Dict[str, Dict], images_dir: Path,
                 dest: Path) -> Tuple[int, List[str]]:
    dest.mkdir(parents=True, exist_ok=True)
    copied = 0
    missing: List[str] = []
    for stem in stems:
        img_name = index[stem].get("image_path") or ""
        src = images_dir / img_name if img_name else None
        if src is None or not src.exists():
            # try by stem with common extensions
            found = None
            for ext in (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"):
                cand = images_dir / f"{stem}{ext}"
                if cand.exists():
                    found = cand
                    break
            src = found
        if src is None or not src.exists():
            missing.append(stem)
            continue
        shutil.copy2(src, dest / src.name)
        copied += 1
    return copied, missing


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Stratified sampling of OmniDocBench for feasible benchmarking.")
    parser.add_argument("--index", required=True, type=Path,
                        help="omnidocbench_index.json from benchmark.omnidocbench")
    parser.add_argument("--images", type=Path, default=None,
                        help="OmniDocBench images dir (to copy sampled images)")
    parser.add_argument("--out-dir", type=Path, default=Path("benchmark/sample"))
    parser.add_argument("--accuracy-n", type=int, default=200,
                        help="Accuracy corpus size (1 run/system). Default 200.")
    parser.add_argument("--timing-n", type=int, default=30,
                        help="Timing corpus size (repeats/system), subset of accuracy. Default 30.")
    parser.add_argument("--by", type=str, default="data_source,language",
                        help="Stratify keys, comma-separated. Default: data_source,language")
    parser.add_argument("--min-per-stratum", type=int, default=3,
                        help="Minimum samples per stratum so rare types are kept. Default 3.")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--no-copy", action="store_true", default=False,
                        help="Only write the manifest, do not copy images.")
    args = parser.parse_args()

    if not args.index.exists():
        raise SystemExit(f"Index not found: {args.index}")
    index = json.loads(args.index.read_text(encoding="utf-8"))
    by = [k.strip() for k in args.by.split(",") if k.strip()]

    # Accuracy corpus
    acc_stems, acc_counts = stratified_sample(
        index, args.accuracy_n, by, args.seed, args.min_per_stratum)
    # Timing corpus = stratified subset of the accuracy corpus
    tim_stems, tim_counts = stratified_sample(
        index, args.timing_n, by, args.seed + 1, max(1, args.min_per_stratum // 2),
        restrict_to=acc_stems)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "seed": args.seed,
        "stratify_by": by,
        "min_per_stratum": args.min_per_stratum,
        "population_size": len(index),
        "accuracy": {
            "n_requested": args.accuracy_n,
            "n_selected": len(acc_stems),
            "per_stratum": acc_counts,
            "stems": acc_stems,
        },
        "timing": {
            "n_requested": args.timing_n,
            "n_selected": len(tim_stems),
            "per_stratum": tim_counts,
            "stems": tim_stems,
            "note": "subset of accuracy corpus; run with repeats per system",
        },
    }
    manifest_path = args.out_dir / "sample_manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    # Copy images
    copy_report = {}
    if not args.no_copy and args.images is not None:
        if not args.images.exists():
            raise SystemExit(f"Images dir not found: {args.images}")
        acc_copied, acc_missing = _copy_images(acc_stems, index, args.images,
                                               args.out_dir / "accuracy_images")
        tim_copied, tim_missing = _copy_images(tim_stems, index, args.images,
                                               args.out_dir / "timing_images")
        copy_report = {
            "accuracy_copied": acc_copied, "accuracy_missing": acc_missing,
            "timing_copied": tim_copied, "timing_missing": tim_missing,
        }

    # Report
    print("=" * 64)
    print(f"  Population: {len(index)} pages")
    print(f"  Stratify by: {by} | seed={args.seed} | min/stratum={args.min_per_stratum}")
    print(f"  Accuracy corpus: {len(acc_stems)} pages (1 run/system)")
    print(f"  Timing corpus:   {len(tim_stems)} pages (repeats/system, subset of accuracy)")
    print(f"  Manifest -> {manifest_path}")
    if copy_report:
        print(f"  Images copied: accuracy={copy_report['accuracy_copied']}, "
              f"timing={copy_report['timing_copied']}")
        if copy_report["accuracy_missing"]:
            print(f"  [WARN] {len(copy_report['accuracy_missing'])} accuracy images missing")
    print("-" * 64)
    print("  Accuracy stratification:")
    for s in sorted(acc_counts):
        print(f"    {s:<45s} {acc_counts[s]:>4d}")
    print("=" * 64)
    # Coverage sanity: warn if any populated stratum got zero accuracy samples
    full_groups = Counter(_stratum_key(m, by) for m in index.values())
    zero = [s for s in full_groups if acc_counts.get(s, 0) == 0]
    if zero:
        print(f"[WARN] {len(zero)} stratum/strata received 0 accuracy samples: {zero[:5]}...")


if __name__ == "__main__":
    main()
