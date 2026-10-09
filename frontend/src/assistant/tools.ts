/**
 * Tools Gemini can call to look things up in the full data.
 *
 * The briefing is a summary; questions are not limited to it. When Gemini
 * needs something specific — one class in one region, a time window, the
 * locations near a point, one location's full evidence — it calls one of
 * these, and code answers over every loaded location. Each result comes back
 * as numbered facts that Gemini must cite, exactly like the briefing's, so the
 * citation check (verify.ts) covers looked-up answers too.
 *
 * Gemini may name a place and give its own approximate box for it ("Gujarat").
 * The box is a guess from general knowledge, not data, and every fact built
 * from it says so; the place name then appears in a cited fact only alongside
 * that disclaimer.
 */

import type { HotspotDetail, MapMark, ThermalClass } from "../types";
import { age, coordinates, haversineKm, type AskContext } from "./intents";

const HOUR_MS = 3_600_000;
const MAX_ROWS = 25;
const DETAIL_RADIUS_KM = 3;

export interface ToolFact {
  text: string;
  mark?: MapMark;
}

export interface ToolRun {
  name: string;
  /** Plain words for the page: what was looked up. */
  summary: string;
  facts: ToolFact[];
}

const CLASSES: ThermalClass[] = ["industrial_fire", "persistent_industrial", "natural_fire", "unknown"];

const NOUN: Record<ThermalClass, [string, string]> = {
  industrial_fire: ["possible industrial fire", "possible industrial fires"],
  persistent_industrial: ["persistent industrial source", "persistent industrial sources"],
  natural_fire: ["probable vegetation fire", "probable vegetation fires"],
  unknown: ["unclassified location", "unclassified locations"],
};

const AREA = {
  type: "OBJECT",
  description:
    "A latitude/longitude box. If the user named a place, give your best approximate box for it and its name; it is reported as an approximation, not a boundary.",
  properties: {
    south: { type: "NUMBER" },
    west: { type: "NUMBER" },
    north: { type: "NUMBER" },
    east: { type: "NUMBER" },
    name: { type: "STRING", description: "The place the box approximates, if any" },
  },
  required: ["south", "west", "north", "east"],
};

const NEAR = {
  type: "OBJECT",
  description: "A point and radius, for questions about what is near coordinates.",
  properties: {
    latitude: { type: "NUMBER" },
    longitude: { type: "NUMBER" },
    radius_km: { type: "NUMBER" },
  },
  required: ["latitude", "longitude"],
};

export const TOOL_DECLARATIONS = [
  {
    name: "search_locations",
    description:
      "Search every location (about 1 km cells) in the data. Filter by class, distinct days seen, peak fire radiative power, how recently seen, and an area or a point; returns the match count, the breakdown by class, and the top matches ranked.",
    parameters: {
      type: "OBJECT",
      properties: {
        class: { type: "STRING", enum: ["any", ...CLASSES] },
        min_distinct_days: { type: "INTEGER" },
        max_distinct_days: { type: "INTEGER" },
        min_peak_frp_mw: { type: "NUMBER" },
        seen_within_hours: { type: "INTEGER", description: "Only locations last seen within this many hours" },
        area: AREA,
        near: NEAR,
        sort_by: { type: "STRING", enum: ["distinct_days", "peak_frp", "last_seen", "passes"] },
        limit: { type: "INTEGER", description: "How many top matches to list, 1 to 25" },
      },
    },
  },
  {
    name: "location_detail",
    description:
      "Full evidence for the location nearest to a point: how it was classified and why, what was measured, its history, and nearby mapped industry.",
    parameters: {
      type: "OBJECT",
      properties: { latitude: { type: "NUMBER" }, longitude: { type: "NUMBER" } },
      required: ["latitude", "longitude"],
    },
  },
];

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function describe(m: MapMark, now: number, extra = ""): string {
  const seen = Date.parse(m.last_seen);
  const ago = Number.isFinite(seen) ? `${age(Math.max(0, (now - seen) / HOUR_MS))} ago` : "at an unknown time";
  return (
    `${coordinates(m.latitude, m.longitude)}: ${NOUN[m.label][0]}; seen on ${m.distinct_days} distinct ` +
    `${m.distinct_days === 1 ? "day" : "days"}; peak fire radiative power ${m.frp_mw.toFixed(1)} MW; ` +
    `${m.observation_count} satellite ${m.observation_count === 1 ? "pass" : "passes"}; last seen ${ago}${extra}.`
  );
}

interface Area {
  south: number;
  west: number;
  north: number;
  east: number;
  name?: string;
}

function readArea(raw: unknown): Area | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const south = num(r.south);
  const north = num(r.north);
  const west = num(r.west);
  const east = num(r.east);
  if (south === undefined || north === undefined || west === undefined || east === undefined) return null;
  if (south >= north || west >= east || Math.abs(south) > 90 || Math.abs(north) > 90) return null;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 60) : undefined;
  return { south, west, north, east, name };
}

function areaText(a: Area): string {
  const box = `${a.south.toFixed(2)}° to ${a.north.toFixed(2)}° N, ${a.west.toFixed(2)}° to ${a.east.toFixed(2)}° E`;
  return a.name
    ? `the box ${box}, the assistant's approximation of ${a.name} (not an official boundary)`
    : `the box ${box}`;
}

function searchLocations(args: Record<string, unknown>, ctx: AskContext): ToolRun {
  const { now } = ctx;
  const cls = CLASSES.includes(args.class as ThermalClass) ? (args.class as ThermalClass) : null;
  const minDays = num(args.min_distinct_days);
  const maxDays = num(args.max_distinct_days);
  const minFrp = num(args.min_peak_frp_mw);
  const within = num(args.seen_within_hours);
  const area = readArea(args.area);
  const nearRaw = args.near as Record<string, unknown> | undefined;
  const near =
    nearRaw && num(nearRaw.latitude) !== undefined && num(nearRaw.longitude) !== undefined
      ? {
          lat: num(nearRaw.latitude)!,
          lon: num(nearRaw.longitude)!,
          km: Math.max(1, Math.min(300, num(nearRaw.radius_km) ?? 25)),
        }
      : null;
  const sortBy = ["distinct_days", "peak_frp", "last_seen", "passes"].includes(String(args.sort_by))
    ? String(args.sort_by)
    : "distinct_days";
  const limit = Math.max(1, Math.min(MAX_ROWS, Math.round(num(args.limit) ?? 10)));

  let rows = ctx.marks.map((m) => ({ m, km: near ? haversineKm(near.lat, near.lon, m.latitude, m.longitude) : 0 }));
  if (cls) rows = rows.filter((r) => r.m.label === cls);
  if (minDays !== undefined) rows = rows.filter((r) => r.m.distinct_days >= minDays);
  if (maxDays !== undefined) rows = rows.filter((r) => r.m.distinct_days <= maxDays);
  if (minFrp !== undefined) rows = rows.filter((r) => r.m.frp_mw >= minFrp);
  if (within !== undefined) rows = rows.filter((r) => Date.parse(r.m.last_seen) >= now - within * HOUR_MS);
  if (area) {
    rows = rows.filter(
      (r) =>
        r.m.latitude >= area.south &&
        r.m.latitude <= area.north &&
        r.m.longitude >= area.west &&
        r.m.longitude <= area.east,
    );
  }
  if (near) rows = rows.filter((r) => r.km <= near.km);

  const criteria = [
    cls ? NOUN[cls][1] : "locations of any class",
    minDays !== undefined ? `seen on at least ${minDays} distinct days` : "",
    maxDays !== undefined ? `seen on at most ${maxDays} distinct days` : "",
    minFrp !== undefined ? `peak fire radiative power at least ${minFrp} MW` : "",
    within !== undefined ? `last seen within ${within} hours` : "",
    area ? `inside ${areaText(area)}` : "",
    near ? `within ${near.km} km of ${coordinates(near.lat, near.lon)}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  const counts = new Map<ThermalClass, number>();
  for (const r of rows) counts.set(r.m.label, (counts.get(r.m.label) ?? 0) + 1);
  const breakdown = CLASSES.filter((c) => counts.get(c))
    .map((c) => `${counts.get(c)!.toLocaleString()} ${NOUN[c][counts.get(c) === 1 ? 0 : 1]}`)
    .join(", ");

  const facts: ToolFact[] = [
    {
      text:
        `Search of all ${ctx.marks.length.toLocaleString()} locations for ${criteria}: ` +
        `${rows.length.toLocaleString()} ${rows.length === 1 ? "match" : "matches"}` +
        (rows.length ? ` (${breakdown}).` : "."),
    },
  ];

  const key: Record<string, (r: { m: MapMark; km: number }) => number> = {
    distinct_days: (r) => r.m.distinct_days * 1e6 + r.m.frp_mw,
    peak_frp: (r) => r.m.frp_mw,
    last_seen: (r) => Date.parse(r.m.last_seen),
    passes: (r) => r.m.observation_count,
  };
  const label: Record<string, string> = {
    distinct_days: "by distinct days seen",
    peak_frp: "by peak fire radiative power",
    last_seen: "by most recently seen",
    passes: "by number of satellite passes",
  };
  const ranked = near && args.sort_by === undefined
    ? [...rows].sort((a, b) => a.km - b.km)
    : [...rows].sort((a, b) => key[sortBy](b) - key[sortBy](a));
  const rankLabel = near && args.sort_by === undefined ? "nearest" : label[sortBy];
  ranked.slice(0, limit).forEach((r, i) =>
    facts.push({
      text: `#${i + 1} ${rankLabel} among those matches: ${describe(r.m, now, near ? `; ${r.km.toFixed(1)} km away` : "")}`,
      mark: r.m,
    }),
  );

  return { name: "search_locations", summary: `Searched ${criteria}`, facts };
}

async function locationDetail(args: Record<string, unknown>, ctx: AskContext): Promise<ToolRun> {
  const lat = num(args.latitude);
  const lon = num(args.longitude);
  if (lat === undefined || lon === undefined) {
    return { name: "location_detail", summary: "Location detail (no coordinates given)", facts: [] };
  }
  let best: { m: MapMark; km: number } | null = null;
  for (const m of ctx.marks) {
    const km = haversineKm(lat, lon, m.latitude, m.longitude);
    if (!best || km < best.km) best = { m, km };
  }
  const point = coordinates(lat, lon);
  if (!best || best.km > DETAIL_RADIUS_KM) {
    return {
      name: "location_detail",
      summary: `Looked for a location near ${point}`,
      facts: [{ text: `No location in the data lies within ${DETAIL_RADIUS_KM} km of ${point}.` }],
    };
  }
  const { m } = best;
  const facts: ToolFact[] = [{ text: `Nearest location to ${point}, ${best.km.toFixed(1)} km away: ${describe(m, ctx.now)}`, mark: m }];

  let detail: HotspotDetail | null = null;
  try {
    detail = ctx.loadDetail ? await ctx.loadDetail(m.id) : null;
  } catch {
    // Said plainly below: a failed fetch is not an absence of evidence.
    facts.push({ text: `The full evidence for ${coordinates(m.latitude, m.longitude)} could not be loaded.` });
  }
  if (detail) {
    const cls = detail.classification;
    facts.push({
      text:
        `${coordinates(m.latitude, m.longitude)} is classified "${cls.display_label}" by ` +
        (cls.source === "rule"
          ? "deterministic rules over its multi-day history (no probability applies)."
          : cls.abstained
            ? "the classifier, which declined to decide."
            : `the classifier${cls.confidence !== null ? ` with probability ${cls.confidence.toFixed(2)}` : ""}.`),
      mark: m,
    });
    for (const e of detail.evidence) {
      facts.push({
        text: `${e.kind === "absent" ? "Not established" : e.kind === "observed" ? "Measured" : "Computed"} at ${coordinates(m.latitude, m.longitude)}: ${e.statement}`,
        mark: m,
      });
    }
  }
  return { name: "location_detail", summary: `Opened the evidence for ${coordinates(m.latitude, m.longitude)}`, facts };
}

export async function runTool(name: string, args: Record<string, unknown>, ctx: AskContext): Promise<ToolRun> {
  if (name === "search_locations") return searchLocations(args ?? {}, ctx);
  if (name === "location_detail") return locationDetail(args ?? {}, ctx);
  return { name, summary: `Unknown tool ${name}`, facts: [] };
}
