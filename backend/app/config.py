"""Application settings, loaded from environment / `.env`."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    firms_map_key: str = ""
    database_url: str = ""
    cors_origins: str = "http://localhost:5173"
    area_bbox: str = "68.0,6.0,98.0,37.5"
    firms_day_range: int = 3

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def using_sample_data(self) -> bool:
        """Phase 0 mode: no FIRMS key yet, so the API serves seeded samples.

        This is also the offline fallback for the live demo — if the venue
        network fails, the dashboard still has data to show.
        """
        return not self.firms_map_key


settings = Settings()
