import { useCallback, useEffect, useRef, useState } from "react";

import { API_CONFIGURED, api } from "./api";
import { formatAge } from "./components/ProvenanceBar";
import type { FallbackMeta } from "./fallback";
import DetailPanel from "./components/DetailPanel";
import FilterPanel, { windowDays } from "./components/FilterPanel";
import LocationFeed from "./components/LocationFeed";
import { BigCount, MapLegend, RegionChip } from "./components/MapOverlays";
import MapView, { type FocusTarget } from "./components/MapView";
import SearchBox from "./components/SearchBox";
import ProvenanceBar from "./components/ProvenanceBar";
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
  const [detailError, setDetailError] = useState<string | null>(null);

  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fromSnapshot, setFromSnapshot] = useState(false);
  const [snapshot, setSnapshot] = useState<FallbackMeta | null>(null);

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
      setSnapshot(marksResult.snapshot);
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
    setDetailError(null);
    setDetailLoading(true);
    try {
      const result = await api.detail(hotspot.id);
      if (token !== detailRequest.current) return;
      setDetail(result.data);
      setDetailUnavailable(result.data === null);
      setDetailFromSnapshot(result.fromSnapshot);
    } catch (cause) {
      if (token !== detailRequest.current) return;
      setDetailError(
        cause instanceof Error ? cause.message : "The detail could not be loaded.",
      );
    } finally {
      if (token === detailRequest.current) setDetailLoading(false);
    }
  }, []);

  const handleFeedPick = useCallback(
    (mark: MapMark) => {
      setFocus({
        latitude: mark.latitude,
        longitude: mark.longitude,
        nonce: Date.now(),
        // Regional rather than street level: enough to see the site and what
        // surrounds it, which is what makes an industrial source legible.
        zoom: 10,
      });
      void handleSelect(mark);
    },
    [handleSelect],
  );

  const handleBack = useCallback(() => {
    // Invalidate any in-flight detail so it cannot reopen the panel.
    detailRequest.current += 1;
    setSelected(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailUnavailable(false);
    setDetailError(null);
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

  // Freshness is measured from the snapshot itself: a scheduled build only
  // counts as near-real-time while it is demonstrably keeping up.
  const mode: DataMode = fromSnapshot
    ? snapshot?.current
      ? "near_real_time"
      : "cached_snapshot"
    : provenance?.is_live
      ? "live"
      : "historical";

  const builtOn = snapshot ? new Date(snapshot.builtAt).toLocaleString() : null;
  const newestOn = snapshot?.newestDetectionAt
    ? new Date(snapshot.newestDetectionAt).toLocaleString()
    : null;

  const hotspots = marks ?? [];
  // Both sources return every matching location, up to the API's response
  // limit. Should a filter ever match more than that, the map says so rather
  // than presenting a cut-off set as complete.
  const truncated = totalMatching > hotspots.length;

  const byClass = new Map(analytics?.by_class.map((c) => [c.label, c.cells]) ?? []);
  const flagged = analytics?.flagged_for_investigation ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand__tile" aria-hidden="true">
            <FlameIcon />
          </div>
          <div className="brand__text">
            <h1 className="brand__name">HeatDetect</h1>
            <p className="brand__sub">India thermal source monitor</p>
          </div>
        </div>
        <span className="topbar__spacer" />
        {/* Search needs the facilities table, which the cached snapshot does
            not carry, so it is disabled with an explanation when offline. */}
        <SearchBox disabled={fromSnapshot} onPick={handleSearchPick} />
        <ProvenanceBar
          provenance={provenance}
          mode={mode}
          datasets={datasets}
          model={model}
          snapshot={fromSnapshot ? snapshot : null}
        />
      </header>

      <main className="workspace">
        <section className="map" aria-label="Map of thermal anomaly locations">
          <MapView
            hotspots={hotspots}
            selectedId={selected?.id ?? null}
            onSelect={handleSelect}
            focus={focus}
          />

          <MapLegend
            analytics={analytics}
            active={filters.label}
            onToggle={(label) => setFilters((f) => ({ ...f, label }))}
          />

          <RegionChip
            detections={analytics?.total_detections ?? null}
            days={windowDays(provenance)}
          />
          {marks && <BigCount value={hotspots.length} label="Locations on map" />}
        </section>

        <aside className="feed" aria-label={selected ? "Location detail" : "Location feed"}>
          {selected ? (
            <DetailPanel
              detail={detail}
              loading={detailLoading}
              fromSnapshot={detailFromSnapshot}
              unavailable={detailUnavailable}
              error={detailError}
              onBack={handleBack}
            />
          ) : (
            <>
              <div className="feed__head">
                <div className="feed__title-row">
                  <h2 className="feed__title">Thermal source feed</h2>
                  <span className="feed__sort">by days seen</span>
                </div>
                <FilterPanel filters={filters} analytics={analytics} onChange={setFilters} />
              </div>

              <div className="notices">
                {loading && !marks && (
                  <div className="notice notice--info">
                    {API_CONFIGURED
                      ? "Loading detections… if the API has been idle it may be starting up, which can take up to a minute."
                      : "Loading detections…"}
                  </div>
                )}

                {error && <div className="notice notice--error">{error}</div>}

                {/* Worded for what actually happened. A static deployment has no API
                    by design; telling its visitors "API unreachable" described a
                    failure that was not occurring. */}
                {fromSnapshot && !error && snapshot && (
                  <div
                    className={`notice ${
                      mode === "near_real_time" ? "notice--info" : ""
                    }`}
                  >
                    {!API_CONFIGURED && mode === "near_real_time" &&
                      `Static deployment, rebuilt from NASA FIRMS every ${snapshot.cadenceHours} h. ` +
                        (snapshot.detailCount >= snapshot.locationCount
                          ? "Every location opens its full evidence; search needs the API."
                          : "Search, and full detail for every location, need the API.")}
                    {/* Current-ness is judged from the newest detection, with the
                        same 48-hour line the API uses. A one-off build made minutes ago
                        holds today's data; calling it "not current" was wrong. */}
                    {!API_CONFIGURED && mode !== "near_real_time" &&
                      (snapshot.scheduled
                        ? `Scheduled refresh has fallen behind: this data was last rebuilt ${formatAge(snapshot.buildAgeHours)} ago.`
                        : `One-off build from ${formatAge(snapshot.buildAgeHours)} ago that does not refresh itself` +
                          (snapshot.newestAgeHours != null && snapshot.newestAgeHours > 48
                            ? `; its newest detection is ${formatAge(snapshot.newestAgeHours)} old, so it is no longer current.`
                            : "."))}
                    {API_CONFIGURED &&
                      `API unreachable — showing the last snapshot, built ${builtOn}` +
                        (snapshot.newestAgeHours != null && snapshot.newestAgeHours > 48
                          ? `; its newest detection is ${formatAge(snapshot.newestAgeHours)} old.`
                          : ".")}
                  </div>
                )}

                {!loading && marks && hotspots.length === 0 && !error && (
                  <div className="notice">
                    {fromSnapshot &&
                    filters.withinHours !== "all" &&
                    snapshot?.newestAgeHours != null &&
                    snapshot.newestAgeHours > filters.withinHours
                      ? `No detections in the last ${filters.withinHours} hours. The newest detection in this data is from ${newestOn}, ${formatAge(snapshot.newestAgeHours)} ago.`
                      : "No detections match these filters. Narrow time ranges can legitimately be empty."}
                  </div>
                )}

                {/* Saying so is the difference between a readable map and a
                    misleading one. */}
                {!loading && truncated && !error && (
                  <div className="notice notice--info">
                    Showing {hotspots.length.toLocaleString()} of{" "}
                    {totalMatching.toLocaleString()} matching locations, the most
                    persistent first; the response limit cut off the rest. Totals in
                    the legend and tiles are for the full set.
                  </div>
                )}
              </div>

              {analytics && (
                <div className="tiles" aria-label="Totals across all ingested data">
                  <Tile
                    value={byClass.get("industrial_fire") ?? 0}
                    label="Possible industrial fires"
                    tone="industrial_fire"
                  />
                  <Tile
                    value={byClass.get("persistent_industrial") ?? 0}
                    label="Persistent sources"
                    tone="persistent_industrial"
                  />
                  <Tile
                    value={flagged}
                    label={flagged > 0 ? "⚠ Flagged for review" : "Flagged for review"}
                  />
                  <p className="tiles__note">
                    Locations across all ingested data, independent of the filters above.
                  </p>
                </div>
              )}

              <div className="feed__body">
                {marks && (
                  <LocationFeed
                    marks={hotspots}
                    selectedId={null}
                    onSelect={handleFeedPick}
                  />
                )}
              </div>
            </>
          )}
        </aside>
      </main>
    </div>
  );
}

function Tile({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: "industrial_fire" | "persistent_industrial";
}) {
  return (
    <div className="tile">
      <div className={`tile__value ${tone ? `tile__value--${tone}` : ""}`}>
        {value.toLocaleString()}
      </div>
      <div className="tile__label">{label}</div>
    </div>
  );
}

function FlameIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}
