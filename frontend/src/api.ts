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

function toParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.label !== "all") params.set("label", filters.label);
  if (filters.minFrpMw > 0) params.set("min_frp_mw", String(filters.minFrpMw));
  if (filters.minDistinctDays > 0) {
    params.set("min_distinct_days", String(filters.minDistinctDays));
  }
  if (filters.withinHours !== "all") {
    params.set("within_hours", String(filters.withinHours));
  }
  params.set("limit", "4000");
  return params;
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
      () => get<HotspotCollection>("/api/hotspots", toParams(filters)),
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
