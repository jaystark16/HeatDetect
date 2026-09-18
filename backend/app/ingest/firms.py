"""NASA FIRMS active-fire ingestion.

Uses the openly downloadable regional archives under `/data/active_fire/`, which
need no credentials. (The `/api/` endpoints do require a free MAP_KEY; this
system deliberately avoids depending on one so the pipeline runs for anyone who
clones the repo.)

Two design rules here matter more than the parsing itself:

1. **Rejected rows are counted, never dropped silently.** A malformed feed that
   halves the record count must be visible, not invisible.
2. **VIIRS and MODIS are normalised explicitly**, because their fields are not
   interchangeable — different channels, different resolutions, and a confidence
   field that is categorical in one and numeric in the other. Silently treating
   them as the same would corrupt every downstream feature.
"""

from __future__ import annotations

import csv
import io
import logging
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Final, Literal

import httpx

logger = logging.getLogger(__name__)

USER_AGENT: Final = (
    "HeatDetect/0.1 (SIH26162 prototype; +https://github.com/jaystark16/HeatDetect)"
)

BASE: Final = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"

Instrument = Literal["VIIRS", "MODIS"]
Window = Literal["24h", "7d"]


@dataclass(frozen=True)
class Product:
    """One FIRMS regional file."""

    id: str
    instrument: Instrument
    platform: str
    path_template: str
    dataset_id: str
    """Identifier in `app.datasets.CATALOGUE`."""

    def url(self, window: Window) -> str:
        return f"{BASE}/{self.path_template.format(window=window)}"


# Region is South Asia: the smallest published region that fully covers India.
# Narrowing further happens in application code via a bounding box, so the raw
# fetch stays a single cheap request per product.
PRODUCTS: Final[tuple[Product, ...]] = (
    Product(
        id="snpp",
        instrument="VIIRS",
        platform="Suomi NPP",
        path_template="suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_South_Asia_{window}.csv",
        dataset_id="firms_viirs_snpp",
    ),
    Product(
        id="noaa20",
        instrument="VIIRS",
        platform="NOAA-20",
        path_template="noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_Asia_{window}.csv",
        dataset_id="firms_viirs_snpp",
    ),
    Product(
        id="noaa21",
        instrument="VIIRS",
        platform="NOAA-21",
        path_template="noaa-21-viirs-c2/csv/J2_VIIRS_C2_South_Asia_{window}.csv",
        dataset_id="firms_viirs_snpp",
    ),
    Product(
        id="modis",
        instrument="MODIS",
        platform="Terra/Aqua",
        path_template="modis-c6.1/csv/MODIS_C6_1_South_Asia_{window}.csv",
        dataset_id="firms_modis_c61",
    ),
)

# FIRMS reports the platform per row with short codes. Mapping them here keeps
# the raw code in the database and a readable name in the UI.
SATELLITE_NAMES: Final[dict[str, str]] = {
    "N": "Suomi NPP",
    "N20": "NOAA-20",
    "N21": "NOAA-21",
    "T": "Terra",
    "A": "Aqua",
}

ConfidenceTier = Literal["low", "nominal", "high"]


@dataclass(frozen=True)
class Detection:
    """One normalised thermal anomaly observation.

    Field names avoid FIRMS' instrument-specific column names so that VIIRS and
    MODIS records are directly comparable downstream. `brightness_k` is always
    the ~4 um channel (VIIRS I4 / MODIS band 21-22) and `brightness_long_k`
    always the ~11 um channel (VIIRS I5 / MODIS band 31).
    """

    latitude: float
    longitude: float
    acquired_at: datetime
    instrument: Instrument
    satellite_code: str
    satellite_name: str
    brightness_k: float
    brightness_long_k: float
    frp_mw: float
    confidence_raw: str
    confidence_tier: ConfidenceTier
    day_night: Literal["D", "N"]
    version: str
    scan: float
    track: float
    product_id: str
    dataset_id: str

    @property
    def dual_band_delta_k(self) -> float:
        """Difference between the ~4 um and ~11 um channels.

        This is the physically meaningful discriminator. A small, very hot source
        (gas flare, ~1600-2000 K) radiates strongly at 4 um while contributing
        little to the 11 um channel, giving a large delta. A large, cooler source
        (vegetation fire, ~800-1000 K) fills more of the pixel and raises both
        channels, giving a smaller delta. This is the principle underlying the
        VIIRS Nightfire flare/biomass separation.
        """
        return self.brightness_k - self.brightness_long_k


@dataclass
class FetchResult:
    """Raw bytes plus the provenance needed to defend them later."""

    product: Product
    window: Window
    url: str
    fetched_at: datetime
    body: str
    byte_count: int


@dataclass
class ParseReport:
    """Exact counts. Nothing here is an estimate."""

    rows_seen: int = 0
    accepted: int = 0
    rejected: int = 0
    reject_reasons: Counter[str] = field(default_factory=Counter)

    def reject(self, reason: str) -> None:
        self.rejected += 1
        self.reject_reasons[reason] += 1

    @property
    def acceptance_rate(self) -> float:
        return self.accepted / self.rows_seen if self.rows_seen else 0.0

    def summary(self) -> str:
        if not self.rejected:
            return f"{self.accepted}/{self.rows_seen} rows accepted"
        worst = ", ".join(
            f"{reason}={count}" for reason, count in self.reject_reasons.most_common(3)
        )
        return (
            f"{self.accepted}/{self.rows_seen} rows accepted, "
            f"{self.rejected} rejected ({worst})"
        )


class FirmsUnavailable(RuntimeError):
    """FIRMS could not be reached or returned something unusable.

    Raised rather than returning empty, so a caller cannot mistake a failed
    fetch for a genuine absence of thermal activity.
    """


def fetch(
    product: Product, window: Window = "24h", *, client: httpx.Client | None = None
) -> FetchResult:
    """Download one regional file.

    Raises `FirmsUnavailable` on any failure. An empty result and a failed
    request mean completely different things and must not be conflated.
    """
    url = product.url(window)
    owned = client is None
    client = client or httpx.Client(
        headers={"User-Agent": USER_AGENT}, timeout=httpx.Timeout(120.0), follow_redirects=True
    )
    try:
        response = client.get(url)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise FirmsUnavailable(f"Fetching {url} failed: {exc}") from exc
    finally:
        if owned:
            client.close()

    body = response.text
    if not body.lstrip().lower().startswith("latitude"):
        raise FirmsUnavailable(
            f"{url} did not return a FIRMS CSV header; got "
            f"{body[:80]!r}. Refusing to parse an unrecognised payload."
        )

    return FetchResult(
        product=product,
        window=window,
        url=url,
        fetched_at=datetime.now(timezone.utc),
        body=body,
        byte_count=len(response.content),
    )


def _parse_timestamp(acq_date: str, acq_time: str) -> datetime:
    """FIRMS splits acquisition into a date and an HHMM string, in UTC."""
    padded = acq_time.strip().zfill(4)
    hour, minute = int(padded[:2]), int(padded[2:])
    day = datetime.strptime(acq_date.strip(), "%Y-%m-%d")
    return day.replace(hour=hour, minute=minute, tzinfo=timezone.utc)


def _viirs_confidence_tier(raw: str) -> ConfidenceTier:
    value = raw.strip().lower()
    if value in ("l", "low"):
        return "low"
    if value in ("h", "high"):
        return "high"
    return "nominal"


# MODIS publishes confidence as 0-100 while VIIRS publishes a category. Binning
# the numeric value onto the same three tiers keeps downstream logic uniform.
# These cut points are OUR convention, not NASA's, and are documented as such.
MODIS_LOW_MAX: Final = 30
MODIS_HIGH_MIN: Final = 80


def _modis_confidence_tier(raw: str) -> ConfidenceTier:
    try:
        pct = int(float(raw))
    except ValueError:
        return "nominal"
    if pct < MODIS_LOW_MAX:
        return "low"
    if pct >= MODIS_HIGH_MIN:
        return "high"
    return "nominal"


def parse(result: FetchResult) -> tuple[list[Detection], ParseReport]:
    """Parse a fetched CSV into normalised detections.

    Rows that cannot be parsed are counted by reason. A row is rejected rather
    than coerced: a detection with an unreadable coordinate or FRP is not
    salvageable, and guessing would inject fiction into the dataset.
    """
    report = ParseReport()
    detections: list[Detection] = []
    instrument = result.product.instrument

    reader = csv.DictReader(io.StringIO(result.body))

    for row in reader:
        report.rows_seen += 1
        try:
            latitude = float(row["latitude"])
            longitude = float(row["longitude"])
        except (KeyError, TypeError, ValueError):
            report.reject("unparseable_coordinates")
            continue

        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            report.reject("coordinates_out_of_range")
            continue

        try:
            acquired_at = _parse_timestamp(row["acq_date"], row["acq_time"])
        except (KeyError, TypeError, ValueError):
            report.reject("unparseable_timestamp")
            continue

        # Future timestamps indicate a feed problem; accepting them would make
        # "most recent detection" meaningless.
        if acquired_at > datetime.now(timezone.utc):
            report.reject("timestamp_in_future")
            continue

        try:
            if instrument == "VIIRS":
                brightness_k = float(row["bright_ti4"])
                brightness_long_k = float(row["bright_ti5"])
            else:
                brightness_k = float(row["brightness"])
                brightness_long_k = float(row["bright_t31"])
            frp_mw = float(row["frp"])
        except (KeyError, TypeError, ValueError):
            report.reject("unparseable_thermal_values")
            continue

        # FRP is a radiative power and cannot be negative. Brightness
        # temperatures below ~200 K are non-physical for a detection.
        if frp_mw < 0:
            report.reject("negative_frp")
            continue
        if brightness_k < 200 or brightness_long_k < 200:
            report.reject("implausible_brightness")
            continue

        day_night_raw = (row.get("daynight") or "").strip().upper()
        if day_night_raw not in ("D", "N"):
            report.reject("unknown_daynight")
            continue

        confidence_raw = (row.get("confidence") or "").strip()
        confidence_tier = (
            _viirs_confidence_tier(confidence_raw)
            if instrument == "VIIRS"
            else _modis_confidence_tier(confidence_raw)
        )

        satellite_code = (row.get("satellite") or "").strip()

        detections.append(
            Detection(
                latitude=latitude,
                longitude=longitude,
                acquired_at=acquired_at,
                instrument=instrument,
                satellite_code=satellite_code,
                satellite_name=SATELLITE_NAMES.get(satellite_code, satellite_code or "unknown"),
                brightness_k=brightness_k,
                brightness_long_k=brightness_long_k,
                frp_mw=frp_mw,
                confidence_raw=confidence_raw,
                confidence_tier=confidence_tier,
                day_night=day_night_raw,  # type: ignore[arg-type]
                version=(row.get("version") or "").strip(),
                scan=float(row.get("scan") or 0.0),
                track=float(row.get("track") or 0.0),
                product_id=result.product.id,
                dataset_id=result.product.dataset_id,
            )
        )
        report.accepted += 1

    logger.info(
        "firms.parse product=%s window=%s %s",
        result.product.id,
        result.window,
        report.summary(),
    )
    return detections, report
