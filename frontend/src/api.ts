/**
 * API client with an explicit offline path.
 *
 * `load*` functions try the API and fall back to the cached snapshot, always
 * reporting which one answered. Callers must render that distinction — a cached
 * file is never presented as live data.
 */

import {
  fallbackAnalytics,
  fallbackDatasets,
  fallbackDetail,
  fallbackHotspots,
  fallbackMeta,
  fallbackModelInfo,
  type FallbackMeta,
} from "./fallback";
import type {
  Analytics,
  DatasetInfo,
  Filters,
  HotspotDetail,
  HotspotSummary,
  LocationCollection,
  LocationSummary,
  MapMark,
  ModelInfo,
  Provenance,
  SearchResponse,
} from "./types";

const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

/**
 * Whether there is an API to call at all.
 *
 * In development the Vite proxy forwards `/api`, so an empty base is right. In a
 * production build an empty base means the static deployment, where `/api/...`
 * resolves against github.io and 404s. Probing it anyway cost four failed
 * requests on every page load and put red errors in the console for anyone who
 * opened devtools, all to rediscover that no API exists. So the static build
 * goes straight to the snapshot.
 */
export const API_CONFIGURED = import.meta.env.DEV || BASE !== "";

/**
 * Render's free tier spins services down when idle and the first request after
 * that can take most of a minute. A short timeout would send every cold start
 * to the fallback and hide the real API.
 */
const REQUEST_TIMEOUT_MS = 90_000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function get<T>(
  path: string,
  params?: URLSearchParams,
  signal?: AbortSignal,
): Promise<T> {
  const qs = params && [...params].length ? `?${params}` : "";
  let response: Response;

  try {
    response = await fetch(`${BASE}${path}${qs}`, {
      // A caller-supplied signal wins, so a superseded keystroke can be
      // cancelled; otherwise fall back to the cold-start timeout.
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      throw new ApiError("The API did not respond in time.");
    }
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw new ApiError("Request superseded.");
    }
    throw new ApiError("Could not reach the API.");
  }

  if (!response.ok) {
    throw new ApiError(`API returned ${response.status} for ${path}`, response.status);
  }
  return (await response.json()) as T;
}

function toParams(filters: Filters, limit?: number): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.label !== "all") params.set("label", filters.label);
  if (filters.minFrpMw > 0) params.set("min_frp_mw", String(filters.minFrpMw));
  if (filters.minDistinctDays > 0) {
    params.set("min_distinct_days", String(filters.minDistinctDays));
  }
  if (filters.withinHours !== "all") {
    params.set("within_hours", String(filters.withinHours));
  }
  if (limit !== undefined) params.set("limit", String(limit));
  return params;
}

/**
 * Marks for the map, one per ~1 km cell.
 *
 * `/api/locations` aggregates server-side and returns **every** matching cell,
 * so nothing is sampled and no class can be crowded out. The previous approach
 * fetched detections and deduplicated client-side, which was both wasteful and
 * biased: a recurring source emits one detection per satellite pass, so 3,000
 * detection rows yielded only 23 distinct persistent-industrial locations while
 * vegetation fires — episodic by definition — were squeezed out entirely.
 */
async function fetchMarks(filters: Filters): Promise<MarkCollection> {
  const page = await get<LocationCollection>(
    "/api/locations",
    toParams(filters),
  );
  return {
    marks: page.locations.map(locationToMark),
    totalMatching: page.total_matching,
    provenance: page.provenance,
  };
}

function locationToMark(location: LocationSummary): MapMark {
  return {
    id: location.representative_detection_id,
    cell_id: location.cell_id,
    latitude: location.latitude,
    longitude: location.longitude,
    label: location.label,
    distinct_days: location.distinct_days,
    frp_mw: location.max_frp_mw,
  };
}

/** Collapse cached-snapshot detections to one mark per cell. */
function summariesToMarks(rows: HotspotSummary[]): MapMark[] {
  const best = new Map<string, HotspotSummary>();
  for (const row of rows) {
    const existing = best.get(row.cell_id);
    if (!existing || row.frp_mw > existing.frp_mw) best.set(row.cell_id, row);
  }
  return [...best.values()].map((row) => ({
    id: row.id,
    cell_id: row.cell_id,
    latitude: row.latitude,
    longitude: row.longitude,
    label: row.label,
    distinct_days: row.distinct_days,
    frp_mw: row.frp_mw,
  }));
}

export interface MarkCollection {
  marks: MapMark[];
  totalMatching: number;
  provenance: Provenance;
}

export interface Loaded<T> {
  data: T;
  fromSnapshot: boolean;
  snapshot: FallbackMeta | null;
}

/**
 * Try the API, fall back to the snapshot, and say which answered.
 *
 * A snapshot read that also fails rethrows the original API error: the API being
 * down is the actionable fact, not a secondary failure to read a local file.
 */
async function withFallback<T, A extends unknown[]>(
  live: (...args: A) => Promise<T>,
  cached: (...args: A) => Promise<T>,
  ...args: A
): Promise<Loaded<T>> {
  if (!API_CONFIGURED) {
    const [data, snapshot] = await Promise.all([cached(...args), fallbackMeta()]);
    return { data, fromSnapshot: true, snapshot };
  }
  try {
    return { data: await live(...args), fromSnapshot: false, snapshot: null };
  } catch (apiError) {
    try {
      const [data, snapshot] = await Promise.all([cached(...args), fallbackMeta()]);
      return { data, fromSnapshot: true, snapshot };
    } catch {
      throw apiError;
    }
  }
}

export const api = {
  marks: (filters: Filters) =>
    withFallback(fetchMarks, async () => {
      const page = await fallbackHotspots(filters);
      return {
        marks: summariesToMarks(page.hotspots),
        totalMatching: page.total_matching,
        provenance: page.provenance,
      };
    }, filters),

  analytics: () =>
    withFallback(() => get<Analytics>("/api/analytics"), fallbackAnalytics),

  modelInfo: () => withFallback(() => get<ModelInfo>("/api/model-info"), fallbackModelInfo),

  datasets: () =>
    withFallback(() => get<DatasetInfo[]>("/api/datasets"), fallbackDatasets),

  /**
   * Resolve free text to map locations.
   *
   * No offline fallback: search queries the facilities table, which the cached
   * snapshot does not carry. When the API is down the UI disables the box and
   * says why, rather than silently returning nothing and looking broken.
   */
  search: (q: string, signal?: AbortSignal) =>
    API_CONFIGURED
      ? get<SearchResponse>("/api/search", new URLSearchParams({ q }), signal)
      : Promise.reject(new ApiError("Search needs the API, and none is configured.")),

  /**
   * Detail for one detection.
   *
   * Resolves to null when neither source has it — the snapshot only carries
   * full detail for the most significant locations, and the UI states that
   * rather than rendering an empty panel.
   */
  detail: async (id: string): Promise<Loaded<HotspotDetail | null>> => {
    if (!API_CONFIGURED) {
      const [data, snapshot] = await Promise.all([
        fallbackDetail(id).catch(() => null),
        fallbackMeta().catch(() => null),
      ]);
      return { data, fromSnapshot: true, snapshot };
    }
    try {
      return {
        data: await get<HotspotDetail>(`/api/hotspots/${encodeURIComponent(id)}`),
        fromSnapshot: false,
        snapshot: null,
      };
    } catch {
      const [data, snapshot] = await Promise.all([
        fallbackDetail(id).catch(() => null),
        fallbackMeta().catch(() => null),
      ]);
      return { data, fromSnapshot: true, snapshot };
    }
  },
};
