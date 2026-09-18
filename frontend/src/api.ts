/**
 * API client.
 *
 * In development the Vite proxy forwards `/api` to the local FastAPI server, so
 * `VITE_API_BASE` stays empty. In production it is set to the Render service URL
 * at build time.
 */

import type { Analytics, Filters, Health, HotspotCollection } from "./types";

const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

/**
 * Render's free tier spins services down when idle, and the first request after
 * that can take the better part of a minute. A long timeout plus an explicit
 * "waking" state in the UI is the difference between a slow demo and one that
 * looks broken.
 */
const COLD_START_TIMEOUT_MS = 90_000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function get<T>(path: string, params?: URLSearchParams): Promise<T> {
  const qs = params && [...params].length ? `?${params}` : "";
  const url = `${BASE}${path}${qs}`;

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(COLD_START_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      throw new ApiError(
        "The API did not respond in time. If it was idle it may still be starting up.",
      );
    }
    throw new ApiError("Could not reach the API. Is the backend running?");
  }

  if (!response.ok) {
    throw new ApiError(
      `API returned ${response.status} for ${path}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

function filtersToParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.predictedClass !== "all") {
    params.set("predicted_class", filters.predictedClass);
  }
  if (filters.minConfidence > 0) {
    params.set("min_confidence", String(filters.minConfidence));
  }
  if (filters.withinHours !== "all") {
    params.set("within_hours", String(filters.withinHours));
  }
  return params;
}

export const api = {
  health: () => get<Health>("/api/health"),
  hotspots: (filters: Filters) =>
    get<HotspotCollection>("/api/hotspots", filtersToParams(filters)),
  analytics: () => get<Analytics>("/api/analytics"),
};
