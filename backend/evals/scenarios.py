"""Behavioural evaluation scenarios.

These are not unit tests. Each scenario asserts a **property the whole system
must hold under adverse conditions** — the conditions under which a data
pipeline stops being wrong loudly and starts being wrong quietly.

There is no LLM in this system (docs/adr/0007-no-llm.md), so the usual
prompt-injection and tool-calling scenarios are adapted to their real
equivalents here: hostile field values arriving from third-party data,
unvalidated query parameters, and silent-failure paths.

Run with `python -m evals.run`. Also executed by the test suite, so a
regression fails CI rather than waiting to be noticed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import main as api_main
from app import model as ml
from app.db import (
    build_engine,
    cell_context,
    cell_labels,
    cell_stats,
    detection_id,
    detections,
    facilities,
    ingest_runs,
    init_schema,
    land_parcels,
)
from app.evidence import build_evidence
from app.features import compute_cell_context, compute_cell_stats
from app.geo import cell_id
from app.ingest import firms
from app.labels import assign_label
from app.service import classify

# --------------------------------------------------------------- harness --


@dataclass
class Result:
    name: str
    category: str
    passed: bool
    detail: str
    expectation: str


@dataclass
class Scenario:
    name: str
    category: str
    expectation: str
    run: Callable[["Harness"], tuple[bool, str]]


class Harness:
    """Builds isolated databases and clients for a scenario."""

    def __init__(self, tmp_path) -> None:
        self.tmp_path = tmp_path
        self._counter = 0
        self._engines: list = []

    def engine(self):
        self._counter += 1
        engine = build_engine(
            f"sqlite+pysqlite:///{self.tmp_path / f'eval-{self._counter}.db'}"
        )
        init_schema(engine)
        self._engines.append(engine)
        return engine

    def client(self, engine, model: ml.TrainedModel | None = None) -> TestClient:
        api_main.state.engine = engine
        api_main.state.model = model
        client = TestClient(api_main.app)
        # Enter without lifespan so the injected engine survives.
        return client

    def dispose(self) -> None:
        """Release SQLite file handles.

        Required on Windows: an undisposed engine keeps the database file open,
        and the temporary directory cannot then be removed.
        """
        for engine in self._engines:
            engine.dispose()
        self._engines.clear()

    def add_detection(
        self,
        engine,
        *,
        latitude: float = 23.755,
        longitude: float = 86.405,
        acquired_at: datetime | None = None,
        frp_mw: float = 2.4,
        satellite_code: str = "N21",
        brightness_k: float = 330.0,
        brightness_long_k: float = 303.0,
    ) -> str:
        acquired_at = acquired_at or datetime.now(timezone.utc) - timedelta(hours=3)
        did = detection_id(latitude, longitude, acquired_at, satellite_code, "VIIRS")
        with engine.begin() as conn:
            if conn.execute(
                select(ingest_runs.c.run_id).where(ingest_runs.c.run_id == 1)
            ).one_or_none() is None:
                conn.execute(
                    ingest_runs.insert().values(
                        run_id=1,
                        source="eval",
                        started_at=acquired_at,
                        status="success",
                        rows_seen=0,
                        rows_accepted=0,
                        rows_rejected=0,
                        rows_inserted=0,
                    )
                )
            conn.execute(
                detections.insert().values(
                    detection_id=did,
                    latitude=latitude,
                    longitude=longitude,
                    cell_id=cell_id(latitude, longitude),
                    acquired_at=acquired_at,
                    instrument="VIIRS",
                    satellite_code=satellite_code,
                    satellite_name="NOAA-21",
                    brightness_k=brightness_k,
                    brightness_long_k=brightness_long_k,
                    frp_mw=frp_mw,
                    confidence_raw="nominal",
                    confidence_tier="nominal",
                    day_night="N",
                    version="2.0NRT",
                    scan=0.4,
                    track=0.45,
                    product_id="noaa21",
                    dataset_id="firms_viirs_snpp",
                    ingest_run_id=1,
                )
            )
        return did

    def add_facility(
        self, engine, *, name: str, latitude: float = 23.756, longitude: float = 86.406
    ) -> None:
        with engine.begin() as conn:
            conn.execute(
                facilities.insert().values(
                    facility_id=f"fac-{abs(hash(name)) % 10**8}",
                    osm_type="way",
                    osm_id="1",
                    name=name,
                    category="industrial",
                    source_tag="landuse=industrial",
                    latitude=latitude,
                    longitude=longitude,
                    cell_id=cell_id(latitude, longitude),
                    dataset_id="osm_industrial",
                    fetched_at=datetime.now(timezone.utc),
                )
            )


# ------------------------------------------------------------ scenarios --


def s_normal_request(h: Harness) -> tuple[bool, str]:
    engine = h.engine()
    h.add_detection(engine)
    body = h.client(engine).get("/api/hotspots").json()

    ok = (
        body["count"] == 1
        and body["provenance"]["data_source"] == "firms_open_archive"
        and body["provenance"]["newest_detection_at"] is not None
    )
    return ok, f"count={body['count']} source={body['provenance']['data_source']}"


def s_missing_data(h: Harness) -> tuple[bool, str]:
    """An empty database must degrade with guidance, not crash or pretend."""
    engine = h.engine()
    client = h.client(engine)

    health = client.get("/api/health").json()
    hotspots = client.get("/api/hotspots").json()

    ok = (
        health["status"] == "degraded"
        and bool(health["notes"])
        and hotspots["count"] == 0
        and hotspots["provenance"]["data_source"] == "none"
        and hotspots["provenance"]["is_live"] is False
    )
    return ok, f"status={health['status']} notes={len(health['notes'])}"


def s_incorrect_data(h: Harness) -> tuple[bool, str]:
    """Malformed source rows must be rejected and counted, never coerced."""
    header = (
        "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,"
        "confidence,version,bright_ti5,frp,daynight"
    )
    body = "\n".join(
        [
            header,
            "23.7,86.4,330.1,0.4,0.4,2026-09-17,2010,N21,nominal,2.0NRT,302.8,2.4,N",
            "not-a-lat,86.4,330.1,0.4,0.4,2026-09-17,2010,N21,nominal,2.0NRT,302.8,2.4,N",
            "23.7,86.4,330.1,0.4,0.4,2026-09-17,2010,N21,nominal,2.0NRT,302.8,-9,N",
            "999,86.4,330.1,0.4,0.4,2026-09-17,2010,N21,nominal,2.0NRT,302.8,2.4,N",
        ]
    )
    result = firms.FetchResult(
        product=firms.PRODUCTS[0],
        window="24h",
        url="https://example.invalid",
        fetched_at=datetime.now(timezone.utc),
        body=body,
        byte_count=len(body),
    )
    parsed, report = firms.parse(result)

    ok = (
        len(parsed) == 1
        and report.rejected == 3
        and sum(report.reject_reasons.values()) == 3
    )
    return ok, f"accepted={report.accepted} rejected={report.rejected} reasons={dict(report.reject_reasons)}"


def s_conflicting_data(h: Harness) -> tuple[bool, str]:
    """Two satellites reporting different FRP for one place must not average
    into a fiction. Both are kept, and the robust median resists the outlier."""
    engine = h.engine()
    base = datetime.now(timezone.utc) - timedelta(hours=4)
    for i, (sat, frp) in enumerate(
        [("N", 2.0), ("N20", 2.1), ("N21", 1.9), ("T", 95.0)]
    ):
        h.add_detection(
            engine,
            acquired_at=base + timedelta(minutes=i * 5),
            frp_mw=frp,
            satellite_code=sat,
        )

    stats = compute_cell_stats(engine)[0]
    ok = (
        stats.observation_count == 4
        and 1.9 <= stats.median_frp_mw <= 2.2
        and stats.p90_frp_mw > 20
    )
    return ok, f"n={stats.observation_count} median={stats.median_frp_mw:.2f} p90={stats.p90_frp_mw:.2f}"


def s_stale_data(h: Harness) -> tuple[bool, str]:
    """Week-old data must never be labelled live."""
    engine = h.engine()
    h.add_detection(engine, acquired_at=datetime.now(timezone.utc) - timedelta(days=6))
    provenance = h.client(engine).get("/api/hotspots").json()["provenance"]

    ok = provenance["is_live"] is False and provenance["stale"] is True
    return ok, f"is_live={provenance['is_live']} stale={provenance['stale']} age_h={provenance['age_of_newest_hours']}"


def s_empty_retrieval(h: Harness) -> tuple[bool, str]:
    """Filters matching nothing is a legitimate answer, not an error."""
    engine = h.engine()
    h.add_detection(engine, frp_mw=1.0)
    response = h.client(engine).get("/api/hotspots", params={"min_frp_mw": 500})

    ok = response.status_code == 200 and response.json()["count"] == 0
    return ok, f"http={response.status_code} count={response.json()['count']}"


def s_source_unavailable(h: Harness) -> tuple[bool, str]:
    """A failed fetch must raise, not return an empty list. An empty region and
    an unreachable server mean opposite things."""

    class FailingClient:
        def get(self, _url: str):
            raise httpx.ConnectError("simulated network failure")

        def close(self) -> None:
            return None

    try:
        firms.fetch(firms.PRODUCTS[0], "24h", client=FailingClient())  # type: ignore[arg-type]
    except firms.FirmsUnavailable as exc:
        return True, f"raised FirmsUnavailable: {str(exc)[:60]}"
    return False, "returned normally instead of raising"


def s_source_timeout(h: Harness) -> tuple[bool, str]:
    class TimingOutClient:
        def get(self, _url: str):
            raise httpx.ReadTimeout("simulated timeout")

        def close(self) -> None:
            return None

    try:
        firms.fetch(firms.PRODUCTS[0], "24h", client=TimingOutClient())  # type: ignore[arg-type]
    except firms.FirmsUnavailable:
        return True, "raised FirmsUnavailable on timeout"
    return False, "timeout was swallowed"


def s_failed_run_is_recorded_as_failed(h: Harness) -> tuple[bool, str]:
    """A stage must never report success because it ran."""
    engine = h.engine()
    now = datetime.now(timezone.utc)
    with engine.begin() as conn:
        conn.execute(
            ingest_runs.insert().values(
                source="firms",
                detail="snpp/24h",
                started_at=now,
                finished_at=now,
                status="failed",
                rows_seen=0,
                rows_accepted=0,
                rows_rejected=0,
                rows_inserted=0,
                error="simulated outage",
            )
        )

    runs = h.client(engine).get("/api/runs").json()
    ok = runs[0]["status"] == "failed" and runs[0]["error"] == "simulated outage"
    return ok, f"status={runs[0]['status']} error={runs[0]['error']!r}"


def s_invalid_arguments(h: Harness) -> tuple[bool, str]:
    engine = h.engine()
    client = h.client(engine)
    cases = {
        "bad label": ({"label": "volcano"}, 422),
        "limit over cap": ({"limit": 10**9}, 422),
        "negative frp": ({"min_frp_mw": -5}, 422),
        "bad bbox": ({"bbox": "1,2,3"}, 422),
        "inverted bbox": ({"bbox": "98,6,68,37"}, 422),
        "bad confidence": ({"confidence_tier": "extreme"}, 422),
    }
    failures = []
    for name, (params, expected) in cases.items():
        got = client.get("/api/hotspots", params=params).status_code
        if got != expected:
            failures.append(f"{name}: expected {expected}, got {got}")

    return not failures, "; ".join(failures) or f"all {len(cases)} rejected with 422"


def s_no_fabricated_ratio(h: Harness) -> tuple[bool, str]:
    """A thin baseline must yield no deviation ratio anywhere in the output.
    This is the system's most tempting fabrication: a ratio over two points
    looks authoritative and means nothing."""
    engine = h.engine()
    base = datetime.now(timezone.utc) - timedelta(hours=5)
    for i, frp in enumerate([1.0, 30.0]):
        h.add_detection(
            engine,
            acquired_at=base + timedelta(hours=i),
            frp_mw=frp,
            satellite_code=f"N{i}",
        )
    h.add_facility(engine, name="Test Works")

    stats = compute_cell_stats(engine)[0]
    context = compute_cell_context(engine, [stats.cell_id])[0]
    decision = assign_label(stats, context)
    evidence = build_evidence(stats, context, decision)

    quoted_ratio = any("the median" in item.statement for item in evidence)
    states_absence = any(
        item.kind == "absent" and "too few" in item.statement for item in evidence
    )
    ok = stats.has_usable_baseline is False and not quoted_ratio and states_absence
    return ok, f"baseline_usable={stats.has_usable_baseline} ratio_quoted={quoted_ratio} absence_stated={states_absence}"


def s_unsurveyed_never_claims_proximity(h: Harness) -> tuple[bool, str]:
    """An unsurveyed area must not be treated as having no industry.

    The tile cache is stubbed empty rather than read from disk. Reading the real
    cache made this scenario pass or fail depending on how much coverage had
    been fetched — an eval that changes verdict with unrelated state is not an
    eval.
    """
    engine = h.engine()
    for i in range(8):
        h.add_detection(
            engine,
            acquired_at=datetime.now(timezone.utc) - timedelta(days=i % 6, hours=i),
            satellite_code=f"S{i}",
        )

    from app import features as feat_module  # noqa: PLC0415

    original = feat_module.cached_tile_keys
    feat_module.cached_tile_keys = lambda: set()
    try:
        stats = compute_cell_stats(engine)[0]
        context = compute_cell_context(engine, [stats.cell_id])[0]
    finally:
        feat_module.cached_tile_keys = original

    decision = assign_label(stats, context)
    evidence = build_evidence(stats, context, decision)

    ok = (
        context.context_coverage == "not_surveyed"
        and decision.label == "unknown"
        and any("not been surveyed" in i.statement and i.kind == "absent" for i in evidence)
    )
    return ok, f"coverage={context.context_coverage} label={decision.label}"


def s_hostile_field_values(h: Harness) -> tuple[bool, str]:
    """Third-party field values are data, never markup or code.

    OSM names are edited by anyone. A facility called `<script>...` must be
    carried as an inert string through the API. (React escapes on render; this
    checks the API does not interpret or mangle it.)
    """
    engine = h.engine()
    hostile = "<script>alert('xss')</script> & \"quoted\" ' OR 1=1--"
    did = h.add_detection(engine)
    h.add_facility(engine, name=hostile)

    stats = compute_cell_stats(engine)
    contexts = compute_cell_context(engine, [s.cell_id for s in stats])
    now = datetime.now(timezone.utc)
    with engine.begin() as conn:
        for s, c in zip(stats, contexts):
            conn.execute(
                cell_stats.insert().values(
                    cell_id=s.cell_id,
                    observation_count=s.observation_count,
                    distinct_days=s.distinct_days,
                    median_frp_mw=s.median_frp_mw,
                    p90_frp_mw=s.p90_frp_mw,
                    mad_frp_mw=s.mad_frp_mw,
                    median_dual_band_k=s.median_dual_band_k,
                    night_fraction=s.night_fraction,
                    first_seen=s.first_seen,
                    last_seen=s.last_seen,
                    window_days=s.window_days,
                    computed_at=now,
                    code_version="eval",
                )
            )
            conn.execute(
                cell_context.insert().values(
                    cell_id=c.cell_id,
                    nearest_facility_id=c.nearest_facility_id,
                    nearest_facility_name=c.nearest_facility_name,
                    nearest_facility_category=c.nearest_facility_category,
                    distance_to_facility_m=c.distance_to_facility_m,
                    facilities_within_5km=c.facilities_within_5km,
                    land_cover=c.land_cover,
                    context_coverage=c.context_coverage,
                    computed_at=now,
                    code_version="eval",
                )
            )
            conn.execute(
                cell_labels.insert().values(
                    cell_id=c.cell_id,
                    label="unknown",
                    label_rule_version="rule-v1",
                    rationale=[],
                    computed_at=now,
                )
            )

    body = h.client(engine).get(f"/api/hotspots/{did}").json()
    name = body["context"]["nearest_facility_name"]

    ok = name == hostile and body["classification"]["label"] in {
        "unknown",
        "natural_fire",
        "persistent_industrial",
        "industrial_fire",
    }
    return ok, f"name preserved verbatim={name == hostile}"


def s_sql_injection_in_parameters(h: Harness) -> tuple[bool, str]:
    """Parameters are bound, never interpolated. A drop-table string must be a
    harmless 404 or 422, and the data must survive."""
    engine = h.engine()
    h.add_detection(engine)
    client = h.client(engine)

    payloads = [
        "'; DROP TABLE detections; --",
        "1 OR 1=1",
        "%27%20OR%20%271%27%3D%271",
    ]
    statuses = [
        client.get(f"/api/hotspots/{p}").status_code for p in payloads
    ]

    with engine.connect() as conn:
        surviving = conn.execute(select(detections.c.detection_id)).all()

    ok = all(s in (404, 422) for s in statuses) and len(surviving) == 1
    return ok, f"statuses={statuses} rows_intact={len(surviving)}"


def s_ambiguous_case_abstains(h: Harness) -> tuple[bool, str]:
    """Evidence matching no class must abstain, with the unmet criteria named."""
    engine = h.engine()
    base = datetime.now(timezone.utc) - timedelta(days=2)
    for i in range(6):
        h.add_detection(
            engine, acquired_at=base + timedelta(hours=i * 5), satellite_code=f"A{i}"
        )
    # Placed in the deliberate gap between the thresholds: beyond the 3 km
    # "near industry" criterion but inside the 5 km "far from industry" one, so
    # neither branch may claim it. 0.03 degrees of latitude is ~3.3 km.
    h.add_facility(engine, name="Mid-distance works", latitude=23.785, longitude=86.405)

    stats = compute_cell_stats(engine)[0]
    context = compute_cell_context(engine, [stats.cell_id])[0]
    decision = assign_label(stats, context)

    named = [c["criterion"] for c in decision.rationale if c.get("passed") is False]
    ok = decision.label == "unknown" and bool(named)
    return ok, f"label={decision.label} unmet={named}"


def s_out_of_scope_location(h: Harness) -> tuple[bool, str]:
    """A bbox query outside the data returns nothing rather than the nearest
    thing it can find."""
    engine = h.engine()
    h.add_detection(engine)
    body = h.client(engine).get(
        "/api/hotspots", params={"bbox": "-10,40,5,55"}
    ).json()

    ok = body["count"] == 0 and body["total_matching"] == 0
    return ok, f"count={body['count']}"


def s_untrained_model_claims_nothing(h: Harness) -> tuple[bool, str]:
    """With no model, the API must say so and classification must fall back to
    rules rather than silently emitting a default class."""
    engine = h.engine()
    h.add_detection(engine)
    body = h.client(engine, model=None).get("/api/model-info").json()

    result = classify(None, None, None, None, None, None)
    ok = (
        body["trained"] is False
        and body["model_version"] is None
        and result.abstained is True
        and result.confidence is None
    )
    return ok, f"trained={body['trained']} abstained={result.abstained}"


def s_model_without_metrics_is_distrusted(h: Harness) -> tuple[bool, str]:
    """A model carrying no measured precision must not be used for any class."""

    class Stub:
        classes_ = ["natural_fire"]

        def predict_proba(self, _X):
            return [[0.99]]

    model = ml.TrainedModel(
        estimator=Stub(),
        feature_names=ml.FEATURE_SETS[ml.DEFAULT_FEATURE_SET],
        classes=["natural_fire"],
        model_version="unmeasured",
        trained_at=datetime.now(timezone.utc),
        metrics={},
        feature_set=ml.DEFAULT_FEATURE_SET,
    )
    unreliable = model.unreliable_classes()
    ok = "natural_fire" in unreliable
    return ok, f"unreliable={sorted(unreliable)}"


SCENARIOS: list[Scenario] = [
    Scenario("normal request", "happy path", "Returns data with provenance attached", s_normal_request),
    Scenario("missing data", "empty state", "Degrades with guidance; never claims live data", s_missing_data),
    Scenario("incorrect data", "input validation", "Malformed rows rejected and counted by reason", s_incorrect_data),
    Scenario("conflicting sources", "robustness", "Disagreement kept; median resists the outlier", s_conflicting_data),
    Scenario("stale data", "provenance", "Old data reported historical, never live", s_stale_data),
    Scenario("empty retrieval", "empty state", "No matches is a 200 with zero rows", s_empty_retrieval),
    Scenario("source unreachable", "failure path", "Raises rather than returning an empty list", s_source_unavailable),
    Scenario("source timeout", "failure path", "Timeout surfaces as an explicit failure", s_source_timeout),
    Scenario("failed run recorded", "no false success", "A failed stage is stored as failed", s_failed_run_is_recorded_as_failed),
    Scenario("invalid arguments", "input validation", "All malformed parameters rejected with 422", s_invalid_arguments),
    Scenario("no fabricated ratio", "anti-fabrication", "Thin baseline yields no deviation figure", s_no_fabricated_ratio),
    Scenario("unsurveyed coverage", "anti-fabrication", "Missing survey never becomes 'no industry'", s_unsurveyed_never_claims_proximity),
    Scenario("hostile field values", "injection", "Third-party strings carried inert, not interpreted", s_hostile_field_values),
    Scenario("sql injection", "injection", "Parameters bound; data intact", s_sql_injection_in_parameters),
    Scenario("ambiguous case", "abstention", "Abstains and names the unmet criteria", s_ambiguous_case_abstains),
    Scenario("out-of-scope query", "scope", "Returns nothing rather than a near miss", s_out_of_scope_location),
    Scenario("untrained model", "honesty", "Reports untrained; falls back to rules", s_untrained_model_claims_nothing),
    Scenario("unmeasured model", "honesty", "A model with no metrics is trusted for nothing", s_model_without_metrics_is_distrusted),
]


def run_all(tmp_path) -> list[Result]:
    harness = Harness(tmp_path)
    results: list[Result] = []
    try:
        for scenario in SCENARIOS:
            try:
                passed, detail = scenario.run(harness)
            except Exception as exc:  # noqa: BLE001
                # A scenario that raises is a failure, not a crash of the suite:
                # the remaining scenarios still carry information.
                passed, detail = False, f"raised {type(exc).__name__}: {exc}"
            results.append(
                Result(
                    name=scenario.name,
                    category=scenario.category,
                    passed=passed,
                    detail=detail,
                    expectation=scenario.expectation,
                )
            )
    finally:
        harness.dispose()
    return results
