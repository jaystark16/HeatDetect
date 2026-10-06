"""Invariants for the committed offline snapshot.

The snapshot is what the deployed GitHub Pages site serves, so it is the most
publicly visible artefact in the project. These tests assert the properties that
make it honest, because a regression here misleads every visitor.

Two exist because of real defects in how the export sampled:

- It took the top N rows of a persistence-ordered query. Vegetation fires are
  short-lived by definition, so it contained **zero** of them and the offline
  map implied every thermal anomaly in India was industrial.
- Per-class quotas fixed that, but counted *detections*. A persistent source
  has one per satellite pass, so 1,400 rows covered 7 of 206
  persistent-industrial locations. The snapshot now carries every location.
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


def test_snapshot_is_labelled_as_a_file_never_a_live_query(snapshot):
    assert snapshot["kind"] == "cached_snapshot"
    assert "not a live query" in snapshot["note"].lower()


def test_snapshot_declares_whether_anything_refreshes_it(snapshot):
    """The page decides between "near real time" and "cached snapshot" from
    this block, so it must always be present and well-formed."""
    refresh = snapshot["refresh"]
    assert isinstance(refresh["scheduled"], bool)
    if refresh["scheduled"]:
        assert refresh["cadence_hours"] and refresh["cadence_hours"] > 0
    else:
        assert refresh["cadence_hours"] is None


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


def test_snapshot_carries_every_location(snapshot):
    """Complete, not sampled: the offline map must match what the API serves."""
    locations = snapshot["locations"]
    assert len(locations) == snapshot["total_locations"]
    assert len(locations) == snapshot["analytics"]["total_cells"]
    assert len({loc["cell_id"] for loc in locations}) == len(locations)


def test_location_counts_per_class_match_the_analytics(snapshot):
    """Regression: quotas over detection rows showed 7 of 206 persistent
    industrial locations. Every class must be present in full."""
    counts = Counter(loc["label"] for loc in snapshot["locations"])
    expected = {c["label"]: c["cells"] for c in snapshot["analytics"]["by_class"]}
    assert dict(counts) == {k: v for k, v in expected.items() if v}
    for label in ALL_CLASSES:
        assert counts[label] > 0, f"{label} absent from the snapshot"


def test_every_class_appears_in_the_details(snapshot):
    counts = Counter(
        d["classification"]["label"] for d in snapshot["details"].values()
    )
    missing = ALL_CLASSES - set(counts)
    assert not missing, f"classes with no inspectable detail: {missing}"


def test_every_detail_is_one_the_map_actually_opens(snapshot):
    """A detail no mark opens is unreachable.

    Regression: details were once taken from the first detection rows of each
    class — several passes over the same few cells, rarely the detection the
    map opened — so the most persistent locations all read "detail
    unavailable".
    """
    opened = {loc["representative_detection_id"] for loc in snapshot["locations"]}
    unreachable = set(snapshot["details"]) - opened
    assert not unreachable, f"{len(unreachable)} details no map mark opens"


def test_the_most_persistent_locations_have_detail(snapshot):
    """The feed lists locations by days seen, so its top must be inspectable."""
    top = sorted(
        snapshot["locations"],
        key=lambda loc: (-loc["distinct_days"], -loc["max_frp_mw"]),
    )[:20]
    missing = [
        loc["cell_id"]
        for loc in top
        if loc["representative_detection_id"] not in snapshot["details"]
    ]
    assert not missing, f"{len(missing)} of the 20 most persistent have no detail"


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


def test_timestamps_are_real_and_inside_the_declared_window(snapshot):
    """Regression test for a fabrication bug.

    The snapshot used to store each detection's age and the page rebuilt it as
    "now minus age". On a 13-day-old file that dated a 19 September detection
    2 October — after the window had ended — and "Last 24 hours" returned 57
    detections that were two weeks old. Every timestamp must now be a real one,
    and none may fall outside the window the snapshot itself declares.
    """
    from datetime import datetime  # noqa: PLC0415

    window = snapshot["captured_window"]
    oldest = datetime.fromisoformat(window["oldest_detection_at"])
    newest = datetime.fromisoformat(window["newest_detection_at"])
    built = datetime.fromisoformat(snapshot["generated_at"])

    def parse(value: str) -> datetime:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    stamped = [(d["id"], d["acquired_at"]) for d in snapshot["details"].values()]
    stamped += [(loc["cell_id"], loc["last_seen"]) for loc in snapshot["locations"]]
    assert stamped
    for key, value in stamped:
        when = parse(value)
        assert oldest <= when <= newest, f"{key} dated outside the window"
        assert when <= built, f"{key} is dated after the snapshot was built"

    for row in [*snapshot["locations"], *snapshot["details"].values()]:
        assert "hours_ago" not in row, "retired, fabrication-prone age field is back"
