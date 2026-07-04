#!/usr/bin/env python3
"""Compare benchmark results between current and baseline runs.

Scans two directories for criterion ``*.json`` result files (typically the
``target/criterion`` tree or a copy of it), matches benchmarks by name, and
reports regressions greater than a configurable tolerance.

Usage:
    compare_benchmarks.py --current <dir> --baseline <dir> [--tolerance 0.20]

Exit codes:
    0 - all benchmarks within tolerance (or no overlapping benchmarks found)
    1 - at least one benchmark regressed beyond tolerance
    2 - invalid usage / missing directories
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, Optional


def extract_median(data: dict) -> Optional[float]:
    """Extract a representative median time (in ns) from a criterion JSON blob.

    Criterion ``estimates.json`` files expose a ``median`` object with a
    ``point_estimate`` field. We also tolerate a flat ``median`` scalar and a
    ``point_estimate`` top-level key for forward compatibility.
    """
    if not isinstance(data, dict):
        return None

    median = data.get("median")
    if isinstance(median, dict):
        point = median.get("point_estimate")
        if isinstance(point, (int, float)):
            return float(point)
    if isinstance(median, (int, float)):
        return float(median)

    point = data.get("point_estimate")
    if isinstance(point, (int, float)):
        return float(point)

    # Some criterion summary files nest under "estimates".
    estimates = data.get("estimates")
    if isinstance(estimates, dict):
        return extract_median(estimates)

    return None


def derive_name(root: Path, json_path: Path) -> str:
    """Derive a human-readable benchmark name from a criterion file path.

    Criterion lays out results as
    ``<root>/<group>/<bench>/<param>/new/estimates.json``. We collapse the
    path between ``root`` and the ``estimates.json`` file into a ``/``-joined
    name, dropping the trailing ``new`` segment when present.
    """
    rel = json_path.relative_to(root)
    parts = list(rel.parts)
    # Drop the filename.
    if parts and parts[-1].lower().endswith(".json"):
        parts = parts[:-1]
    # Drop a trailing "new" (criterion's latest-run folder).
    if parts and parts[-1] == "new":
        parts = parts[:-1]
    return "/".join(parts) if parts else json_path.parent.name


def collect_benchmarks(directory: Path) -> Dict[str, float]:
    """Walk *directory* recursively and return ``{name: median_ns}``."""
    results: Dict[str, float] = {}
    if not directory.exists():
        return results

    for json_path in sorted(directory.rglob("*.json")):
        try:
            with json_path.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue

        median = extract_median(data)
        if median is None:
            continue

        name = derive_name(directory, json_path)
        if not name:
            continue

        # Prefer the first occurrence; criterion can write duplicate names
        # across nested folders. Keep the smallest median as a conservative
        # representative if we see a collision.
        if name in results:
            results[name] = min(results[name], median)
        else:
            results[name] = median

    return results


def format_time(ns: float) -> str:
    """Format a nanosecond value into a human-readable string."""
    if ns >= 1e9:
        return f"{ns / 1e9:.3f} s"
    if ns >= 1e6:
        return f"{ns / 1e6:.3f} ms"
    if ns >= 1e3:
        return f"{ns / 1e3:.3f} us"
    return f"{ns:.1f} ns"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare criterion benchmark results between two runs.",
    )
    parser.add_argument(
        "--current",
        required=True,
        type=Path,
        help="Directory containing the current benchmark JSON results.",
    )
    parser.add_argument(
        "--baseline",
        required=True,
        type=Path,
        help="Directory containing the baseline benchmark JSON results.",
    )
    parser.add_argument(
        "--tolerance",
        type=float,
        default=0.20,
        help="Regression tolerance as a fraction (default: 0.20 = 20%%).",
    )
    args = parser.parse_args()

    current_dir: Path = args.current
    baseline_dir: Path = args.baseline

    if not current_dir.is_dir():
        print(f"ERROR: current directory not found: {current_dir}", file=sys.stderr)
        return 2
    if not baseline_dir.is_dir():
        print(f"ERROR: baseline directory not found: {baseline_dir}", file=sys.stderr)
        return 2

    current = collect_benchmarks(current_dir)
    baseline = collect_benchmarks(baseline_dir)

    if not current:
        print(f"WARNING: no benchmark JSON files found in {current_dir}",
              file=sys.stderr)
    if not baseline:
        print(f"WARNING: no benchmark JSON files found in {baseline_dir}",
              file=sys.stderr)

    common = sorted(set(current) & set(baseline))
    only_current = sorted(set(current) - set(baseline))
    only_baseline = sorted(set(baseline) - set(current))

    print("=" * 78)
    print("Benchmark Regression Comparison Report")
    print("=" * 78)
    print(f"Current  : {current_dir}")
    print(f"Baseline : {baseline_dir}")
    print(f"Tolerance: {args.tolerance * 100:.1f}%")
    print("-" * 78)

    if not common:
        print("No matching benchmarks found between current and baseline.")
        if only_current:
            print(f"\nBenchmarks only in current ({len(only_current)}):")
            for name in only_current:
                print(f"  + {name}")
        if only_baseline:
            print(f"\nBenchmarks only in baseline ({len(only_baseline)}):")
            for name in only_baseline:
                print(f"  - {name}")
        print("\nNo regressions detected (nothing to compare).")
        return 0

    header = f"{'Benchmark':<40} {'Baseline':>14} {'Current':>14} {'Change':>10} {'Status':>8}"
    print(header)
    print("-" * len(header))

    failures = 0
    passes = 0
    for name in common:
        base_ns = baseline[name]
        cur_ns = current[name]
        if base_ns > 0:
            change = (cur_ns - base_ns) / base_ns
        else:
            change = 0.0 if cur_ns == 0 else float("inf")
        pct = change * 100.0
        if change > args.tolerance:
            status = "FAIL"
            failures += 1
        else:
            status = "PASS"
            passes += 1
        print(f"{name:<40} {format_time(base_ns):>14} "
              f"{format_time(cur_ns):>14} {pct:>+9.2f}% {status:>8}")

    print("-" * len(header))
    print(f"Total: {len(common)} compared | {passes} passed | {failures} failed")

    if only_current:
        print(f"\nNew benchmarks (only in current, {len(only_current)}):")
        for name in only_current:
            print(f"  + {name}  ({format_time(current[name])})")
    if only_baseline:
        print(f"\nRemoved benchmarks (only in baseline, {len(only_baseline)}):")
        for name in only_baseline:
            print(f"  - {name}  ({format_time(baseline[name])})")

    print("=" * 78)
    if failures > 0:
        print(f"RESULT: {failures} benchmark(s) regressed beyond "
              f"{args.tolerance * 100:.1f}% tolerance.")
        return 1
    print("RESULT: all benchmarks within tolerance.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
