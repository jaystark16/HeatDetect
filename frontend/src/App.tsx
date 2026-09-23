import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api";
import DetailPanel from "./components/DetailPanel";
import FilterPanel from "./components/FilterPanel";
import MapView, { type FocusTarget } from "./components/MapView";
import SearchBox from "./components/SearchBox";
import ProvenanceBar from "./components/ProvenanceBar";
import StatsBar from "./components/StatsBar";
import type {
  Analytics,
  DataMode,
  DatasetInfo,
  Filters,
  HotspotDetail,
  MapMark,
  ModelInfo,
  Provenance,
  SearchMatch,
} from "./types";

const DEFAULT_FILTERS: Filters = {
  label: "all",
  minFrpMw: 0,
  minDistinctDays: 0,
  withinHours: "all",
};

export default function App() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [marks, setMarks] = useState<MapMark[] | null>(null);
  const [totalMatching, setTotalMatching] = useState(0);
  const [markProvenance, setMarkProvenance] = useState<Provenance | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [model, setModel] = useState<ModelInfo | null>(null);

  const [selected, setSelected] = useState<MapMark | null>(null);
  const [detail, setDetail] = useState<HotspotDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailUnavailable, setDetailUnavailable] = useState(false);
  const [detailFromSnapshot, setDetailFromSnapshot] = useState(false);

  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fromSnapshot, setFromSnapshot] = useState(false);
  const [snapshotWindow, setSnapshotWindow] = useState<{
    oldest: string | null;
    newest: string | null;
  } | null>(null);

  // Load metadata once; it does not depend on filters.
  useEffect(() => {
    void (async () => {
      const [datasetResult, modelResult] = await Promise.allSettled([
        api.datasets(),
        api.modelInfo(),
      ]);
      if (datasetResult.status === "fulfilled") setDatasets(datasetResult.value.data);
      if (modelResult.status === "fulfilled") setModel(modelResult.value.data);
    })();
  }, []);

  const load = useCallback(async (next: Filters) => {
    setLoading(true);
    setError(null);
    try {
      const [marksResult, stats] = await Promise.all([
        api.marks(next),
        api.analytics(),
      ]);
      setMarks(marksResult.data.marks);
      setTotalMatching(marksResult.data.totalMatching);
      setMarkProvenance(marksResult.data.provenance);
      setAnalytics(stats.data);
      setFromSnapshot(marksResult.fromSnapshot);
      setSnapshotWindow(
        marksResult.snapshot
          ? {
              oldest: marksResult.snapshot.oldestDetectionAt,
              newest: marksResult.snapshot.newestDetectionAt,
            }
          : null,
      );
    } catch (cause) {
      // Both the API and the snapshot failed. Showing an error is correct here —
      // there is no data, and inventing a placeholder would be worse than saying so.
      setError(
        cause instanceof Error
          ? `${cause.message} The cached snapshot could not be loaded either.`
          : "Unexpected error loading data.",
      );
      setMarks(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

  // Guards against a slow earlier request overwriting a newer selection's detail.
  const detailRequest = useRef(0);

  const handleSelect = useCallback(async (hotspot: MapMark) => {
    const token = ++detailRequest.current;
    setSelected(hotspot);
    setDetail(null);
    setDetailUnavailable(false);
    setDetailLoading(true);
    try {
      const result = await api.detail(hotspot.id);
      if (token !== detailRequest.current) return;
      setDetail(result.data);
      setDetailUnavailable(result.data === null);
      setDetailFromSnapshot(result.fromSnapshot);
    } finally {
      if (token === detailRequest.current) setDetailLoading(false);
    }
  }, []);

  // The nonce makes repeat picks of the same result re-trigger the fly-to.
  const handleSearchPick = useCallback((match: SearchMatch) => {
    setFocus({
      latitude: match.latitude,
      longitude: match.longitude,
      nonce: Date.now(),
    });
  }, []);

  const provenance = markProvenance ?? analytics?.provenance ?? null;

  const mode: DataMode = fromSnapshot
    ? "cached_snapshot"
    : provenance?.is_live
      ? "live"
      : "historical";

  const hotspots = marks ?? [];
  // /api/locations returns every matching cell, so the map is complete.
  // Only the cached snapshot is ever a subset.
  const truncated = fromSnapshot && totalMatching > hotspots.length;

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar__brand">HeatDetect</span>
        <span className="topbar__sub topbar__sub--tagline">
          Industrial fire &amp; persistent thermal source classification
        </span>
        <span className="topbar__spacer" />
        {/* Search needs the facilities table, which the cached snapshot does
            not carry, so it is disabled with an explanation when offline. */}
        <SearchBox disabled={fromSnapshot} onPick={handleSearchPick} />
        <ProvenanceBar
          provenance={provenance}
          mode={mode}
          datasets={datasets}
          model={model}
          snapshotWindow={snapshotWindow}
        />
      </header>

      <FilterPanel filters={filters} analytics={analytics} onChange={setFilters} />

      <div className="map">
        {loading && !marks && (
          <div className="map__notice">
            Loading detections… if the API has been idle it may be starting up,
            which can take up to a minute.
          </div>
        )}

        {error && <div className="map__notice map__notice--error">{error}</div>}

        {fromSnapshot && !error && (
          <div className="map__notice">
            API unreachable — showing a cached snapshot of real FIRMS data. Not
            live.
          </div>
        )}

        {!loading && marks && hotspots.length === 0 && !error && (
          <div className="map__notice">
            No detections match these filters. Narrow time ranges can
            legitimately be empty.
          </div>
        )}

        {/* The map draws a class-balanced sample, not everything. Saying so is
            the difference between a readable map and a misleading one. */}
        {!loading && truncated && !error && (
          <div className="map__notice">
            Cached snapshot: showing {hotspots.length.toLocaleString()}{" "}
            locations from {totalMatching.toLocaleString()} recorded detections.
            Counts in the panels below are for the full set.
          </div>
        )}

        <MapView
          hotspots={hotspots}
          selectedId={selected?.id ?? null}
          onSelect={handleSelect}
          focus={focus}
        />
      </div>

      <DetailPanel
        detail={detail}
        loading={detailLoading}
        fromSnapshot={detailFromSnapshot}
        unavailable={detailUnavailable}
      />

      <StatsBar
        analytics={analytics}
        shown={hotspots.length}
        totalMatching={totalMatching}
      />
    </div>
  );
}
