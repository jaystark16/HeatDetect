/**
 * The assistant's questions and their answers, computed — never generated.
 *
 * Every fact the assistant can show comes from here: a fixed set of intents,
 * each answered by code over the loaded data. The language model (see llm.ts)
 * only chooses an intent and may reword the result; it never supplies a value.
 * See docs/adr/0008-on-device-assistant.md.
 */

import { CLASS_ORDER, CLASS_STYLES } from "../classes";
import type { FallbackMeta } from "../fallback";
import type {
  Analytics,
  DataMode,
  HotspotDetail,
  MapMark,
  ModelInfo,
  Provenance,
  ThermalClass,
} from "../types";

export type IntentKind =
  | "overview"
  | "most_persistent"
  | "strongest"
  | "recent"
  | "near"
  | "explain_selected"
  | "freshness"
  | "model"
  | "unsupported";

export interface Intent {
  kind: IntentKind;
  /** Null means every class. */
  label: ThermalClass | null;
  /** For "recent". */
  hours: 24 | 72 | 168;
  /** For lists. */
  limit: number;
  /** For "near"; always parsed from the question, never taken from a model. */
  latitude?: number;
  longitude?: number;
  radiusKm: number;
}

export const DEFAULT_INTENT: Omit<Intent, "kind"> = {
  label: null,
  hours: 24,
  limit: 5,
  radiusKm: 25,
};

export const MAX_LIMIT = 10;
export const MAX_RADIUS_KM = 200;

export interface AskContext {
  /** Every location, independent of the map's filters. */
  marks: MapMark[];
  analytics: Analytics | null;
  model: ModelInfo | null;
  provenance: Provenance | null;
  /** Set when the data came from the static snapshot. */
  snapshot: FallbackMeta | null;
  mode: DataMode;
  /** Detail of the location currently open in the side panel, if any. */
  selected: HotspotDetail | null;
  now: number;
  /** Full evidence for any location, for the assistant to look up. Rejects on a failed fetch. */
  loadDetail?: (id: string) => Promise<HotspotDetail | null>;
}

export interface AnswerItem {
  mark: MapMark;
  line: string;
}

export interface Answer {
  intent: Intent;
  /** What was answered, stated plainly so a misrouted question is visible. */
  title: string;
  /** The computed answer, in template sentences. Always true by construction. */
  summary: string;
  /** Supporting statements; the only material the model may reword. */
  facts: string[];
  items: AnswerItem[];
}

const HOUR_MS = 3_600_000;

// ------------------------------------------------------------- formatting --

export function coordinates(latitude: number, longitude: number): string {
  const ns = latitude >= 0 ? "N" : "S";
  const ew = longitude >= 0 ? "E" : "W";
  return `${Math.abs(latitude).toFixed(3)}° ${ns}, ${Math.abs(longitude).toFixed(3)}° ${ew}`;
}

/** Same units as the provenance bar: minutes, hours, then days. */
export function age(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "an unknown time";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

const CLASS_NOUNS: Record<ThermalClass, [string, string]> = {
  industrial_fire: ["possible industrial fire", "possible industrial fires"],
  persistent_industrial: ["persistent industrial source", "persistent industrial sources"],
  natural_fire: ["probable vegetation fire", "probable vegetation fires"],
  unknown: ["unclassified location", "unclassified locations"],
};

function className(label: ThermalClass | null, count = 2): string {
  if (label === null) return count === 1 ? "location" : "locations";
  return CLASS_NOUNS[label][count === 1 ? 0 : 1];
}

function hoursSince(iso: string, now: number): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now - t) / HOUR_MS) : null;
}

function markLine(mark: MapMark, now: number, extra?: string): string {
  const parts = [
    `${coordinates(mark.latitude, mark.longitude)}: ${CLASS_STYLES[mark.label].shortLabel}`,
    `seen on ${plural(mark.distinct_days, "day", "days")}`,
    `peak ${mark.frp_mw.toFixed(1)} MW`,
    plural(mark.observation_count, "satellite pass", "satellite passes"),
    `last seen ${age(hoursSince(mark.last_seen, now))} ago`,
  ];
  if (extra) parts.push(extra);
  return parts.join("; ") + ".";
}

function byClass(marks: MapMark[]): Map<ThermalClass, number> {
  const counts = new Map<ThermalClass, number>();
  for (const m of marks) counts.set(m.label, (counts.get(m.label) ?? 0) + 1);
  return counts;
}

function classBreakdown(counts: Map<ThermalClass, number>): string {
  const parts = CLASS_ORDER.filter((c) => counts.get(c)).map(
    (c) => `${(counts.get(c) ?? 0).toLocaleString()} ${className(c, counts.get(c))}`,
  );
  return parts.length ? parts.join(", ") : "none";
}

function windowDays(provenance: Provenance | null): number | null {
  const oldest = provenance?.oldest_detection_at;
  const newest = provenance?.newest_detection_at;
  if (!oldest || !newest) return null;
  return Math.max(1, Math.round((Date.parse(newest) - Date.parse(oldest)) / 86_400_000));
}

function newestAge(ctx: AskContext): number | null {
  const iso = ctx.snapshot?.newestDetectionAt ?? ctx.provenance?.newest_detection_at ?? null;
  return iso ? hoursSince(iso, ctx.now) : null;
}

/** Great-circle distance in km. Mirrors backend/app/geo.py. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------- answers --

export const INTENT_TITLES: Record<IntentKind, string> = {
  overview: "Overview of the data",
  most_persistent: "Most persistent locations",
  strongest: "Strongest heat (peak fire radiative power)",
  recent: "Recently detected locations",
  near: "Locations near a point",
  explain_selected: "The selected location",
  freshness: "How current the data is",
  model: "How reliable the classifier is",
  unsupported: "Not something I can answer",
};

function titleFor(intent: Intent): string {
  const cls = intent.label ? ` · ${className(intent.label)}` : "";
  switch (intent.kind) {
    case "recent":
      return `Detected in the last ${intent.hours} hours${cls}`;
    case "most_persistent":
    case "strongest":
    case "near":
      return `${INTENT_TITLES[intent.kind]}${cls}`;
    default:
      return INTENT_TITLES[intent.kind];
  }
}

export function answer(intent: Intent, ctx: AskContext): Answer {
  const base = { intent, title: titleFor(intent) };
  const pool = intent.label ? ctx.marks.filter((m) => m.label === intent.label) : ctx.marks;
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(intent.limit)));

  switch (intent.kind) {
    case "overview": {
      const a = ctx.analytics;
      if (!a) return { ...base, summary: "The totals have not loaded yet.", facts: [], items: [] };
      const days = windowDays(a.provenance);
      const counts = new Map(a.by_class.map((c) => [c.label, c.cells]));
      const facts = [
        `${a.total_detections.toLocaleString()} satellite detections at ${a.total_cells.toLocaleString()} locations of about 1 km.`,
        days !== null ? `The data covers ${plural(days, "day", "days")}.` : "",
        `By class: ${classBreakdown(counts)}.`,
        `${plural(a.flagged_for_investigation, "location is", "locations are")} flagged for investigation.`,
        `The newest detection is ${age(newestAge(ctx))} old.`,
      ].filter(Boolean);
      return {
        ...base,
        summary:
          `This data holds ${a.total_detections.toLocaleString()} detections at ` +
          `${a.total_cells.toLocaleString()} locations${days !== null ? ` over ${plural(days, "day", "days")}` : ""}: ` +
          `${classBreakdown(counts)}.`,
        facts,
        items: [],
      };
    }

    case "most_persistent":
    case "strongest": {
      const persistent = intent.kind === "most_persistent";
      const ranked = [...pool]
        .sort((x, y) =>
          persistent
            ? y.distinct_days - x.distinct_days || y.frp_mw - x.frp_mw
            : y.frp_mw - x.frp_mw || y.distinct_days - x.distinct_days,
        )
        .slice(0, limit);
      if (ranked.length === 0) {
        return { ...base, summary: `There are no ${className(intent.label)} in this data.`, facts: [], items: [] };
      }
      const top = ranked[0];
      const items = ranked.map((m) => ({ mark: m, line: markLine(m, ctx.now) }));
      const lead = persistent
        ? `was detected on ${plural(top.distinct_days, "distinct day", "distinct days")}`
        : `had a peak fire radiative power of ${top.frp_mw.toFixed(1)} MW`;
      return {
        ...base,
        summary:
          `Of ${pool.length.toLocaleString()} ${className(intent.label, pool.length)}, the top ` +
          `${ranked.length} are listed below. The first, at ${coordinates(top.latitude, top.longitude)}, ${lead}.`,
        facts: items.map((i) => i.line),
        items,
      };
    }

    case "recent": {
      const cutoff = ctx.now - intent.hours * HOUR_MS;
      const recent = pool.filter((m) => Date.parse(m.last_seen) >= cutoff);
      const newest = newestAge(ctx);
      if (recent.length === 0) {
        return {
          ...base,
          summary:
            `No ${className(intent.label)} were detected in the last ${intent.hours} hours. ` +
            `The newest detection in this data is ${age(newest)} old.`,
          facts: [`The newest detection in this data is ${age(newest)} old.`],
          items: [],
        };
      }
      const top = [...recent].sort((x, y) => y.frp_mw - x.frp_mw).slice(0, limit);
      const items = top.map((m) => ({ mark: m, line: markLine(m, ctx.now) }));
      return {
        ...base,
        summary:
          `${plural(recent.length, className(intent.label, 1), className(intent.label))} ` +
          `${recent.length === 1 ? "was" : "were"} detected in the last ${intent.hours} hours` +
          (intent.label ? "." : `: ${classBreakdown(byClass(recent))}.`) +
          ` The strongest ${top.length} are listed below.`,
        facts: [
          `${recent.length.toLocaleString()} detected in the last ${intent.hours} hours.`,
          ...(intent.label ? [] : [`By class: ${classBreakdown(byClass(recent))}.`]),
          ...items.map((i) => i.line),
        ],
        items,
      };
    }

    case "near": {
      if (intent.latitude === undefined || intent.longitude === undefined) {
        return {
          ...base,
          summary:
            "Give a point as decimal coordinates, for example 23.75, 86.42. Place names cannot be looked up without the API.",
          facts: [],
          items: [],
        };
      }
      const { latitude: lat, longitude: lon } = intent;
      const radius = Math.max(1, Math.min(MAX_RADIUS_KM, intent.radiusKm));
      const within = pool
        .map((m) => ({ m, km: haversineKm(lat, lon, m.latitude, m.longitude) }))
        .filter((x) => x.km <= radius)
        .sort((x, y) => x.km - y.km);
      const point = coordinates(lat, lon);
      if (within.length === 0) {
        return {
          ...base,
          summary: `No ${className(intent.label)} lie within ${radius} km of ${point}.`,
          facts: [],
          items: [],
        };
      }
      const items = within.slice(0, limit).map(({ m, km }) => ({
        mark: m,
        line: markLine(m, ctx.now, `${km.toFixed(1)} km away`),
      }));
      return {
        ...base,
        summary:
          `${plural(within.length, className(intent.label, 1), className(intent.label))} ` +
          `${within.length === 1 ? "lies" : "lie"} within ${radius} km of ${point}` +
          (intent.label ? "." : `: ${classBreakdown(byClass(within.map((w) => w.m)))}.`) +
          ` The nearest is ${within[0].km.toFixed(1)} km away.`,
        facts: [
          `${within.length} within ${radius} km of ${point}.`,
          ...items.map((i) => i.line),
        ],
        items,
      };
    }

    case "explain_selected": {
      const d = ctx.selected;
      if (!d) {
        return {
          ...base,
          summary: "No location is open. Select one on the map or in the feed, then ask again.",
          facts: [],
          items: [],
        };
      }
      const cls = d.classification;
      const how =
        cls.source === "rule"
          ? "It was decided by deterministic rules over the location's multi-day history, so no probability applies."
          : cls.abstained
            ? "The model declined to classify it."
            : `It is a single-observation model estimate${cls.confidence !== null ? ` with probability ${cls.confidence.toFixed(2)}` : ""}, used because the rules could not decide.`;
      const mark = ctx.marks.find((m) => m.id === d.id);
      return {
        ...base,
        summary: `${cls.display_label} at ${coordinates(d.latitude, d.longitude)}. ${how}`,
        facts: [how, ...d.evidence.map((e) => e.statement), d.caution],
        items: mark ? [{ mark, line: markLine(mark, ctx.now) }] : [],
      };
    }

    case "freshness": {
      const s = ctx.snapshot;
      const newest = newestAge(ctx);
      let summary: string;
      if (ctx.mode === "live") {
        summary = `This is a live query of the API. The newest detection is ${age(newest)} old.`;
      } else if (s && ctx.mode === "near_real_time") {
        summary =
          `This data was rebuilt from NASA FIRMS ${age(s.buildAgeHours)} ago and refreshes every ` +
          `${s.cadenceHours} h. The newest detection is ${age(newest)} old; satellites pass a few times a day, ` +
          "and FIRMS publishes each pass about 3 hours after it.";
      } else if (s) {
        summary =
          `This is a snapshot built ${age(s.buildAgeHours)} ago that is not being refreshed. ` +
          `Its newest detection is ${age(newest)} old.`;
      } else {
        summary = `The newest detection is ${age(newest)} old.`;
      }
      return { ...base, summary, facts: [summary], items: [] };
    }

    case "model": {
      const m = ctx.model;
      const perClass = (m?.metrics?.per_class ?? null) as Record<
        string,
        { precision: number; recall: number; support: number }
      > | null;
      if (!m?.trained || !perClass) {
        return {
          ...base,
          summary: "No trained model information is available.",
          facts: m?.caveat ? [m.caveat] : [],
          items: [],
        };
      }
      const rows = Object.entries(perClass).map(
        ([label, r]) =>
          `${label}: precision ${r.precision.toFixed(3)}, recall ${r.recall.toFixed(3)}, on ${r.support} test examples.`,
      );
      const suppressed = Object.entries(perClass)
        .filter(([, r]) => r.precision < 0.5)
        .map(([label]) => label);
      const rule =
        "Wherever a location has multi-day history, deterministic rules decide its class; the model is used only for a lone detection.";
      return {
        ...base,
        summary:
          `${rule} ` +
          (suppressed.length
            ? `The model is not trusted to report ${suppressed.join(" or ")}: its measured precision is below 0.5, so those predictions are shown as not classified.`
            : "Every class it reports has measured precision of at least 0.5."),
        facts: [rule, ...rows, m.caveat],
        items: [],
      };
    }

    case "unsupported":
      return {
        ...base,
        summary:
          "I can answer: an overview of the data; recent detections in the last 24 hours, 3 days or 7 days; " +
          "the most persistent or strongest locations, optionally of one class; locations near decimal " +
          "coordinates; how current the data is; how reliable the classifier is; and why the selected " +
          "location was classified as it was.",
        facts: [],
        items: [],
      };
  }
}

// ------------------------------------------------------- keyword routing --

// A hemisphere letter counts only when it stands alone: the "w" of "within"
// once turned 86.42 E into 86.42 W.
const COORDS =
  /(-?\d{1,2}\.\d+)\s*°?\s*([NS](?![a-z]))?\s*[,\s]\s*(-?\d{1,3}\.\d+)\s*°?\s*([EW](?![a-z]))?/i;
const RADIUS = /(\d{1,3})\s*km/i;

/** Coordinates and radius come from the question text only. */
export function parsePoint(question: string): Pick<Intent, "latitude" | "longitude"> & { radiusKm?: number } {
  const m = question.match(COORDS);
  const r = question.match(RADIUS);
  const radiusKm = r ? Number(r[1]) : undefined;
  if (!m) return { radiusKm };
  let lat = Number(m[1]);
  let lon = Number(m[3]);
  if (m[2]?.toUpperCase() === "S") lat = -Math.abs(lat);
  if (m[4]?.toUpperCase() === "W") lon = -Math.abs(lon);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { radiusKm };
  return { latitude: lat, longitude: lon, radiusKm };
}

export function parseClass(question: string): ThermalClass | null {
  const q = question.toLowerCase();
  if (/unclassified|not classified|unknown/.test(q)) return "unknown";
  if (/industrial fire|factory fire|plant fire|explosion|accident/.test(q)) return "industrial_fire";
  if (/persistent|industr|plant|factory|refiner|steel|coal|power station|mine/.test(q)) return "persistent_industrial";
  if (/vegetation|forest|crop|stubble|farm|agri|natural|wild/.test(q)) return "natural_fire";
  return null;
}

function parseHours(question: string): Intent["hours"] {
  const q = question.toLowerCase();
  if (/week|7\s*d|168/.test(q)) return 168;
  if (/3\s*d|three days|72|few days/.test(q)) return 72;
  return 24;
}

function parseLimit(question: string): number {
  const m = question.match(/\btop\s+(\d{1,2})\b|\b(\d{1,2})\s+(?:most|strongest|locations|sources|sites)\b/i);
  const n = m ? Number(m[1] ?? m[2]) : DEFAULT_INTENT.limit;
  return Math.max(1, Math.min(MAX_LIMIT, n));
}

/**
 * Deterministic routing, used whenever the model is not loaded and as the
 * fallback if its output is unusable. Crude by design; the answer always
 * states what it answered, so a misroute is visible rather than silent.
 */
export function keywordRoute(question: string, hasSelection: boolean): Intent {
  const q = question.toLowerCase();
  const point = parsePoint(question);
  const params = {
    ...DEFAULT_INTENT,
    label: parseClass(question),
    hours: parseHours(question),
    limit: parseLimit(question),
    radiusKm: point.radiusKm ?? DEFAULT_INTENT.radiusKm,
  };

  if (point.latitude !== undefined) {
    return { ...params, kind: "near", latitude: point.latitude, longitude: point.longitude };
  }
  if (hasSelection && /\b(this|selected|why|explain)\b/.test(q)) return { ...params, kind: "explain_selected" };
  if (/(fresh|current|up to date|updated|how old|how recent is|live|lag|delay)/.test(q)) return { ...params, kind: "freshness" };
  if (/(model|accura|precision|recall|reliab|trust|classifier)/.test(q)) return { ...params, kind: "model" };
  if (/(persist|recurr|chronic|most days|long[- ]running|always)/.test(q)) return { ...params, kind: "most_persistent" };
  if (/(strong|hottest|intens|biggest|largest|frp|power|brightest)/.test(q)) return { ...params, kind: "strongest" };
  if (/(last|past|recent|new|today|yesterday|hour|this week|latest)/.test(q)) return { ...params, kind: "recent" };
  if (/(overview|summary|summar|total|how many|count|everything|status)/.test(q)) return { ...params, kind: "overview" };
  if (params.label) return { ...params, kind: "most_persistent" };
  return { ...params, kind: "unsupported" };
}
