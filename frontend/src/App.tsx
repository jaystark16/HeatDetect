import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, api } from "./api";
import DetailPanel from "./components/DetailPanel";
import FilterPanel from "./components/FilterPanel";
import MapView from "./components/MapView";
import StatsBar from "./components/StatsBar";
import type { Analytics, Filters, Hotspot, HotspotCollection } from "./types";

const DEFAULT_FILTERS: Filters = {
  predictedClass: "all",
  minConfidence: 0,
  withinHours: "all",
};

export default function App() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [collection, setCollection] = useState<HotspotCollection | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async (next: Filters) => {
    setLoading(true);
    setError(null);
    try {
      const [hotspots, stats] = await Promise.all([
        api.hotspots(next),
        api.analytics(),
      ]);
      setCollection(hotspots);
      setAnalytics(stats);
      setLastUpdated(new Date());
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : "Unexpected error loading data.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

  const hotspots = collection?.hotspots ?? [];

  const selected = useMemo(
    () => hotspots.find((h) => h.id === selectedId) ?? null,
    [hotspots, selectedId],
  );

  const handleSelect = useCallback((hotspot: Hotspot) => {
    setSelectedId(hotspot.id);
  }, []);

  const isSample = collection?.data_source === "sample";

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar__brand">HeatDetect</span>
        <span className="topbar__sub">
          Industrial fire &amp; persistent thermal source classification
        </span>
        <span className="topbar__spacer" />

        {/* Sample data is labelled in the UI so a demo can never be mistaken
            for live satellite observations. */}
        {collection && (
          <span className={`chip ${isSample ? "chip--sample" : "chip--live"}`}>
            {isSample ? "◆ Sample data" : "● Live FIRMS data"}
          </span>
        )}

        {lastUpdated && (
          <span className="topbar__sub">
            Updated {lastUpdated.toLocaleTimeString()}
          </span>
        )}
      </header>

      {loading && !collection && (
        <div className="banner" style={{ gridArea: "map" }}>
          Loading detections… if the API has been idle it may be starting up,
          which can take up to a minute.
        </div>
      )}

      {error && (
        <div className="banner banner--error" style={{ gridArea: "map" }}>
          {error}
        </div>
      )}

      {!error && collection && (
        <div className="map">
          <MapView
            hotspots={hotspots}
            selectedId={selectedId}
            onSelect={handleSelect}
          />
        </div>
      )}

      <FilterPanel filters={filters} onChange={setFilters} />
      <DetailPanel hotspot={selected} />
      <StatsBar analytics={analytics} shown={hotspots.length} />
    </div>
  );
}
