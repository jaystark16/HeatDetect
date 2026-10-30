"""FIRMS outages: wait them out, then say plainly that the source was unreachable.

On 2026-10-25 and 2026-10-29 every FIRMS request failed at once for several
minutes ("[Errno 101] Network is unreachable") and the next run worked. With one
attempt per product, each blip failed the scheduled refresh. These tests pin the
behaviour that replaced it: retry what could not connect, never wait on a
product that answered with an error, and report a lasting outage with its own
exit code so the workflow can tell it apart from a bug.
"""

from __future__ import annotations

import json
import socket
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import func, select

from app import pipeline
from app.db import detections, ingest_runs
from app.ingest import firms

FAKE_KEY = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"  # pragma: fake-credential

VIIRS_HEADER = (
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,"
    "confidence,version,bright_ti5,frp,daynight"
)
MODIS_HEADER = (
    "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,"
    "confidence,version,bright_t31,frp,daynight"
)


def firms_csv(url: str) -> str:
    """One detection over Jharia in the product's own column layout, dated
    yesterday so the parser's no-future-timestamps rule accepts it. Each product
    gets its own satellite code, as in the real files, so no row is a duplicate."""
    day = (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat()
    lowered = url.lower()
    if "modis" in lowered:
        return f"{MODIS_HEADER}\n23.75512,86.40531,320.50,1.0,1.0,{day},0450,A,72,6.1NRT,295.20,4.80,D\n"
    if "suomi" in lowered or "snpp" in lowered:
        satellite = "N"
    elif "noaa-20" in lowered or "noaa20" in lowered:
        satellite = "N20"
    else:
        satellite = "N21"
    return f"{VIIRS_HEADER}\n23.75512,86.40531,330.15,0.39,0.45,{day},2010,{satellite},nominal,2.0NRT,302.80,2.41,N\n"


class Firms:
    """A FIRMS stand-in. While `down`, every request fails the way both failed
    runs did; URLs containing `gone` answer 404."""

    def __init__(self, *, down: bool = False, gone: str | None = None):
        self.down = down
        self.gone = gone
        self.requests: list[str] = []
        self.waited: list[float] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.requests.append(url)
        if self.down:
            # The exact error both failed runs logged.
            raise httpx.ConnectError("[Errno 101] Network is unreachable", request=request)
        if self.gone and self.gone in url:
            return httpx.Response(404, text="Not Found", request=request)
        return httpx.Response(200, text=firms_csv(url), request=request)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self))

    # Stand-ins for time.sleep: the outage either ends during the wait or not.
    def comes_back_while_waiting(self, seconds: float) -> None:
        self.waited.append(seconds)
        self.down = False

    def stays_down(self, seconds: float) -> None:
        self.waited.append(seconds)


def stored(engine) -> int:
    with engine.connect() as conn:
        return conn.execute(select(func.count()).select_from(detections)).scalar_one()


# ----------------------------------------------------------------- ingest --


def test_a_short_outage_is_waited_out(engine):
    source = Firms(down=True)

    code = pipeline.cmd_ingest(
        engine, "7d", client=source.client(), waits=(60, 180),
        sleep=source.comes_back_while_waiting,
    )

    assert code == 0
    assert source.waited == [60]
    assert stored(engine) == len(firms.PRODUCTS)


def test_an_outage_longer_than_the_retries_is_reported_as_unavailable(engine):
    source = Firms(down=True)

    code = pipeline.cmd_ingest(
        engine, "7d", client=source.client(), waits=(60, 180), sleep=source.stays_down
    )

    assert code == pipeline.EXIT_SOURCE_UNAVAILABLE
    assert source.waited == [60, 180]
    # One request per round: an outage takes every request down at once, so the
    # rest of a round is not spent waiting on connections that will not open.
    assert len(source.requests) == 3
    assert stored(engine) == 0


def test_a_product_that_answers_with_an_error_is_not_waited_for(engine):
    """Suomi NPP stops on 2026-11-02. Its file answering 404 must not add the
    whole retry schedule to every later run."""
    source = Firms(gone="suomi-npp")

    code = pipeline.cmd_ingest(
        engine, "7d", client=source.client(), waits=(60, 180), sleep=source.stays_down
    )

    assert code == 0
    assert source.waited == []
    assert stored(engine) == len(firms.PRODUCTS) - 1
    with engine.connect() as conn:
        statuses = dict(conn.execute(select(ingest_runs.c.detail, ingest_runs.c.status)).all())
    assert statuses["snpp/7d"] == "failed"


def test_every_product_answering_with_errors_is_a_failure_not_an_outage(engine):
    """A changed URL scheme would make every file 404. That is something to fix
    now, so it keeps exit code 1 instead of being waited out as an outage."""
    source = Firms(gone="/data/active_fire/")

    code = pipeline.cmd_ingest(
        engine, "7d", client=source.client(), waits=(60, 180), sleep=source.stays_down
    )

    assert code == 1
    assert source.waited == []


def test_connection_failures_are_marked_retryable_and_answers_are_not():
    product = firms.PRODUCTS[0]

    unreachable = Firms(down=True).client()
    try:
        firms.fetch(product, "7d", client=unreachable)
    except firms.FirmsUnavailable as exc:
        assert exc.retryable
    else:
        raise AssertionError("an unreachable FIRMS must raise")

    not_found = Firms(gone="/data/active_fire/").client()
    try:
        firms.fetch(product, "7d", client=not_found)
    except firms.FirmsUnavailable as exc:
        assert not exc.retryable
    else:
        raise AssertionError("a 404 must raise")


# --------------------------------------------------------------- backfill --


def test_backfill_retries_requests_that_could_not_connect(engine, monkeypatch):
    monkeypatch.setattr(pipeline.settings, "firms_map_key", FAKE_KEY)
    source = Firms(down=True)

    code = pipeline.cmd_backfill(
        engine, 5, None, client=source.client(), waits=(60, 180),
        sleep=source.comes_back_while_waiting,
    )

    assert code == 0
    assert source.waited == [60]
    with engine.connect() as conn:
        failed = conn.execute(
            select(func.count()).select_from(ingest_runs).where(
                ingest_runs.c.source == "firms_backfill", ingest_runs.c.status == "failed"
            )
        ).scalar_one()
        succeeded = conn.execute(
            select(func.count()).select_from(ingest_runs).where(
                ingest_runs.c.source == "firms_backfill", ingest_runs.c.status == "success"
            )
        ).scalar_one()
    # Every planned request came back after the wait; the one refused attempt
    # before it stays on record.
    assert succeeded == len(firms.PRODUCTS)
    assert failed == 1


# --------------------------------------------------------------- site age --


def live(generated_at: str | None, status: int = 200) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        body = {} if generated_at is None else {"generated_at": generated_at}
        return httpx.Response(status, text=json.dumps(body), request=request)

    return httpx.Client(transport=httpx.MockTransport(handler))


NOW = datetime(2026, 10, 30, 12, 0, tzinfo=timezone.utc)
URL = "https://example.invalid/HeatDetect/snapshot.json"


def test_a_recent_live_build_is_fresh():
    built = (NOW - timedelta(hours=5)).isoformat()
    assert pipeline.cmd_site_age(URL, 12, client=live(built), now=NOW) == 0


def test_a_live_build_older_than_the_limit_is_stale():
    built = (NOW - timedelta(hours=13)).isoformat()
    assert pipeline.cmd_site_age(URL, 12, client=live(built), now=NOW) == 1


def test_a_live_site_that_cannot_be_read_counts_as_stale():
    """Not knowing the age must not pass for knowing it is fine."""
    assert pipeline.cmd_site_age(URL, 12, client=live(None), now=NOW) == 1
    assert pipeline.cmd_site_age(URL, 12, client=live("x", status=404), now=NOW) == 1


# -------------------------------------------------------------- diagnosis --


def test_diagnosis_reports_each_address_and_what_happened():
    """The failed runs blamed IPv6, the last address tried, while the IPv4
    attempt before it had hung. The diagnosis lists every address."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        closed_port = probe.getsockname()[1]

    lines = firms.diagnose_connectivity("127.0.0.1", closed_port, timeout=2.0)

    assert len(lines) == 1
    assert lines[0].startswith("127.0.0.1:")
    assert "connected" not in lines[0]
