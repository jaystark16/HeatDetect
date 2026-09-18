"""Invariants for the committed offline snapshot.

The snapshot is what the deployed GitHub Pages site serves, so it is the most
publicly visible artefact in the project. These tests assert the properties that
make it honest, because a regression here misleads every visitor.

One of them exists because of a real defect: the export originally took the top
N rows from a persistence-ordered query. Vegetation fires are short-lived by
definition, so the snapshot contained **zero** of them and the offline map
implied every thermal anomaly in India was industrial.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import pytest

SNAPSHOT = Path(__file__).resolve().parent.parent.parent / "frontend" / "public" / "snapshot.json"

ALL_CLASSES = {
    "industrial_fire",
    "persistent_industrial",
    "natural_fire",
    "unknown",
}


@pytest.fixture(scope="module")
def snapshot() -> dict:
    if not SNAPSHOT.exists():
        pytest.skip(
            "snapshot.json not built; run scripts/export_snapshot.py"
        )
    return json.loads(SNAPSHOT.read_text(encoding="utf-8"))


def test_snapshot_is_labelled_as_cached_never_live(snapshot):
    assert snapshot["kind"] == "cached_snapshot"
    assert "not live data" in snapshot["note"].lower()


def test_snapshot_records_the_window_it_covers(snapshot):
    window = snapshot["captured_window"]
    assert window["oldest_detection_at"]
    assert window["newest_detection_at"]
    assert window["oldest_detection_at"] < window["newest_detection_at"]
    assert snapshot["generated_at"]


def test_snapshot_reports_coverage(snapshot):
    assert snapshot["surveyed_cells"] > 0
    assert "surveyed industrial context" in snapshot["coverage_note"]
    # Unsurveyed cells must be reported, not hidden.
    assert "unsurveyed_cells" in snapshot


def test_every_class_appears_in_the_summaries(snapshot):
    """The defect this guards: a persistence-ordered top-N excluded vegetation
    fires entirely, so the offline map misrepresented the data."""
    counts = Counter(s["label"] for s in snapshot["summaries"])
    missing = ALL_CLASSES - set(counts)
    assert not missing, f"classes absent from the snapshot: {missing}"
    for label in ALL_CLASSES:
        assert counts[label] > 0


def test_every_class_appears_in_the_details(snapshot):
    counts = Counter(
        d["classification"]["label"] for d in snapshot["details"].values()
    )
    missing = ALL_CLASSES - set(counts)
    assert not missing, f"classes with no inspectable detail: {missing}"


def test_detail_ids_all_exist_in_the_summaries(snapshot):
    """A detail for a hotspot that is not on the map is unreachable."""
    summary_ids = {s["id"] for s in snapshot["summaries"]}
    orphans = set(snapshot["details"]) - summary_ids
    assert not orphans, f"{len(orphans)} details are not reachable from the map"


def test_no_rule_classification_carries_a_probability(snapshot):
    """The project's central honesty invariant, checked in the shipped data.

    A deterministic threshold has no probability, so attaching one would be
    fabricating a statistic.
    """
    offenders = [
        key
        for key, detail in snapshot["details"].items()
        if detail["classification"]["source"] == "rule"
        and detail["classification"]["confidence"] is not None
    ]
    assert not offenders, f"{len(offenders)} rule verdicts carry a probability"


def test_every_detail_has_evidence_and_a_caution(snapshot):
    for key, detail in snapshot["details"].items():
        assert detail["evidence"], f"{key} has no evidence"
        assert "not proof" in detail["caution"], f"{key} has no caution"
        assert {e["kind"] for e in detail["evidence"]} <= {
            "observed",
            "derived",
            "absent",
        }


def test_suppressed_classes_never_appear_as_model_output(snapshot):
    """A class below the precision floor must not be presented as a model
    finding anywhere in the shipped data."""
    per_class = (snapshot["model"].get("metrics") or {}).get("per_class") or {}
    suppressed = {
        label for label, row in per_class.items() if row["precision"] < 0.5
    }
    if not suppressed:
        pytest.skip("no class is currently below the precision floor")

    offenders = [
        key
        for key, detail in snapshot["details"].items()
        if detail["classification"]["source"] == "model"
        and detail["classification"]["label"] in suppressed
        and not detail["classification"]["abstained"]
    ]
    assert not offenders, f"suppressed class reported as a model finding: {offenders}"


def test_model_block_carries_its_caveat(snapshot):
    model = snapshot["model"]
    assert model["caveat"]
    if model["trained"]:
        assert model["model_version"]
        assert "not verified ground truth" in model["caveat"]


def test_datasets_all_declare_licence_and_limitations(snapshot):
    assert len(snapshot["datasets"]) >= 4
    for dataset in snapshot["datasets"]:
        assert dataset["licence"]
        assert dataset["limitations"]


def test_no_synthetic_dataset_is_present(snapshot):
    """Nothing served may be fabricated. If a synthetic source ever appears it
    must be a deliberate, reviewed decision — not a silent regression."""
    synthetic = [d["id"] for d in snapshot["datasets"] if d["kind"] == "synthetic"]
    assert not synthetic, f"synthetic datasets in the shipped snapshot: {synthetic}"


def test_summaries_carry_an_age_offset_not_a_frozen_timestamp(snapshot):
    """Ages are rehydrated on load so relative filters stay meaningful; a frozen
    absolute timestamp would make the demo look stale and break time filters."""
    for summary in snapshot["summaries"][:20]:
        assert "hours_ago" in summary
        assert "acquired_at" not in summary
        assert summary["hours_ago"] >= 0
