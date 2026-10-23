/**
 * Locations as CSV, for "give me all of them". Built from the data's own
 * values, never from model text; each row carries its Google Maps link.
 */

import { CLASS_STYLES } from "./classes";
import { googleMapsUrl } from "./maps";
import type { MapMark } from "./types";

const HEADER = [
  "latitude",
  "longitude",
  "class",
  "state_or_ut",
  "country",
  "near_other_region",
  "distinct_days",
  "peak_frp_mw",
  "satellite_passes",
  "last_seen_utc",
  "google_maps",
];

/** RFC 4180 quoting: wrap in quotes when needed, double any quote inside. */
function cell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function locationsCsv(marks: MapMark[]): string {
  const rows = marks.map((m) =>
    [
      m.latitude.toFixed(5),
      m.longitude.toFixed(5),
      CLASS_STYLES[m.label].shortLabel,
      m.region,
      m.country,
      m.region_alternatives.join("; "),
      m.distinct_days,
      m.frp_mw.toFixed(2),
      m.observation_count,
      m.last_seen,
      googleMapsUrl(m.latitude, m.longitude),
    ]
      .map(cell)
      .join(","),
  );
  return [HEADER.join(","), ...rows].join("\r\n") + "\r\n";
}

/** Hands the visitor the file; nothing leaves the browser. */
export function downloadCsv(marks: MapMark[], name: string): void {
  // The byte-order mark makes Excel read the file as UTF-8.
  const blob = new Blob(["﻿", locationsCsv(marks)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
