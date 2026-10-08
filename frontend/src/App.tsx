import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { API_CONFIGURED, api } from "./api";
import type { AskContext } from "./assistant/intents";
import AskPanel from "./components/AskPanel";
import { formatAge, formatDate } from "./components/ProvenanceBar";
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

  const [tab, setTab] = useState<"feed" | "ask">("feed");
  // Every location, independent of the map's filters: the assistant answers
  // about the data, not about whatever the filters currently show.
  const [allMarks, setAllMarks] = useState<MapMark[] | null>(null);

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
    setTab("feed");
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

  // Loaded the first time the Ask tab opens, so visitors who never ask pay
  // nothing; in the static build it reuses the snapshot already in memory.
  useEffect(() => {
    if (tab !== "ask" || allMarks) return;
    void api
      .marks(DEFAULT_FILTERS)
      .then((r) => setAllMarks(r.data.marks))
      .catch(() => setAllMarks(null));
  }, [tab, allMarks]);

  // Freshness is measured from the snapshot itself: a scheduled build only
  // counts as near-real-time while it is demonstrably keeping up.
  const mode: DataMode = fromSnapshot
    ? snapshot?.current
      ? "near_real_time"
      : "cached_snapshot"
    : provenance?.is_live
      ? "live"
      : "historical";

  const askContext = useMemo<AskContext | null>(
    () =>
      allMarks
        ? {
            marks: allMarks,
            analytics,
            model,
            provenance,
            snapshot: fromSnapshot ? snapshot : null,
            mode,
            selected: detail,
            now: Date.now(),
          }
        : null,
    [allMarks, analytics, model, provenance, fromSnapshot, snapshot, mode, detail],
  );

  const builtOn = snapshot ? formatDate(snapshot.builtAt) : null;
  const newestOn = snapshot?.newestDetectionAt ? formatDate(snapshot.newestDetectionAt) : null;

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
          <h1 className="brand__name">HeatDetect</h1>
          <p className="brand__sub">Thermal source monitor</p>
        </div>
        <span className="topbar__spacer" />
        {/* Search needs the facilities table, which the cached snapshot does
            not carry. A permanently disabled box was dead weight in the header,
            so it only appears when it works; the feed notice says why. */}
        {!fromSnapshot && <SearchBox disabled={false} onPick={handleSearchPick} />}
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
          {marks && <BigCount value={hotspots.length} label="shown" />}
        </section>

        <aside className="feed" aria-label="Side panel">
          <div className="tabs">
           <div className="tabs__track" role="tablist" aria-label="Side panel">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "feed"}
              className={`tabs__tab ${tab === "feed" ? "is-active" : ""}`}
              onClick={() => setTab("feed")}
            >
              {selected ? "Location" : "Feed"}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "ask"}
              className={`tabs__tab ${tab === "ask" ? "is-active" : ""}`}
              onClick={() => setTab("ask")}
            >
              Ask
            </button>
           </div>
          </div>

          {/* Kept mounted while hidden, so the conversation survives a look at
              the feed. */}
          <div hidden={tab !== "ask"} className="feed__pane">
            <AskPanel context={askContext} onShow={handleFeedPick} />
          </div>

          {tab === "feed" && (selected ? (
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
                  <h2 className="feed__title">Locations</h2>
                  <span className="feed__sort">Most days seen first</span>
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
                    the legend and totals are for the full set.
                  </div>
                )}
              </div>

              {analytics && (
                <section className="summary" aria-labelledby="summary-title">
                  <h3 className="summary__title" id="summary-title">All ingested data</h3>
                  <ul className="summary__list">
                    <SummaryRow
                      value={byClass.get("industrial_fire") ?? 0}
                      label="Possible industrial fires"
                      tone="industrial_fire"
                    />
                    <SummaryRow
                      value={byClass.get("persistent_industrial") ?? 0}
                      label="Persistent industrial sources"
                      tone="persistent_industrial"
                    />
                    <SummaryRow value={flagged} label="Flagged for review" flag={flagged > 0} />
                  </ul>
                  <p className="summary__note">
                    Counts of locations. The filters above don’t change them.
                  </p>
                </section>
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
          ))}
        </aside>
      </main>
    </div>
  );
}

/** One row of the totals list: the class swatch ties the number to the legend. */
function SummaryRow({
  value,
  label,
  tone,
  flag = false,
}: {
  value: number;
  label: string;
  tone?: "industrial_fire" | "persistent_industrial";
  flag?: boolean;
}) {
  return (
    <li className="summary__row">
      {tone ? (
        <span className={`dot dot--${tone}`} aria-hidden="true" />
      ) : (
        <span className={`summary__flag ${flag ? "is-raised" : ""}`} aria-hidden="true" />
      )}
      <span className="summary__label">{label}</span>
      <span className="summary__value">{value.toLocaleString()}</span>
    </li>
  );
}
