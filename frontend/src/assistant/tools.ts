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
 * A state, union territory or country is searched by its real boundary
 * (`region`): each location carries the region the backend assigned from
 * India's official map. For anything else, a city or an area, the model may
 * name a place and give its own approximate box for it. The box is a guess from
 * general knowledge, not data, and every fact built from it says so; the place
 * name then appears in a cited fact only alongside that disclaimer.
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
  /**
   * Set when the request was invalid. Returned to the model so it can correct
   * the call, instead of the search quietly answering a different question.
   */
  error?: string;
}

const SORTS = ["distinct_days", "peak_frp", "last_seen", "passes"];

const CLASSES: ThermalClass[] = ["industrial_fire", "persistent_industrial", "natural_fire", "unknown"];

const NOUN: Record<ThermalClass, [string, string]> = {
  industrial_fire: ["possible industrial fire", "possible industrial fires"],
  persistent_industrial: ["persistent industrial source", "persistent industrial sources"],
  natural_fire: ["probable vegetation fire", "probable vegetation fires"],
  unknown: ["unclassified location", "unclassified locations"],
};

/**
 * India's 28 states and 8 union territories, spelt as in
 * backend/data/boundaries/india_states.geojson (tools.test.ts checks this). Kept
 * here, not read from the locations, so a state with no detections answers
 * "0 matches" instead of "unknown region".
 */
export const INDIAN_REGIONS = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar",
  "Chandigarh", "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa",
  "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka",
  "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya",
  "Mizoram", "Nagaland", "Odisha", "Puducherry", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu",
  "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal",
];

const regionKey = (name: string) => name.toLowerCase().replace(/&/g, "and").replace(/[^a-z]/g, "");

/** Spellings in common use that the boundary data does not use. */
const REGION_ALIASES: Record<string, string> = {
  orissa: "Odisha",
  pondicherry: "Puducherry",
  uttaranchal: "Uttarakhand",
  jk: "Jammu and Kashmir",
  jandk: "Jammu and Kashmir",
  andamanandnicobar: "Andaman and Nicobar Islands",
  andamans: "Andaman and Nicobar Islands",
  dadraandnagarhaveli: "Dadra and Nagar Haveli and Daman and Diu",
  damananddiu: "Dadra and Nagar Haveli and Daman and Diu",
  nctofdelhi: "Delhi",
  burma: "Myanmar",
};

/** The canonical region or country for what the model passed, or null. */
export function matchRegion(input: string, marks: MapMark[]): { name: string; country: boolean } | null {
  const key = regionKey(input);
  if (!key) return null;
  const indian = INDIAN_REGIONS.find((r) => regionKey(r) === key);
  if (indian) return { name: indian, country: false };
  const countries = new Set(["India", ...marks.map((m) => m.country).filter((c): c is string => Boolean(c))]);
  const country = [...countries].find((c) => regionKey(c) === key);
  if (country) return { name: country, country: true };
  const alias = REGION_ALIASES[key];
  if (alias) return INDIAN_REGIONS.includes(alias) ? { name: alias, country: false } : { name: alias, country: true };
  return null;
}

/** Where a location lies, as the backend assigned it from the boundary data. */
function placeOf(m: MapMark): string {
  if (!m.country) return "";
  const where = m.region ? `${m.region}, ${m.country}` : m.country;
  const near = m.region_alternatives.length ? ` (within 1.5 km of ${m.region_alternatives.join(" and ")})` : "";
  return ` in ${where}${near}`;
}

const AREA = {
  type: "OBJECT",
  description:
    "A latitude/longitude box. If the user named a place, give your best approximate box for it and its name; it is reported as an approximation, not a boundary.",
  properties: {
    south: { type: "NUMBER" },
    west: { type: "NUMBER" },
    north: { type: "NUMBER" },
    east: { type: "NUMBER" },
    name: {
      type: "STRING",
      // Without the name, an answer cannot say "around Gujarat": the citation
      // check only lets a place be named from a fact that carries it.
      description:
        "Required whenever the user named a place: the place this box approximates, e.g. 'Gujarat'. Without it the answer cannot mention the place.",
    },
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
    name: {
      type: "STRING",
      description:
        "Required whenever the user named a place: the place this point approximates, e.g. 'Vizag'. Without it the answer cannot mention the place.",
    },
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
        region: {
          type: "STRING",
          description:
            "An Indian state or union territory (e.g. 'Odisha', 'Ladakh'), or a country (e.g. 'Nepal', 'India'). Searched by its real boundary, India's official map. Use this, not area, whenever the user names a state, union territory or country.",
        },
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
    `${coordinates(m.latitude, m.longitude)}: ${NOUN[m.label][0]}${placeOf(m)}; seen on ${m.distinct_days} distinct ` +
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

function boundaryNote(uncertain: number, edge: number, name: string): string {
  const parts = [
    uncertain ? `${uncertain.toLocaleString()} of them ${uncertain === 1 ? "lies" : "lie"} within 1.5 km of another state or country` : "",
    edge ? `${edge.toLocaleString()} more just outside ${edge === 1 ? "lies" : "lie"} within 1.5 km of ${name}` : "",
  ].filter(Boolean);
  return parts.length ? ` ${parts.join("; ")}, closer than the boundaries are accurate.` : "";
}

function invalid(error: string): ToolRun {
  return { name: "search_locations", summary: `Rejected a search: ${error}`, facts: [], error };
}

function searchLocations(args: Record<string, unknown>, ctx: AskContext): ToolRun {
  const { now } = ctx;
  // An unknown class used to fall through to "any class", so a model asking
  // for "vegetation fire" (observed from gpt-oss on Ollama) got a count of
  // every location. Refuse it and say what is valid.
  if (args.class !== undefined && args.class !== "any" && !CLASSES.includes(args.class as ThermalClass)) {
    return invalid(`class must be one of any, ${CLASSES.join(", ")}; got "${String(args.class)}"`);
  }
  if (args.sort_by !== undefined && !SORTS.includes(String(args.sort_by))) {
    return invalid(`sort_by must be one of ${SORTS.join(", ")}; got "${String(args.sort_by)}"`);
  }
  const region = args.region !== undefined ? matchRegion(String(args.region), ctx.marks) : null;
  if (args.region !== undefined && !region) {
    return invalid(
      `region must be an Indian state or union territory (${INDIAN_REGIONS.join(", ")}) or a country in the data; got "${String(args.region)}". For a city or an area, use area or near instead.`,
    );
  }
  if (args.area !== undefined && readArea(args.area) === null) {
    return invalid("area needs numbers south < north and west < east, within -90..90 latitude");
  }
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
          name: typeof nearRaw.name === "string" && nearRaw.name.trim() ? nearRaw.name.trim().slice(0, 60) : undefined,
        }
      : null;
  const sortBy = SORTS.includes(String(args.sort_by))
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
  // Locations just outside the region but within 1.5 km of it: the boundary
  // is not accurate enough at that distance to rule them out.
  let edge = 0;
  if (region) {
    const inside = (m: MapMark) => (region.country ? m.country === region.name : m.region === region.name);
    edge = rows.filter((r) => !inside(r.m) && r.m.region_alternatives.includes(region.name)).length;
    rows = rows.filter((r) => inside(r.m));
  }

  const criteria = [
    cls ? NOUN[cls][1] : "locations of any class",
    minDays !== undefined ? `seen on at least ${minDays} distinct days` : "",
    maxDays !== undefined ? `seen on at most ${maxDays} distinct days` : "",
    minFrp !== undefined ? `peak fire radiative power at least ${minFrp} MW` : "",
    within !== undefined ? `last seen within ${within} hours` : "",
    region
      ? `in ${region.name} (${region.country ? "country boundary" : "state or union territory boundary, India's official map"})`
      : "",
    area ? `inside ${areaText(area)}` : "",
    near
      ? `within ${near.km} km of ${coordinates(near.lat, near.lon)}` +
        (near.name ? `, the assistant's approximation of ${near.name} (not an official position)` : "")
      : "",
  ]
    .filter(Boolean)
    .join(", ");

  const counts = new Map<ThermalClass, number>();
  for (const r of rows) counts.set(r.m.label, (counts.get(r.m.label) ?? 0) + 1);
  // The industrial total is given because models may not add numbers up
  // themselves; observed: "97" (94 + 3) withheld when comparing two states.
  const fires = counts.get("industrial_fire") ?? 0;
  const persistent = counts.get("persistent_industrial") ?? 0;
  const breakdown =
    CLASSES.filter((c) => counts.get(c))
      .map((c) => `${counts.get(c)!.toLocaleString()} ${NOUN[c][counts.get(c) === 1 ? 0 : 1]}`)
      .join(", ") +
    (fires && persistent ? `; ${(fires + persistent).toLocaleString()} of them possible or persistent industrial` : "");

  const facts: ToolFact[] = [
    {
      text:
        `Search of all ${ctx.marks.length.toLocaleString()} locations for ${criteria}: ` +
        `${rows.length.toLocaleString()} ${rows.length === 1 ? "match" : "matches"}` +
        (rows.length ? ` (${breakdown}).` : ".") +
        (region ? boundaryNote(rows.filter((r) => r.m.region_alternatives.length).length, edge, region.name) : ""),
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
