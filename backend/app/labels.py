"""Weak label assignment from full multi-day history.

These labels train the single-observation model (see
docs/adr/0004-labelling-by-information-asymmetry.md). They are **programmatic
heuristics, not verified ground truth**, and every reported metric carries that
caveat.

The information split is the point: labels here may use the entire history of a
cell — recurrence, baseline stability, land context. The model that consumes them
sees only one detection. So the model cannot simply re-derive these thresholds;
it has to generalise from a snapshot to a behaviour it cannot observe.

Thresholds are calibrated against measured data, not intuition. The real 7-day
India FRP distribution is median ~1.6 MW, p95 ~9.6 MW, p99 ~17.7 MW. Earlier
drafts of this project assumed 100+ MW industrial events; no such thing exists in
this feed, and any threshold written on that assumption would never fire.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal, Sequence

from sqlalchemy.engine import Engine

from .config import LABEL_RULE_VERSION
from .db import cell_labels
from .features import CellContextRow, CellStats

logger = logging.getLogger(__name__)

ThermalClass = Literal[
    "industrial_fire", "persistent_industrial", "natural_fire", "unknown"
]

# --- Thresholds (rule-v1) -------------------------------------------------
# Each is named, and each appears in the rationale when it fires, so a label can
# always be explained in terms of the criterion that produced it.

PERSISTENT_MIN_DISTINCT_DAYS = 4
"""Measured: 220 of 2,695 active cells reach 4+ distinct days over 7 days. This
separates genuinely recurring sources from multi-satellite echoes of one event."""

INDUSTRIAL_PROXIMITY_M = 3_000.0
"""Within 3 km of a mapped industrial feature. Measured nearest distances for
confirmed persistent industrial cells ranged 502 m to 2,976 m."""

NON_INDUSTRIAL_DISTANCE_M = 5_000.0
"""Beyond 5 km, industrial attribution is not defensible at 375 m resolution."""

EPISODIC_MAX_DISTINCT_DAYS = 2
"""A vegetation fire burns out. Recurrence over many days indicates otherwise."""

EXCURSION_RATIO = 3.0
"""p90 at least 3x the median marks a distribution with a genuine upper excursion
rather than steady output."""

EXCURSION_ABSOLUTE_FLOOR_MW = 5.0
"""Guards against ratio artefacts: 0.3 MW to 0.9 MW is a 3x ratio and means
nothing. Roughly the measured p90 of the whole distribution."""

VEGETATION_COVERS = frozenset({"forest", "shrubland", "cropland"})


@dataclass(frozen=True)
class LabelDecision:
    cell_id: str
    label: ThermalClass
    rule_version: str
    rationale: list[dict[str, object]] = field(default_factory=list)

    @property
    def is_confident(self) -> bool:
        return self.label != "unknown"


def _criterion(name: str, passed: bool, **values: object) -> dict[str, object]:
    return {"criterion": name, "passed": passed, **values}


def assign_label(stats: CellStats, context: CellContextRow) -> LabelDecision:
    """Classify one cell from its full history.

    Order matters. The checks run from most-constrained to least, and the first
    match wins, so a cell that is both persistent and industrial-adjacent cannot
    also be labelled a vegetation fire.
    """
    rationale: list[dict[str, object]] = []

    # --- Coverage gate ---------------------------------------------------
    # Without a survey we do not know whether industry is nearby. Guessing here
    # would convert a gap in our coverage into apparent evidence, which is the
    # single easiest way for this system to start lying.
    if context.context_coverage != "surveyed":
        rationale.append(
            _criterion(
                "context_surveyed",
                False,
                coverage=context.context_coverage,
                note="Industrial context not surveyed for this area; "
                "proximity cannot be asserted either way.",
            )
        )
        return LabelDecision(stats.cell_id, "unknown", LABEL_RULE_VERSION, rationale)

    rationale.append(_criterion("context_surveyed", True, coverage="surveyed"))

    distance = context.distance_to_facility_m
    near_industry = distance is not None and distance <= INDUSTRIAL_PROXIMITY_M
    far_from_industry = distance is None or distance > NON_INDUSTRIAL_DISTANCE_M

    rationale.append(
        _criterion(
            "industrial_proximity",
            near_industry,
            distance_m=distance,
            threshold_m=INDUSTRIAL_PROXIMITY_M,
            facility=context.nearest_facility_name,
            category=context.nearest_facility_category,
        )
    )

    persistent = stats.distinct_days >= PERSISTENT_MIN_DISTINCT_DAYS
    rationale.append(
        _criterion(
            "recurrence",
            persistent,
            distinct_days=stats.distinct_days,
            threshold_days=PERSISTENT_MIN_DISTINCT_DAYS,
            observations=stats.observation_count,
        )
    )

    has_excursion = (
        stats.has_usable_baseline
        and stats.median_frp_mw > 0
        and stats.p90_frp_mw >= EXCURSION_RATIO * stats.median_frp_mw
        and stats.p90_frp_mw >= EXCURSION_ABSOLUTE_FLOOR_MW
    )
    rationale.append(
        _criterion(
            "upper_excursion",
            has_excursion,
            median_frp_mw=round(stats.median_frp_mw, 2),
            p90_frp_mw=round(stats.p90_frp_mw, 2),
            ratio=(
                round(stats.p90_frp_mw / stats.median_frp_mw, 2)
                if stats.median_frp_mw > 0
                else None
            ),
            ratio_threshold=EXCURSION_RATIO,
            absolute_floor_mw=EXCURSION_ABSOLUTE_FLOOR_MW,
            baseline_usable=stats.has_usable_baseline,
        )
    )

    # --- Decision ---------------------------------------------------------

    # An established industrial source showing a marked upper excursion. This is
    # the rare, operationally interesting class.
    if near_industry and persistent and has_excursion:
        return LabelDecision(
            stats.cell_id, "industrial_fire", LABEL_RULE_VERSION, rationale
        )

    # Recurring heat at an industrial site with no marked excursion: routine
    # process heat, flaring, or a long-burning coal seam.
    if near_industry and persistent:
        return LabelDecision(
            stats.cell_id, "persistent_industrial", LABEL_RULE_VERSION, rationale
        )

    # Short-lived heat away from industry, on vegetation or unclassified ground.
    if (
        far_from_industry
        and stats.distinct_days <= EPISODIC_MAX_DISTINCT_DAYS
        and context.land_cover in VEGETATION_COVERS | {"unknown"}
    ):
        rationale.append(
            _criterion(
                "vegetation_context",
                True,
                land_cover=context.land_cover,
                note=(
                    "Land cover is approximate (nearest OSM parcel centroid); "
                    "'unknown' is common and is not treated as evidence."
                ),
            )
        )
        return LabelDecision(
            stats.cell_id, "natural_fire", LABEL_RULE_VERSION, rationale
        )

    # Everything else. Abstaining is a valid, and often correct, answer.
    rationale.append(
        _criterion(
            "no_rule_matched",
            False,
            note="Evidence does not satisfy any class criteria; left unclassified.",
        )
    )
    return LabelDecision(stats.cell_id, "unknown", LABEL_RULE_VERSION, rationale)


def assign_labels(
    stats: Sequence[CellStats], contexts: Sequence[CellContextRow]
) -> list[LabelDecision]:
    by_cell = {c.cell_id: c for c in contexts}
    decisions: list[LabelDecision] = []
    for row in stats:
        context = by_cell.get(row.cell_id)
        if context is None:
            # No context row at all is a pipeline ordering bug, not a data fact.
            # Fail loudly rather than silently labelling it unknown.
            raise KeyError(
                f"No context computed for cell {row.cell_id!r}. Run the context "
                f"stage before labelling."
            )
        decisions.append(assign_label(row, context))
    return decisions


def store_labels(engine: Engine, decisions: Sequence[LabelDecision]) -> int:
    now = datetime.now(timezone.utc)
    payload = [
        {
            "cell_id": d.cell_id,
            "label": d.label,
            "label_rule_version": d.rule_version,
            "rationale": d.rationale,
            "computed_at": now,
        }
        for d in decisions
    ]
    with engine.begin() as conn:
        conn.execute(cell_labels.delete())
        if payload:
            conn.execute(cell_labels.insert(), payload)
    return len(payload)


def label_distribution(decisions: Sequence[LabelDecision]) -> dict[str, int]:
    counts: dict[str, int] = {
        "industrial_fire": 0,
        "persistent_industrial": 0,
        "natural_fire": 0,
        "unknown": 0,
    }
    for d in decisions:
        counts[d.label] += 1
    return counts
