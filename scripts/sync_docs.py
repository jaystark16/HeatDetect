"""Regenerate the README's metrics block from the trained model's own metrics.

    backend/.venv/Scripts/python scripts/sync_docs.py [--check]

Why this exists: the reported figures went stale three times during
development. Each time OSM coverage grew, the model was retrained and the
numbers in prose no longer matched `backend/models/metrics.json` — once badly
enough that the UI asserted "zero recall" for a class whose recall had risen to
0.32. Numbers that describe a measurement should be written by the measurement.

`--check` exits non-zero if the README is out of date, so CI can enforce it.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
METRICS = ROOT / "backend" / "models" / "metrics.json"
README = ROOT / "README.md"

START = "<!-- METRICS:START -->"
END = "<!-- METRICS:END -->"

# Mirrors MIN_PRECISION_TO_REPORT in backend/app/model.py.
MIN_PRECISION_TO_REPORT = 0.5


def render(metrics: dict) -> str:
    per_class = metrics["per_class"]
    suppressed = [
        (label, row["precision"])
        for label, row in per_class.items()
        if row["precision"] < MIN_PRECISION_TO_REPORT
    ]

    lines = [
        START,
        "",
        f"Model `{metrics['model_version']}` · feature set `{metrics['feature_set']}` · "
        f"{metrics['training_rows']} train / {metrics['test_rows']} test rows across "
        f"{metrics['train_blocks']}/{metrics['test_blocks']} geographic blocks.",
        "",
        "| class | precision | recall | F1 | support |",
        "|---|---|---|---|---|",
    ]
    for label, row in per_class.items():
        flag = " ⚠" if row["precision"] < MIN_PRECISION_TO_REPORT else ""
        lines.append(
            f"| `{label}`{flag} | {row['precision']:.3f} | {row['recall']:.3f} "
            f"| {row['f1']:.3f} | {row['support']} |"
        )

    lines += [
        "",
        f"macro F1 **{metrics['macro_f1']:.3f}**. Overall accuracy is deliberately not "
        "reported: the classes are heavily imbalanced, so a single figure would "
        "flatter the model while hiding that the rarest class performs worst.",
        "",
    ]

    if suppressed:
        listed = ", ".join(
            f"`{label}` (precision {precision:.3f})" for label, precision in suppressed
        )
        lines += [
            f"⚠ marks classes below the {MIN_PRECISION_TO_REPORT} precision floor, which "
            f"the API **suppresses** rather than reports: {listed}. Most such "
            "predictions would be wrong, so they are returned as *not classified* "
            "and findings for those classes come only from the deterministic rules.",
            "",
        ]

    top = sorted(
        metrics["feature_importance"].items(), key=lambda kv: kv[1], reverse=True
    )[:5]
    lines += [
        "Most influential features: "
        + ", ".join(f"`{name}` {value:.3f}" for name, value in top)
        + ".",
        "",
        "*Labels are programmatic heuristics derived from multi-day persistence, not "
        "verified ground truth. These figures measure agreement with a documented "
        "rule set under a spatial hold-out — a consistency check, not validation "
        "against reality.*",
        "",
        f"<sub>Generated from `backend/models/metrics.json` by "
        f"`scripts/sync_docs.py`. Do not edit by hand.</sub>",
        "",
        END,
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(prog="sync_docs")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if the README is out of date instead of rewriting it",
    )
    args = parser.parse_args()

    if not METRICS.exists():
        print(
            f"{METRICS.relative_to(ROOT)} not found. Train a model first:\n"
            "  cd backend && python -m app.train --feature-set no_coords",
            file=sys.stderr,
        )
        return 1

    metrics = json.loads(METRICS.read_text(encoding="utf-8"))
    readme = README.read_text(encoding="utf-8")

    if START not in readme or END not in readme:
        print(
            f"README.md is missing the {START} / {END} markers.", file=sys.stderr
        )
        return 1

    before, rest = readme.split(START, 1)
    _, after = rest.split(END, 1)
    updated = before + render(metrics) + after

    if updated == readme:
        print("README metrics are up to date.")
        return 0

    if args.check:
        print(
            "README metrics are STALE. Run:\n"
            "  backend/.venv/Scripts/python scripts/sync_docs.py",
            file=sys.stderr,
        )
        return 1

    README.write_text(updated, encoding="utf-8")
    print(f"README metrics updated from {metrics['model_version']}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
