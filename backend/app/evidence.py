"""Evidence construction.

Every statement the user sees is built here, from a template, with real computed
values substituted in. There is no generative step, so there is no way for a
sentence to assert something the data does not contain.

Each item declares what *kind* of statement it is, and the UI renders the three
kinds differently. That separation is the point of this module:

  observed    a measurement from an external source, unmodified
  derived     computed by us from observed data by documented logic
  absent      something we could NOT establish, stated explicitly

The `absent` kind is the one that keeps the system honest. "No industrial feature
was found within 10 km" and "this area has not been surveyed" look identical if
you only render positive findings, and they mean opposite things.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from .features import CellContextRow, CellStats
from .labels import LabelDecision

EvidenceKind = Literal["observed", "derived", "absent"]


@dataclass(frozen=True)
class EvidenceItem:
    statement: str
    kind: EvidenceKind
    values: dict[str, object] = field(default_factory=dict)
    dataset_id: str | None = None


def _metres(value: float) -> str:
    return f"{value / 1000:.1f} km" if value >= 1000 else f"{value:.0f} m"


def build_evidence(
    stats: CellStats,
    context: CellContextRow,
    decision: LabelDecision,
) -> list[EvidenceItem]:
    """Assemble the evidence list for one location.

    Ordered by how much it should influence a reader: recurrence first (it is the
    strongest discriminator available), then industrial context, then thermal
    character, then explicit gaps.
    """
    items: list[EvidenceItem] = []

    # --- Recurrence ------------------------------------------------------
    items.append(
        EvidenceItem(
            statement=(
                f"Detected on {stats.distinct_days} distinct "
                f"{'day' if stats.distinct_days == 1 else 'days'} "
                f"across {stats.observation_count} satellite "
                f"{'observation' if stats.observation_count == 1 else 'observations'} "
                f"in a {stats.window_days}-day window."
            ),
            kind="derived",
            values={
                "distinct_days": stats.distinct_days,
                "observation_count": stats.observation_count,
                "window_days": stats.window_days,
            },
            dataset_id="derived_persistence",
        )
    )

    # --- Baseline and deviation ------------------------------------------
    if stats.has_usable_baseline:
        ratio = (
            stats.p90_frp_mw / stats.median_frp_mw if stats.median_frp_mw > 0 else None
        )
        if ratio is not None:
            items.append(
                EvidenceItem(
                    statement=(
                        f"Fire radiative power at this location has a median of "
                        f"{stats.median_frp_mw:.2f} MW; its 90th percentile is "
                        f"{stats.p90_frp_mw:.2f} MW ({ratio:.1f}x the median)."
                    ),
                    kind="derived",
                    values={
                        "median_frp_mw": round(stats.median_frp_mw, 2),
                        "p90_frp_mw": round(stats.p90_frp_mw, 2),
                        "ratio": round(ratio, 2),
                        "mad_frp_mw": round(stats.mad_frp_mw, 2),
                    },
                    dataset_id="derived_persistence",
                )
            )
    else:
        items.append(
            EvidenceItem(
                statement=(
                    f"Only {stats.observation_count} "
                    f"{'observation' if stats.observation_count == 1 else 'observations'} "
                    f"available — too few to establish a baseline, so no deviation "
                    f"ratio is reported."
                ),
                kind="absent",
                values={"observation_count": stats.observation_count},
            )
        )

    # --- Industrial context ----------------------------------------------
    if context.context_coverage != "surveyed":
        items.append(
            EvidenceItem(
                statement=(
                    "Industrial infrastructure around this location has not been "
                    "surveyed yet, so proximity to industry is unknown — this is a "
                    "gap in our coverage, not evidence that none exists."
                ),
                kind="absent",
                values={"context_coverage": context.context_coverage},
            )
        )
    elif context.distance_to_facility_m is not None:
        name = context.nearest_facility_name or "an unnamed mapped facility"
        category = context.nearest_facility_category
        items.append(
            EvidenceItem(
                statement=(
                    f"Nearest mapped industrial feature is {name}"
                    f"{f' ({category})' if category else ''}, "
                    f"{_metres(context.distance_to_facility_m)} away. "
                    f"{context.facilities_within_5km} mapped industrial "
                    f"{'feature' if context.facilities_within_5km == 1 else 'features'} "
                    f"lie within 5 km."
                ),
                kind="observed",
                values={
                    "distance_m": round(context.distance_to_facility_m),
                    "facility_name": context.nearest_facility_name,
                    "facility_category": category,
                    "facilities_within_5km": context.facilities_within_5km,
                },
                dataset_id="osm_industrial",
            )
        )
    else:
        items.append(
            EvidenceItem(
                statement=(
                    "This area was surveyed and no mapped industrial feature was "
                    "found within 10 km. OpenStreetMap coverage is uneven, so an "
                    "unmapped facility would look the same as none."
                ),
                kind="absent",
                values={"search_radius_m": 10000},
                dataset_id="osm_industrial",
            )
        )

    # --- Land context -----------------------------------------------------
    if context.land_cover != "unknown":
        items.append(
            EvidenceItem(
                statement=(
                    f"Nearest mapped land parcel is classified "
                    f"{context.land_cover}. This is approximate — it is the closest "
                    f"parcel centroid within 2 km, not a containment test."
                ),
                kind="observed",
                values={"land_cover": context.land_cover},
                dataset_id="osm_landcover",
            )
        )

    # --- Thermal character ------------------------------------------------
    items.append(
        EvidenceItem(
            statement=(
                f"Median separation between the 4 um and 11 um channels is "
                f"{stats.median_dual_band_k:.1f} K. A larger separation indicates a "
                f"small, very hot source; a smaller one indicates a cooler source "
                f"filling more of the pixel."
            ),
            kind="derived",
            values={"median_dual_band_k": round(stats.median_dual_band_k, 1)},
            dataset_id="derived_persistence",
        )
    )

    if stats.night_fraction in (0.0, 1.0) and stats.observation_count >= 3:
        when = "at night" if stats.night_fraction == 1.0 else "during the day"
        items.append(
            EvidenceItem(
                statement=(
                    f"All {stats.observation_count} observations were recorded "
                    f"{when}."
                ),
                kind="derived",
                values={"night_fraction": stats.night_fraction},
            )
        )

    # --- Why the classifier abstained -------------------------------------
    if decision.label == "unknown":
        failed = [
            c["criterion"]
            for c in decision.rationale
            if c.get("passed") is False and c["criterion"] != "no_rule_matched"
        ]
        items.append(
            EvidenceItem(
                statement=(
                    "Not classified: the available evidence does not satisfy the "
                    "criteria for any class"
                    + (f" (unmet: {', '.join(failed)})." if failed else ".")
                ),
                kind="absent",
                values={"unmet_criteria": failed, "rule_version": decision.rule_version},
            )
        )

    return items


CAUTION = (
    "A thermal anomaly is evidence of unusual heat. It is not proof of a fire, "
    "an accident or an explosion, and satellite data alone cannot confirm one."
)
