/**
 * Offline fallback: a cached snapshot of real pipeline output.
 *
 * The static GitHub Pages deployment has no API to talk to, and a venue network
 * can fail during a demo. Rather than showing an error, the dashboard loads
 * `public/snapshot.json` — real NASA FIRMS detections enriched with
 * OpenStreetMap context, exported by `scripts/export_snapshot.py`.
 *
 * Two things this is careful about:
 *
 * 1. **It is fetched lazily, not imported.** Importing the JSON would inline
 *    ~1.8 MiB into the bundle for every visitor, including those whose API is
 *    working fine.
 * 2. **It is never described as live.** The snapshot carries the window it
 *    covers, and the UI labels it as cached with that window shown.
 */

import type {
  Analytics,
  DatasetInfo,
  Filters,
  HotspotCollection,
  HotspotDetail,
  HotspotSummary,
  ModelInfo,
} from "../types";

/** Summaries store an age offset so relative filters stay meaningful. */
type SnapshotSummary = Omit<HotspotSummary, "acquired_at"> & { hours_ago: number };
type SnapshotDetail = Omit<HotspotDetail, "acquired_at"> & { hours_ago: number };

interface Snapshot {
  kind: "cached_snapshot";
  generated_at: string;
  captured_window: {
    oldest_detection_at: string | null;
    newest_detection_at: string | null;
  };
  note: string;
  total_matching: number;
  coverage_note: string;
  surveyed_cells: number;
  unsurveyed_cells: number;
  analytics: Analytics;
  model: ModelInfo;
  datasets: DatasetInfo[];
  summaries: SnapshotSummary[];
  details: Record<string, SnapshotDetail>;
}

let cached: Snapshot | null = null;
let inFlight: Promise<Snapshot> | null = null;

/** Load once per session; concurrent callers share the same request. */
async function load(): Promise<Snapshot> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    // BASE_URL respects the deployment subpath (/HeatDetect/ on Pages).
    const response = await fetch(`${import.meta.env.BASE_URL}snapshot.json`);
    if (!response.ok) {
      throw new Error(`Snapshot unavailable (HTTP ${response.status})`);
    }
    cached = (await response.json()) as Snapshot;
    return cached;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

function hydrateSummary(record: SnapshotSummary, now: number): HotspotSummary {
  const { hours_ago, ...rest } = record;
  return {
    ...rest,
    acquired_at: new Date(now - hours_ago * 3_600_000).toISOString(),
  };
}

export interface FallbackMeta {
  generatedAt: string;
  newestDetectionAt: string | null;
  oldestDetectionAt: string | null;
  coverageNote: string;
  note: string;
  detailCount: number;
  summaryCount: number;
}

export async function fallbackMeta(): Promise<FallbackMeta> {
  const snapshot = await load();
  return {
    generatedAt: snapshot.generated_at,
    newestDetectionAt: snapshot.captured_window.newest_detection_at,
    oldestDetectionAt: snapshot.captured_window.oldest_detection_at,
    coverageNote: snapshot.coverage_note,
    note: snapshot.note,
    detailCount: Object.keys(snapshot.details).length,
    summaryCount: snapshot.summaries.length,
  };
}

/** Mirrors the server-side filtering in `backend/app/service.py`. */
export async function fallbackHotspots(
  filters: Filters,
): Promise<HotspotCollection> {
  const snapshot = await load();
  const now = Date.now();
  let results = snapshot.summaries.map((s) => hydrateSummary(s, now));

  if (filters.label !== "all") {
    results = results.filter((h) => h.label === filters.label);
  }
  if (filters.minFrpMw > 0) {
    results = results.filter((h) => h.frp_mw >= filters.minFrpMw);
  }
  if (filters.minDistinctDays > 0) {
    results = results.filter((h) => h.distinct_days >= filters.minDistinctDays);
  }
  if (filters.withinHours !== "all") {
    const cutoff = now - filters.withinHours * 3_600_000;
    results = results.filter((h) => Date.parse(h.acquired_at) >= cutoff);
  }

  return {
    count: results.length,
    total_matching: results.length,
    limit: results.length,
    offset: 0,
    hotspots: results,
    provenance: {
      data_source: "firms_open_archive",
      generated_at: new Date().toISOString(),
      newest_detection_at: snapshot.captured_window.newest_detection_at,
      oldest_detection_at: snapshot.captured_window.oldest_detection_at,
      age_of_newest_hours: null,
      // A cached file is never live, regardless of how recent it looks.
      is_live: false,
      stale: true,
      surveyed_cells: snapshot.surveyed_cells,
      unsurveyed_cells: snapshot.unsurveyed_cells,
      coverage_note: snapshot.coverage_note,
    },
  };
}

export async function fallbackAnalytics(): Promise<Analytics> {
  return (await load()).analytics;
}

export async function fallbackModelInfo(): Promise<ModelInfo> {
  return (await load()).model;
}

export async function fallbackDatasets(): Promise<DatasetInfo[]> {
  return (await load()).datasets;
}

/**
 * Detail for one detection, if the snapshot carries it.
 *
 * Only the most significant locations have full detail, to keep the file
 * reasonable. Returning null lets the UI say so plainly instead of rendering a
 * half-empty panel that looks like missing data.
 */
export async function fallbackDetail(id: string): Promise<HotspotDetail | null> {
  const snapshot = await load();
  const record = snapshot.details[id];
  if (!record) return null;

  const { hours_ago, ...rest } = record;
  return {
    ...rest,
    acquired_at: new Date(Date.now() - hours_ago * 3_600_000).toISOString(),
  };
}
