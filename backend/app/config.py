"""Application settings, loaded from environment / `.env`."""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict

# Bumped whenever feature or label computation changes meaning. Stored alongside
# every derived row so stale derivations are detectable rather than silently
# mixed with current ones.
CODE_VERSION = "0.2.0"

LABEL_RULE_VERSION = "rule-v1"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Optional. The open regional archives need no key; a key would only enable
    # arbitrary bounding boxes and date ranges. See docs/adr/0001.
    firms_map_key: str = ""

    database_url: str = ""

    cors_origins: str = "https://jaystark16.github.io,http://localhost:5173"

    # Analysis bounding box as min_lon,min_lat,max_lon,max_lat.
    # NOTE: this is a rectangle around India, not a national boundary — it also
    # covers parts of Pakistan, Nepal, Bangladesh and Sri Lanka. Surfaced as
    # "analysis area" in the UI rather than "India" for that reason.
    area_bbox: str = "68.0,6.0,98.0,37.5"

    # Detections older than this are excluded from "recent" views. The open
    # archives only span 7 days, so this is an upper bound, not a promise.
    recent_window_hours: int = 72

    # Overpass is a donated community service that rate-limits aggressively
    # (measured: 6 of 12 sequential point queries failed). The pipeline tiles the
    # area, sleeps between requests and caches to disk. Do not lower the delay.
    overpass_url: str = "https://overpass-api.de/api/interpreter"
    overpass_fallback_url: str = "https://overpass.kumi.systems/api/interpreter"
    overpass_delay_seconds: float = 3.0
    overpass_tile_degrees: float = 2.0
    overpass_timeout_seconds: int = 180

    # A cell needs at least this many observations before its baseline is treated
    # as usable. Below it, the system reports "insufficient history" instead of a
    # confident deviation ratio computed from two points.
    min_observations_for_baseline: int = 5

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        parts = [float(p) for p in self.area_bbox.split(",")]
        if len(parts) != 4:
            raise ValueError(
                f"AREA_BBOX must be min_lon,min_lat,max_lon,max_lat; got {self.area_bbox!r}"
            )
        return parts[0], parts[1], parts[2], parts[3]


settings = Settings()
