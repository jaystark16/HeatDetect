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
  HotspotCollection,
  HotspotDetail,
  ModelInfo,
  SearchResponse,
  ThermalClass,
} from "./types";

const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

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

/**
 * Per-class quotas for the map.
 *
 * The API orders by persistence descending, which is right for an operator
 * scanning for recurring sources but wrong for drawing a map. Once the
 * database had accumulated 60 days, the top 4,000 rows all had 30+ distinct
 * days — every one an industrial source — and the map showed **zero** of the
 * 7,433 vegetation-fire locations in the database. The dashboard was implying
 * India's thermal anomalies are overwhelmingly industrial.
 *
 * Quotas are applied here rather than in the API because representativeness is
 * a presentation concern: `/api/hotspots` stays a plain, honest query
 * interface, and `total_matching` keeps meaning what it says.
 */
const CLASS_QUOTAS: Record<ThermalClass, number> = {
  // Rare and operationally important: never truncated in practice.
  industrial_fire: 800,
  persistent_industrial: 1400,
  natural_fire: 1400,
  unknown: 800,
};

function toParams(filters: Filters, limit: number): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.label !== "all") params.set("label", filters.label);
  if (filters.minFrpMw > 0) params.set("min_frp_mw", String(filters.minFrpMw));
  if (filters.minDistinctDays > 0) {
    params.set("min_distinct_days", String(filters.minDistinctDays));
  }
  if (filters.withinHours !== "all") {
    params.set("within_hours", String(filters.withinHours));
  }
  params.set("limit", String(limit));
  return params;
}

/**
 * Fetch a class-balanced set for the map.
 *
 * When the user has already filtered to one class there is nothing to balance,
 * so a single request is made and the quota for that class applies.
 */
async function fetchRepresentative(filters: Filters): Promise<HotspotCollection> {
  if (filters.label !== "all") {
    return get<HotspotCollection>(
      "/api/hotspots",
      toParams(filters, CLASS_QUOTAS[filters.label]),
    );
  }

  const labels = Object.keys(CLASS_QUOTAS) as ThermalClass[];
  const pages = await Promise.all(
    labels.map((label) =>
      get<HotspotCollection>(
        "/api/hotspots",
        toParams({ ...filters, label }, CLASS_QUOTAS[label]),
      ),
    ),
  );

  const hotspots = pages.flatMap((page) => page.hotspots);
  // Most persistent first, so the visually heaviest marks are the informative
  // ones; MapView re-sorts for draw order.
  hotspots.sort(
    (a, b) =>
      b.distinct_days - a.distinct_days ||
      b.frp_mw - a.frp_mw ||
      a.id.localeCompare(b.id),
  );

  return {
    count: hotspots.length,
    // Sum of the per-class totals: the true number of detections matching the
    // user's filters, independent of how many the map draws.
    total_matching: pages.reduce((sum, page) => sum + page.total_matching, 0),
    limit: hotspots.length,
    offset: 0,
    hotspots,
    provenance: pages[0].provenance,
  };
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
async function withFallback<T>(
  live: () => Promise<T>,
  cached: () => Promise<T>,
): Promise<Loaded<T>> {
  try {
    return { data: await live(), fromSnapshot: false, snapshot: null };
  } catch (apiError) {
    try {
      const [data, snapshot] = await Promise.all([cached(), fallbackMeta()]);
      return { data, fromSnapshot: true, snapshot };
    } catch {
      throw apiError;
    }
  }
}

export const api = {
  hotspots: (filters: Filters) =>
    withFallback(
      () => fetchRepresentative(filters),
      () => fallbackHotspots(filters),
    ),

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
    get<SearchResponse>("/api/search", new URLSearchParams({ q }), signal),

  /**
   * Detail for one detection.
   *
   * Resolves to null when neither source has it — the snapshot only carries
   * full detail for the most significant locations, and the UI states that
   * rather than rendering an empty panel.
   */
  detail: async (id: string): Promise<Loaded<HotspotDetail | null>> => {
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
