"""Run the behavioural evaluation suite and print a report.

    python -m evals.run

Exits non-zero if any scenario fails, so it is usable as a gate in CI.
"""

from __future__ import annotations

import logging
import sys
import tempfile
from pathlib import Path

from .scenarios import run_all


def main() -> int:
    # The report is the output. Per-request API logging would bury it.
    logging.disable(logging.INFO)

    with tempfile.TemporaryDirectory(
        prefix="heatdetect-evals-", ignore_cleanup_errors=True
    ) as tmp:
        results = run_all(Path(tmp))

    width = max(len(r.name) for r in results) + 2
    current_category = None

    print("\nHeatDetect behavioural evaluation")
    print("=" * (width + 62))

    for result in sorted(results, key=lambda r: (r.category, r.name)):
        if result.category != current_category:
            current_category = result.category
            print(f"\n{current_category.upper()}")
        mark = "PASS" if result.passed else "FAIL"
        print(f"  [{mark}] {result.name:<{width}} {result.expectation}")
        if not result.passed:
            print(f"         -> {result.detail}")

    failed = [r for r in results if not r.passed]
    print("\n" + "=" * (width + 62))
    print(f"{len(results) - len(failed)}/{len(results)} scenarios passed")

    if failed:
        print("\nFailures:")
        for result in failed:
            print(f"  {result.name}: {result.detail}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
