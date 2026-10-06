/**
 * Snapshot data path: real pipeline output served as a static file.
 *
 * The GitHub Pages deployment has no API. It loads `public/snapshot.json` —
 * real NASA FIRMS detections enriched with OpenStreetMap context, exported by
 * `scripts/export_snapshot.py`. The Pages workflow rebuilds that file from FIRMS
 * on a schedule; the copy committed to the repository is a manual build used for
 * local development and as a last resort.
 *
 * Three things this is careful about:
 *
 * 1. **Timestamps are the true acquisition times.** An earlier version rebuilt
 *    each one as "now minus its age at export", which shifted every detection
 *    forward by the age of the file — on a 13-day-old snapshot, a detection from
 *    19 September displayed as 2 October, after the data window had ended.
 * 2. **Freshness is measured, not assumed.** `freshness()` reports when the file
 *    was built and whether anything rebuilds it, and the page labels itself from
 *    that. A scheduled build that silently stops falls back to "cached snapshot"
 *    on its own.
 * 3. **It is fetched lazily, not imported.** Importing the JSON would inline
 *    ~5 MiB into the bundle for every visitor.
 *
 * It carries **every location** (one row per ~1 km cell, as `/api/locations`
 * serves), so the offline map is complete rather than a sample. Full detail is
 * carried for a subset only.
 */

import type {
  Analytics,
  DatasetInfo,
  Filters,
  HotspotDetail,
  LocationCollection,
  LocationSummary,
  ModelInfo,
} from "../types";

interface SnapshotRefresh {
  scheduled: boolean;
  cadence_hours: number | null;
  built_by: string;
}

interface Snapshot {
  kind: "cached_snapshot";
  generated_at: string;
  captured_window: {
    oldest_detection_at: string | null;
    newest_detection_at: string | null;
  };
  note: string;
  /** Absent from snapshots built before refresh metadata existed. */
  refresh?: SnapshotRefresh;
  total_locations: number;
  coverage_note: string;
  surveyed_cells: number;
  unsurveyed_cells: number;
  analytics: Analytics;
  model: ModelInfo;
  datasets: DatasetInfo[];
  locations: LocationSummary[];
  /** Inlined for a subset, so a checkout without the detail files still works. */
  details: Record<string, HotspotDetail>;
  /** One file per location, built alongside the snapshot; null if not built. */
  detail_files?: { count: number; path: string } | null;
}

let cached: Snapshot | null = null;
let inFlight: Promise<Snapshot> | null = null;

/** Load once per session; concurrent callers share the same request. */
async function load(): Promise<Snapshot> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    // BASE_URL respects the deployment subpath (/HeatDetect/ on Pages).
    const response = await fetch(`${import.meta.env.BASE_URL}snapshot.json`, {
      // The scheduled rebuild replaces this file every few hours; a cached copy
      // from the browser's HTTP cache would quietly show older data.
      cache: "no-cache",
    });
    if (!response.ok) {
      throw new Error(`Snapshot unavailable (HTTP ${response.status})`);
    }
    const parsed = (await response.json()) as Snapshot;

    // Refuse retired formats rather than misread them: detection rows sampled
    // by quota (which hid most industrial locations), and before that rows
    // carrying `hours_ago` instead of a real timestamp.
    if (!Array.isArray(parsed.locations)) {
      throw new Error(
        "Snapshot uses a retired format; rebuild it with scripts/export_snapshot.py.",
      );
    }
    cached = parsed;
    return cached;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

const HOUR_MS = 3_600_000;

function hoursSince(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now - t) / HOUR_MS) : null;
}

export interface SnapshotFreshness {
  builtAt: string;
  buildAgeHours: number;
  newestDetectionAt: string | null;
  newestAgeHours: number | null;
  oldestDetectionAt: string | null;
  scheduled: boolean;
  cadenceHours: number | null;
  /**
   * True only while a scheduled rebuild is demonstrably keeping up.
   *
   * Judged on when the file was built, not on the newest detection: satellites
   * do not observe continuously, so an up-to-date build can still have a newest
   * detection several hours old during an overpass gap. One missed run is
   * tolerated; two are not.
   */
  current: boolean;
}

export interface FallbackMeta extends SnapshotFreshness {
  coverageNote: string;
  note: string;
  /** Locations whose full detail can be opened from this build. */
  detailCount: number;
  locationCount: number;
}

function freshness(snapshot: Snapshot): SnapshotFreshness {
  const buildAgeHours = hoursSince(snapshot.generated_at) ?? Number.POSITIVE_INFINITY;
  const refresh = snapshot.refresh;
  const scheduled = Boolean(refresh?.scheduled);
  const cadenceHours = refresh?.cadence_hours ?? null;

  return {
    builtAt: snapshot.generated_at,
    buildAgeHours,
    newestDetectionAt: snapshot.captured_window.newest_detection_at,
    newestAgeHours: hoursSince(snapshot.captured_window.newest_detection_at),
    oldestDetectionAt: snapshot.captured_window.oldest_detection_at,
    scheduled,
    cadenceHours,
    current:
      scheduled && cadenceHours !== null && buildAgeHours <= cadenceHours * 2 + 1,
  };
}

export async function fallbackMeta(): Promise<FallbackMeta> {
  const snapshot = await load();
  return {
    ...freshness(snapshot),
    coverageNote: snapshot.coverage_note,
    note: snapshot.note,
    detailCount: snapshot.detail_files?.count ?? Object.keys(snapshot.details).length,
    locationCount: snapshot.locations.length,
  };
}

/** Mirrors `list_locations` in `backend/app/service.py`, filter for filter. */
export async function fallbackLocations(
  filters: Filters,
): Promise<LocationCollection> {
  const snapshot = await load();
  let results = snapshot.locations;

  if (filters.label !== "all") {
    results = results.filter((l) => l.label === filters.label);
  }
  if (filters.minFrpMw > 0) {
    results = results.filter((l) => l.max_frp_mw >= filters.minFrpMw);
  }
  if (filters.minDistinctDays > 0) {
    results = results.filter((l) => l.distinct_days >= filters.minDistinctDays);
  }
  if (filters.withinHours !== "all") {
    // Against the real clock. If the snapshot is old, "last 24 hours" is
    // honestly empty — which the page explains — rather than quietly filled
    // with locations from the snapshot's own last day.
    const cutoff = Date.now() - filters.withinHours * HOUR_MS;
    results = results.filter((l) => Date.parse(l.last_seen) >= cutoff);
  }

  const fresh = freshness(snapshot);
  const age = fresh.newestAgeHours;

  return {
    count: results.length,
    total_matching: results.length,
    limit: results.length,
    locations: results,
    provenance: {
      data_source: "firms_open_archive",
      generated_at: snapshot.generated_at,
      newest_detection_at: fresh.newestDetectionAt,
      oldest_detection_at: fresh.oldestDetectionAt,
      age_of_newest_hours: age === null ? null : Math.round(age * 10) / 10,
      // A file is never a live query, however recently it was built.
      is_live: false,
      // Same 48-hour line the API uses.
      stale: age === null || age > 48,
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

/** Detection ids are SHA-1 hex; anything else is not ours to put in a URL. */
const DETECTION_ID = /^[0-9a-f]{40}$/;

/**
 * Detail for one location, from the build that produced this snapshot.
 *
 * Each location's detail is its own small file, fetched only when clicked, so
 * every mark opens real evidence without the page downloading 60 MiB up front.
 * Resolves to null when this build has no detail for it, which the UI states
 * plainly rather than rendering a half-empty panel.
 */
export async function fallbackDetail(id: string): Promise<HotspotDetail | null> {
  const snapshot = await load();
  const inlined = snapshot.details[id];
  if (inlined) return inlined;

  const files = snapshot.detail_files;
  if (!files || !DETECTION_ID.test(id)) return null;

  const url =
    import.meta.env.BASE_URL +
    files.path.replace("{prefix}", id.slice(0, 2)).replace("{id}", id);
  // Revalidated, not blindly cached: the scheduled build replaces these files.
  const response = await fetch(url, { cache: "no-cache" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Detail unavailable (HTTP ${response.status})`);

  const detail = (await response.json()) as HotspotDetail;
  // A file that answers for a different detection is a build fault, not data.
  return detail.id === id ? detail : null;
}
