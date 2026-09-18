"""Evidence construction and model feature handling.

Evidence is templated from computed values, so it can be asserted exactly. That
is the point of not generating it: given the features, the sentence is a
function, and a function can be tested.
"""

from __future__ import annotations

import pytest
from conftest import make_context, make_stats

from app import model as ml
from app.evidence import CAUTION, build_evidence
from app.labels import LabelDecision


def decision(label: str = "persistent_industrial", rationale=None) -> LabelDecision:
    return LabelDecision(
        cell_id="2375:8640",
        label=label,  # type: ignore[arg-type]
        rule_version="rule-v1",
        rationale=rationale or [],
    )


def statements(items) -> str:
    return " ".join(i.statement for i in items)


# ------------------------------------------------------------- evidence --


def test_evidence_cites_real_recurrence_numbers():
    items = build_evidence(
        make_stats(distinct_days=6, observations=25, window_days=7),
        make_context(),
        decision(),
    )
    text = statements(items)
    assert "6 distinct days" in text
    assert "25 satellite observations" in text
    assert "7-day window" in text


def test_evidence_singularises_one_day():
    items = build_evidence(
        make_stats(distinct_days=1, observations=1), make_context(), decision()
    )
    text = statements(items)
    assert "1 distinct day " in text or "1 distinct day\n" in text or "1 distinct day" in text
    assert "1 satellite observation " in text or "1 satellite observation" in text


def test_evidence_reports_the_deviation_ratio_when_the_baseline_is_usable():
    items = build_evidence(
        make_stats(observations=20, median_frp=1.5, p90_frp=9.0),
        make_context(),
        decision("industrial_fire"),
    )
    text = statements(items)
    assert "1.50 MW" in text
    assert "9.00 MW" in text
    assert "6.0x the median" in text


def test_thin_baseline_states_absence_rather_than_a_ratio():
    """Reporting a ratio from three points would be noise presented as insight."""
    items = build_evidence(
        make_stats(observations=3, distinct_days=2), make_context(), decision()
    )
    absent = [i for i in items if i.kind == "absent"]
    assert any("too few to establish a baseline" in i.statement for i in absent)
    # No deviation figure may be quoted. Matching the phrase rather than the
    # substring "ratio", which also occurs inside "separation".
    assert "the median" not in statements(items)


def test_unsurveyed_context_is_marked_absent_not_reported_as_empty():
    items = build_evidence(
        make_stats(), make_context(coverage="not_surveyed"), decision("unknown")
    )
    item = next(i for i in items if "not been surveyed" in i.statement)
    assert item.kind == "absent"
    assert "gap in our coverage" in item.statement


def test_surveyed_with_nothing_nearby_is_distinct_from_unsurveyed():
    """These two states must never produce the same sentence."""
    surveyed_empty = build_evidence(
        make_stats(),
        make_context(distance_m=None, facility_name=None, category=None),
        decision("unknown"),
    )
    unsurveyed = build_evidence(
        make_stats(), make_context(coverage="not_surveyed"), decision("unknown")
    )

    empty_text = statements(surveyed_empty)
    unsurveyed_text = statements(unsurveyed)

    assert "no mapped industrial feature was found within 10 km" in empty_text
    assert "has not been surveyed" in unsurveyed_text
    assert empty_text != unsurveyed_text


def test_facility_evidence_is_marked_observed_and_attributed():
    items = build_evidence(
        make_stats(),
        make_context(distance_m=502.0, facility_name="Banda Oil Facility", category="oil"),
        decision(),
    )
    item = next(i for i in items if "Banda Oil Facility" in i.statement)
    assert item.kind == "observed"
    assert item.dataset_id == "osm_industrial"
    assert "502 m" in item.statement


def test_distance_is_formatted_in_km_when_large():
    items = build_evidence(
        make_stats(), make_context(distance_m=4_200.0), decision()
    )
    assert "4.2 km" in statements(items)


def test_land_cover_evidence_admits_it_is_approximate():
    items = build_evidence(
        make_stats(), make_context(land_cover="forest"), decision()
    )
    item = next(i for i in items if "land parcel" in i.statement)
    assert "approximate" in item.statement
    assert "not a containment test" in item.statement


def test_abstention_lists_the_unmet_criteria():
    items = build_evidence(
        make_stats(distinct_days=2, observations=8),
        make_context(distance_m=4_000.0),
        decision(
            "unknown",
            [
                {"criterion": "industrial_proximity", "passed": False},
                {"criterion": "recurrence", "passed": False},
            ],
        ),
    )
    item = next(i for i in items if i.statement.startswith("Not classified"))
    assert item.kind == "absent"
    assert "industrial_proximity" in item.statement
    assert "recurrence" in item.statement


def test_every_evidence_item_has_a_valid_kind():
    items = build_evidence(make_stats(), make_context(), decision())
    assert {i.kind for i in items} <= {"observed", "derived", "absent"}
    assert len(items) >= 3


def test_caution_never_claims_proof():
    assert "not proof" in CAUTION
    lowered = CAUTION.lower()
    assert "confirmed" not in lowered


# ---------------------------------------------------------------- model --


def test_feature_vector_length_matches_the_declared_names():
    features = ml.ObservationFeatures(
        frp_mw=2.4,
        brightness_k=330.0,
        brightness_long_k=303.0,
        scan=0.4,
        track=0.45,
        day_night="N",
        confidence_tier="high",
        instrument="VIIRS",
        latitude=23.755,
        longitude=86.405,
        distance_to_facility_m=800.0,
        facilities_within_5km=4,
        land_cover="industrial",
    )
    assert len(features.to_vector()) == len(ml.FEATURE_NAMES)


def test_missing_distance_sets_the_indicator_and_caps_the_value():
    """A missing distance must be flagged, not silently encoded as 'very far' —
    otherwise the model cannot tell absence from distance."""
    base = dict(
        frp_mw=2.4,
        brightness_k=330.0,
        brightness_long_k=303.0,
        scan=0.4,
        track=0.45,
        day_night="D",
        confidence_tier="low",
        instrument="MODIS",
        latitude=23.0,
        longitude=86.0,
        facilities_within_5km=0,
        land_cover="unknown",
    )
    missing = ml.ObservationFeatures(distance_to_facility_m=None, **base).to_vector()
    present = ml.ObservationFeatures(
        distance_to_facility_m=50_000.0, **base
    ).to_vector()

    index = ml.FEATURE_NAMES.index("facility_distance_missing")
    distance_index = ml.FEATURE_NAMES.index("distance_to_facility_m")

    assert missing[index] == 1.0
    assert present[index] == 0.0
    # Both cap at the same distance, so only the indicator distinguishes them.
    assert missing[distance_index] == ml.DISTANCE_CAP_M
    assert present[distance_index] == ml.DISTANCE_CAP_M


def test_land_cover_is_one_hot_and_exclusive():
    features = ml.ObservationFeatures(
        frp_mw=1.0,
        brightness_k=310.0,
        brightness_long_k=300.0,
        scan=0.3,
        track=0.3,
        day_night="D",
        confidence_tier="nominal",
        instrument="VIIRS",
        latitude=20.0,
        longitude=85.0,
        distance_to_facility_m=100.0,
        facilities_within_5km=1,
        land_cover="forest",
    )
    vector = features.to_vector()
    flags = [
        vector[ml.FEATURE_NAMES.index(f"land_cover_{c}")] for c in ml.LAND_COVERS
    ]
    assert sum(flags) == 1.0
    assert vector[ml.FEATURE_NAMES.index("land_cover_forest")] == 1.0


def test_unrecognised_land_cover_sets_no_flag():
    """An unexpected value must not be silently bucketed as something else."""
    features = ml.ObservationFeatures(
        frp_mw=1.0,
        brightness_k=310.0,
        brightness_long_k=300.0,
        scan=0.3,
        track=0.3,
        day_night="D",
        confidence_tier="nominal",
        instrument="VIIRS",
        latitude=20.0,
        longitude=85.0,
        distance_to_facility_m=100.0,
        facilities_within_5km=1,
        land_cover="vineyard-of-mars",
    )
    vector = features.to_vector()
    flags = [
        vector[ml.FEATURE_NAMES.index(f"land_cover_{c}")] for c in ml.LAND_COVERS
    ]
    assert sum(flags) == 0.0


def test_feature_sets_are_subsets_of_the_full_vector():
    for name, names in ml.FEATURE_SETS.items():
        assert set(names) <= set(ml.FEATURE_NAMES), name
        assert len(ml.feature_mask(name)) == len(names)


def test_no_coords_excludes_coordinates():
    """Shipped default: coordinates let a tree memorise locations rather than
    generalise (see docs/findings/2026-09-18-model-ablation.md)."""
    names = ml.FEATURE_SETS["no_coords"]
    assert "latitude" not in names
    assert "longitude" not in names
    assert "dual_band_delta_k" in names


def test_thermal_only_excludes_all_context():
    names = ml.FEATURE_SETS["thermal_only"]
    assert not any(n.startswith("land_cover_") for n in names)
    assert "distance_to_facility_m" not in names
    assert "facilities_within_5km" not in names


def test_unknown_feature_set_raises():
    with pytest.raises(KeyError, match="Unknown feature set"):
        ml.feature_mask("not-a-set")


def test_spatial_block_groups_nearby_points():
    assert ml.spatial_block(23.1, 86.2) == ml.spatial_block(23.9, 86.8)
    assert ml.spatial_block(23.1, 86.2) != ml.spatial_block(24.1, 86.2)


def test_split_by_block_never_shares_a_block():
    """A random row split would leak: one coal fire contributes dozens of rows,
    so the same source would appear in train and test."""
    blocks = [f"{i // 5}:{i % 3}" for i in range(60)]
    train, test = ml.split_by_block(blocks, test_fraction=0.3)

    assert not (train & test).any()
    assert (train | test).all()

    train_blocks = {b for b, m in zip(blocks, train) if m}
    test_blocks = {b for b, m in zip(blocks, test) if m}
    assert train_blocks.isdisjoint(test_blocks)


def test_split_by_block_is_deterministic():
    blocks = [f"{i % 11}:0" for i in range(80)]
    first = ml.split_by_block(blocks, 0.3)
    second = ml.split_by_block(blocks, 0.3)
    assert (first[0] == second[0]).all()


def test_load_returns_none_when_no_model_file(monkeypatch, tmp_path):
    """No model is a legitimate state; loading must not raise."""
    monkeypatch.setattr(ml, "MODEL_PATH", tmp_path / "absent.joblib")
    assert ml.load() is None


def test_caveat_states_labels_are_not_ground_truth():
    assert "not verified ground truth" in ml.CAVEAT
    assert "consistency check" in ml.CAVEAT
