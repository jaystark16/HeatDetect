"""Data access and response assembly.

Holds the authority rules that keep inference from masquerading as measurement:

**Rules win.** When a location has enough history for the deterministic criteria
to decide, that decision is authoritative and carries no probability — a
threshold comparison does not have one, and attaching a number like 0.87 to it
would be inventing a statistic.

**The model only fills gaps.** It is consulted solely when the rules abstained
*and* the area has been surveyed. It never overrides a rule verdict.

**A class the model is measurably bad at is not reported.** Suppression is
driven by the model's own recorded held-out precision, not by a hardcoded list:
any class below `MIN_PRECISION_TO_REPORT` is downgraded to `unknown` with the
measured figure recorded in the criteria. In the current model that catches
`industrial_fire` at precision 0.257 — three of four such predictions would be
wrong, which is not a finding worth showing an operator.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Sequence

from sqlalchemy import Select, and_, case, func, select
from sqlalchemy.engine import Connection, Engine

from . import model as ml
from .config import LABEL_RULE_VERSION, settings
from .datasets import CATALOGUE
from .db import (
    cell_context,
    cell_labels,
    cell_stats,
    detections,
    ingest_runs,
)
from .evidence import CAUTION, build_evidence
from .features import CellContextRow, CellStats
from .ingest.osm import cached_tile_keys
from .labels import LabelDecision
from .schemas import (
    Analytics,
    ClassCount,
    Classification,
    DatasetInfo,
    DISPLAY_LABELS,
    EvidenceItem,
    HotspotCollection,
    HotspotDetail,
    HotspotSummary,
    IngestRunInfo,
    ModelInfo,
    Observation,
    Persistence,
    Provenance,
    SpatialContext,
    ThermalClass,
)

logger = logging.getLogger(__name__)

# A dataset that only ever spans 7 days is "live" only if its newest record is
# genuinely recent. Anything older is described as historical, never as live.
LIVE_THRESHOLD_HOURS = 12.0
STALE_THRESHOLD_HOURS = 48.0


# ------------------------------------------------------------ row mapping --


def _stats_from_row(row: Any) -> CellStats:
    return CellStats(
        cell_id=row.cell_id,
        observation_count=row.observation_count,
        distinct_days=row.distinct_days,
        median_frp_mw=row.median_frp_mw,
        p90_frp_mw=row.p90_frp_mw,
        mad_frp_mw=row.mad_frp_mw,
        median_dual_band_k=row.median_dual_band_k,
        night_fraction=row.night_fraction,
        first_seen=_utc(row.first_seen),
        last_seen=_utc(row.last_seen),
        window_days=row.window_days,
    )


def _context_from_row(row: Any) -> CellContextRow:
    return CellContextRow(
        cell_id=row.cell_id,
        nearest_facility_id=row.nearest_facility_id,
        nearest_facility_name=row.nearest_facility_name,
        nearest_facility_category=row.nearest_facility_category,
        distance_to_facility_m=row.distance_to_facility_m,
        facilities_within_5km=row.facilities_within_5km,
        land_cover=row.land_cover,
        context_coverage=row.context_coverage,  # type: ignore[arg-type]
    )


def _utc(value: datetime | None) -> Any:
    """SQLite drops tzinfo; normalise so downstream arithmetic is consistent."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


# -------------------------------------------------------------- provenance --


def get_provenance(conn: Connection) -> Provenance:
    newest, oldest, total = conn.execute(
        select(
            func.max(detections.c.acquired_at),
            func.min(detections.c.acquired_at),
            func.count(),
        ).select_from(detections)
    ).one()

    newest = _utc(newest)
    oldest = _utc(oldest)
    now = datetime.now(timezone.utc)
    age_hours = (now - newest).total_seconds() / 3600 if newest else None

    surveyed, unsurveyed = conn.execute(
        select(
            func.sum(case((cell_context.c.context_coverage == "surveyed", 1), else_=0)),
            func.sum(case((cell_context.c.context_coverage != "surveyed", 1), else_=0)),
        ).select_from(cell_context)
    ).one()

    surveyed = int(surveyed or 0)
    unsurveyed = int(unsurveyed or 0)

    return Provenance(
        data_source="firms_open_archive" if total else "none",
        generated_at=now,
        newest_detection_at=newest,
        oldest_detection_at=oldest,
        age_of_newest_hours=round(age_hours, 1) if age_hours is not None else None,
        is_live=age_hours is not None and age_hours <= LIVE_THRESHOLD_HOURS,
        stale=age_hours is None or age_hours > STALE_THRESHOLD_HOURS,
        surveyed_cells=surveyed,
        unsurveyed_cells=unsurveyed,
        coverage_note=(
            f"{surveyed} of {surveyed + unsurveyed} active cells have surveyed "
            f"industrial context ({len(cached_tile_keys())} OSM tiles cached). "
            f"Unsurveyed cells are reported as unclassified rather than assumed empty."
        )
        if (surveyed + unsurveyed)
        else "No cells analysed yet.",
    )


# ---------------------------------------------------------- classification --


def classify(
    stats: CellStats | None,
    context: CellContextRow | None,
    rule_label: str | None,
    rule_rationale: list[dict] | None,
    trained: ml.TrainedModel | None,
    observation_features: ml.ObservationFeatures | None,
) -> Classification:
    """Decide what to present, and be explicit about where it came from."""
    criteria = list(rule_rationale or [])

    # Rules decided it — authoritative, and deliberately without a probability.
    if rule_label and rule_label != "unknown":
        return Classification(
            label=ThermalClass(rule_label),
            display_label=DISPLAY_LABELS[rule_label],
            source="rule",
            rule_version=LABEL_RULE_VERSION,
            confidence=None,
            abstained=False,
            criteria=criteria,
        )

    surveyed = context is not None and context.context_coverage == "surveyed"

    if trained is not None and observation_features is not None and surveyed:
        prediction = trained.predict(observation_features)
        unreliable = trained.unreliable_classes()

        if prediction.label in unreliable:
            criteria.append(
                {
                    "criterion": "model_class_suppressed",
                    "passed": False,
                    "suppressed_label": prediction.label,
                    "measured_precision": round(unreliable[prediction.label], 3),
                    "minimum_precision": ml.MIN_PRECISION_TO_REPORT,
                    "note": (
                        f"The model predicted {prediction.label}, which is "
                        f"suppressed: its measured held-out precision is "
                        f"{unreliable[prediction.label]:.3f}, below the "
                        f"{ml.MIN_PRECISION_TO_REPORT} minimum required to report "
                        f"a class. Most such predictions would be wrong."
                    ),
                }
            )
            return Classification(
                label=ThermalClass.UNKNOWN,
                display_label=DISPLAY_LABELS["unknown"],
                source="model",
                rule_version=LABEL_RULE_VERSION,
                model_version=trained.model_version,
                confidence=None,
                abstained=True,
                criteria=criteria,
            )

        criteria.append(
            {
                "criterion": "model_consulted",
                "passed": not prediction.abstained,
                "reason": "rules abstained and this location has thin history",
                "top_probability": round(prediction.confidence, 3),
                "abstain_below": ml.ABSTAIN_BELOW,
                "probabilities": {
                    k: round(v, 3) for k, v in prediction.probabilities.items()
                },
            }
        )
        return Classification(
            label=ThermalClass(prediction.label),
            display_label=DISPLAY_LABELS[prediction.label],
            source="model",
            rule_version=LABEL_RULE_VERSION,
            model_version=trained.model_version,
            confidence=None if prediction.abstained else prediction.confidence,
            abstained=prediction.abstained,
            criteria=criteria,
        )

    return Classification(
        label=ThermalClass.UNKNOWN,
        display_label=DISPLAY_LABELS["unknown"],
        source="rule",
        rule_version=LABEL_RULE_VERSION,
        confidence=None,
        abstained=True,
        criteria=criteria,
    )


# -------------------------------------------------------------- listing --


@dataclass
class HotspotFilters:
    label: str | None = None
    min_frp_mw: float | None = None
    within_hours: int | None = None
    bbox: tuple[float, float, float, float] | None = None
    min_distinct_days: int | None = None
    confidence_tier: str | None = None
    limit: int = 500
    offset: int = 0


def _apply_filters(stmt: Select, filters: HotspotFilters) -> Select:
    clauses = []
    if filters.label:
        clauses.append(cell_labels.c.label == filters.label)
    if filters.min_frp_mw is not None:
        clauses.append(detections.c.frp_mw >= filters.min_frp_mw)
    if filters.within_hours is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=filters.within_hours)
        clauses.append(detections.c.acquired_at >= cutoff)
    if filters.min_distinct_days is not None:
        clauses.append(cell_stats.c.distinct_days >= filters.min_distinct_days)
    if filters.confidence_tier:
        clauses.append(detections.c.confidence_tier == filters.confidence_tier)
    if filters.bbox:
        min_lon, min_lat, max_lon, max_lat = filters.bbox
        clauses.append(
            and_(
                detections.c.latitude >= min_lat,
                detections.c.latitude <= max_lat,
                detections.c.longitude >= min_lon,
                detections.c.longitude <= max_lon,
            )
        )
    return stmt.where(and_(*clauses)) if clauses else stmt


def list_hotspots(engine: Engine, filters: HotspotFilters) -> HotspotCollection:
    base = detections.outerjoin(
        cell_stats, detections.c.cell_id == cell_stats.c.cell_id
    ).outerjoin(cell_labels, detections.c.cell_id == cell_labels.c.cell_id)

    with engine.connect() as conn:
        total = conn.execute(
            _apply_filters(select(func.count()).select_from(base), filters)
        ).scalar_one()

        rows = conn.execute(
            _apply_filters(
                select(
                    detections.c.detection_id,
                    detections.c.latitude,
                    detections.c.longitude,
                    detections.c.cell_id,
                    detections.c.acquired_at,
                    detections.c.frp_mw,
                    detections.c.confidence_tier,
                    cell_labels.c.label,
                    cell_stats.c.distinct_days,
                ).select_from(base),
                filters,
            )
            # Strongest signal first: recurring, then energetic, then recent. A
            # truncated page should still contain the most interesting rows.
            .order_by(
                cell_stats.c.distinct_days.desc().nullslast(),
                detections.c.frp_mw.desc(),
                detections.c.acquired_at.desc(),
            )
            .limit(filters.limit)
            .offset(filters.offset)
        ).all()

        provenance = get_provenance(conn)

    summaries = [
        HotspotSummary(
            id=r.detection_id,
            latitude=r.latitude,
            longitude=r.longitude,
            cell_id=r.cell_id,
            acquired_at=_utc(r.acquired_at),
            frp_mw=r.frp_mw,
            confidence_tier=r.confidence_tier,
            label=ThermalClass(r.label or "unknown"),
            distinct_days=r.distinct_days or 0,
        )
        for r in rows
    ]

    return HotspotCollection(
        count=len(summaries),
        total_matching=int(total),
        limit=filters.limit,
        offset=filters.offset,
        hotspots=summaries,
        provenance=provenance,
    )


def get_hotspot_detail(
    engine: Engine, detection_id: str, trained: ml.TrainedModel | None
) -> HotspotDetail | None:
    with engine.connect() as conn:
        row = conn.execute(
            select(detections).where(detections.c.detection_id == detection_id)
        ).one_or_none()
        if row is None:
            return None

        stats_row = conn.execute(
            select(cell_stats).where(cell_stats.c.cell_id == row.cell_id)
        ).one_or_none()
        context_row = conn.execute(
            select(cell_context).where(cell_context.c.cell_id == row.cell_id)
        ).one_or_none()
        label_row = conn.execute(
            select(cell_labels).where(cell_labels.c.cell_id == row.cell_id)
        ).one_or_none()

    stats = _stats_from_row(stats_row) if stats_row else None
    context = _context_from_row(context_row) if context_row else None

    observation = Observation(
        instrument=row.instrument,
        satellite=row.satellite_name,
        brightness_k=row.brightness_k,
        brightness_long_k=row.brightness_long_k,
        dual_band_delta_k=round(row.brightness_k - row.brightness_long_k, 2),
        frp_mw=row.frp_mw,
        confidence_raw=row.confidence_raw,
        confidence_tier=row.confidence_tier,
        day_night=row.day_night,
        scan=row.scan,
        track=row.track,
        dataset_id=row.dataset_id,
    )

    features = (
        ml.ObservationFeatures(
            frp_mw=row.frp_mw,
            brightness_k=row.brightness_k,
            brightness_long_k=row.brightness_long_k,
            scan=row.scan,
            track=row.track,
            day_night=row.day_night,
            confidence_tier=row.confidence_tier,
            instrument=row.instrument,
            latitude=row.latitude,
            longitude=row.longitude,
            distance_to_facility_m=context.distance_to_facility_m if context else None,
            facilities_within_5km=context.facilities_within_5km if context else 0,
            land_cover=context.land_cover if context else "unknown",
        )
        if context
        else None
    )

    classification = classify(
        stats,
        context,
        label_row.label if label_row else None,
        list(label_row.rationale) if label_row and label_row.rationale else None,
        trained,
        features,
    )

    spatial = (
        SpatialContext(
            nearest_facility_name=context.nearest_facility_name,
            nearest_facility_category=context.nearest_facility_category,
            distance_to_facility_m=context.distance_to_facility_m,
            facilities_within_5km=context.facilities_within_5km,
            land_cover=context.land_cover,
            coverage=context.context_coverage,
        )
        if context
        else SpatialContext(coverage="not_surveyed")
    )

    persistence = None
    if stats:
        ratio = (
            round(stats.p90_frp_mw / stats.median_frp_mw, 2)
            if stats.has_usable_baseline and stats.median_frp_mw > 0
            else None
        )
        persistence = Persistence(
            observation_count=stats.observation_count,
            distinct_days=stats.distinct_days,
            window_days=stats.window_days,
            median_frp_mw=round(stats.median_frp_mw, 2),
            p90_frp_mw=round(stats.p90_frp_mw, 2),
            mad_frp_mw=round(stats.mad_frp_mw, 2),
            median_dual_band_k=round(stats.median_dual_band_k, 1),
            night_fraction=round(stats.night_fraction, 2),
            first_seen=stats.first_seen,
            last_seen=stats.last_seen,
            baseline_usable=stats.has_usable_baseline,
            deviation_ratio=ratio,
        )

    evidence: list[EvidenceItem] = []
    if stats and context:
        decision = LabelDecision(
            cell_id=row.cell_id,
            label=classification.label.value,  # type: ignore[arg-type]
            rule_version=LABEL_RULE_VERSION,
            rationale=classification.criteria,
        )
        evidence = [
            EvidenceItem(
                statement=item.statement,
                kind=item.kind,
                values=item.values,
                dataset_id=item.dataset_id,
            )
            for item in build_evidence(stats, context, decision)
        ]

    return HotspotDetail(
        id=row.detection_id,
        latitude=row.latitude,
        longitude=row.longitude,
        cell_id=row.cell_id,
        acquired_at=_utc(row.acquired_at),
        observation=observation,
        persistence=persistence,
        context=spatial,
        classification=classification,
        evidence=evidence,
        caution=CAUTION,
    )


# ------------------------------------------------------------- analytics --


def get_analytics(engine: Engine) -> Analytics:
    with engine.connect() as conn:
        total_detections = conn.execute(
            select(func.count()).select_from(detections)
        ).scalar_one()
        total_cells = conn.execute(
            select(func.count()).select_from(cell_stats)
        ).scalar_one()

        per_class = conn.execute(
            select(cell_labels.c.label, func.count())
            .group_by(cell_labels.c.label)
        ).all()
        cells_by_label = {label: count for label, count in per_class}

        detections_by_label = dict(
            conn.execute(
                select(cell_labels.c.label, func.count())
                .select_from(
                    detections.join(
                        cell_labels, detections.c.cell_id == cell_labels.c.cell_id
                    )
                )
                .group_by(cell_labels.c.label)
            ).all()
        )

        # Alerts are rule-derived only. The model's industrial_fire recall is
        # 0.000, so allowing it to raise an alert would manufacture urgency.
        flagged = conn.execute(
            select(func.count())
            .select_from(cell_labels)
            .where(cell_labels.c.label == "industrial_fire")
        ).scalar_one()

        persistent = conn.execute(
            select(func.count())
            .select_from(cell_stats)
            .where(cell_stats.c.distinct_days >= 4)
        ).scalar_one()

        provenance = get_provenance(conn)

    return Analytics(
        total_detections=int(total_detections),
        total_cells=int(total_cells),
        by_class=[
            ClassCount(
                label=ThermalClass(label),
                display_label=DISPLAY_LABELS[label],
                cells=int(cells_by_label.get(label, 0)),
                detections=int(detections_by_label.get(label, 0)),
            )
            for label in DISPLAY_LABELS
        ],
        flagged_for_investigation=int(flagged),
        persistent_cells=int(persistent),
        provenance=provenance,
    )


def get_datasets() -> list[DatasetInfo]:
    return [
        DatasetInfo(
            id=d.id,
            name=d.name,
            provider=d.provider,
            kind=d.kind.value,
            source_url=d.source_url,
            licence=d.licence,
            update_frequency=d.update_frequency,
            spatial_resolution=d.spatial_resolution,
            fields=list(d.fields),
            limitations=list(d.limitations),
            requires_credentials=d.requires_credentials,
            notes=d.notes,
            citation=d.citation,
        )
        for d in CATALOGUE.values()
    ]


def get_model_info(trained: ml.TrainedModel | None) -> ModelInfo:
    if trained is None:
        return ModelInfo(
            trained=False,
            model_version=None,
            model_type=None,
            label_rule_version=LABEL_RULE_VERSION,
            trained_at=None,
            feature_names=[],
            metrics=ml.load_metrics(),
            caveat=(
                "No model is loaded. Classification falls back to the "
                "deterministic rules, which require multi-day history."
            ),
        )
    return ModelInfo(
        trained=True,
        model_version=trained.model_version,
        model_type=type(trained.estimator).__name__,
        label_rule_version=LABEL_RULE_VERSION,
        trained_at=trained.trained_at,
        feature_names=list(trained.feature_names),
        metrics=trained.metrics,
        caveat=ml.CAVEAT,
    )


# Matches a URL carrying inline credentials, e.g. postgresql://user:pw@host/db.
_CREDENTIAL_URL = re.compile(r"(?P<scheme>[a-z0-9+]+)://[^:/\s]+:[^@/\s]+@")

# Matches long hex runs, the shape of an API key such as a FIRMS MAP_KEY.
_KEY_LIKE = re.compile(r"\b[0-9a-f]{16,}\b", re.IGNORECASE)


def redact(text: str | None, limit: int = 300) -> str | None:
    """Strip credentials from text before it leaves the server.

    `/api/runs` is a public endpoint and ingestion errors are stored verbatim so
    operators can debug them. A database connection failure can carry the full
    connection string — including the password — into that message, so it is
    scrubbed on the way out rather than trusted to be harmless.

    Redacting at the boundary, not at write time, keeps the full text available
    in the database for whoever has legitimate access to it.
    """
    if not text:
        return text
    cleaned = _CREDENTIAL_URL.sub(r"\g<scheme>://***:***@", text)
    cleaned = _KEY_LIKE.sub("***", cleaned)
    return cleaned[:limit]


def get_recent_runs(engine: Engine, limit: int = 25) -> list[IngestRunInfo]:
    with engine.connect() as conn:
        rows = conn.execute(
            select(ingest_runs).order_by(ingest_runs.c.run_id.desc()).limit(limit)
        ).all()
    return [
        IngestRunInfo(
            run_id=r.run_id,
            source=r.source,
            detail=r.detail,
            status=r.status,
            started_at=_utc(r.started_at),
            finished_at=_utc(r.finished_at),
            rows_seen=r.rows_seen,
            rows_accepted=r.rows_accepted,
            rows_rejected=r.rows_rejected,
            rows_inserted=r.rows_inserted,
            reject_reasons=r.reject_reasons,
            error=redact(r.error),
        )
        for r in rows
    ]


def count_detections(engine: Engine) -> int:
    with engine.connect() as conn:
        return int(conn.execute(select(func.count()).select_from(detections)).scalar_one())


def count_labels(engine: Engine) -> int:
    with engine.connect() as conn:
        return int(conn.execute(select(func.count()).select_from(cell_labels)).scalar_one())
