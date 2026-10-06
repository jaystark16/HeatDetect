/**
 * What Gemini is shown: the whole picture, as numbered facts.
 *
 * Gemini cannot read the satellite data. It reasons over this briefing, and
 * every value in it is computed here from the same rows the map draws: the
 * pipeline's detections, its persistence statistics and its classifications.
 * Each fact has a number Gemini must cite, so every sentence it writes can be
 * traced to, and checked against, the fact it rests on (verify.ts).
 */

import { CLASS_ORDER } from "../classes";
import type { MapMark, ThermalClass } from "../types";
import { age, answer, coordinates, keywordRoute, type Answer, type AskContext } from "./intents";

export interface Fact {
  id: number;
  section: string;
  text: string;
  /** Set when the fact is about one location, so the page can show it on the map. */
  mark?: MapMark;
}

export interface Briefing {
  facts: Fact[];
  /** The computed answer to the question itself, when keywords could place it. */
  computed: Answer | null;
}

const HOUR_MS = 3_600_000;

const NOUN: Record<ThermalClass, [string, string]> = {
  industrial_fire: ["possible industrial fire", "possible industrial fires"],
  persistent_industrial: ["persistent industrial source", "persistent industrial sources"],
  natural_fire: ["probable vegetation fire", "probable vegetation fires"],
  unknown: ["unclassified location", "unclassified locations"],
};

const n = (count: number, label: ThermalClass) =>
  `${count.toLocaleString()} ${NOUN[label][count === 1 ? 0 : 1]}`;

function breakdown(marks: MapMark[]): string {
  const counts = new Map<ThermalClass, number>();
  for (const m of marks) counts.set(m.label, (counts.get(m.label) ?? 0) + 1);
  const parts = CLASS_ORDER.filter((c) => counts.get(c)).map((c) => n(counts.get(c)!, c));
  return parts.length ? parts.join(", ") : "none";
}

function describe(m: MapMark, now: number): string {
  const seen = Date.parse(m.last_seen);
  const ago = Number.isFinite(seen) ? `${age(Math.max(0, (now - seen) / HOUR_MS))} ago` : "at an unknown time";
  return (
    `${coordinates(m.latitude, m.longitude)}: ${NOUN[m.label][0]}; seen on ` +
    `${m.distinct_days} distinct ${m.distinct_days === 1 ? "day" : "days"}; peak fire radiative power ` +
    `${m.frp_mw.toFixed(1)} MW; ${m.observation_count} satellite ${m.observation_count === 1 ? "pass" : "passes"}; ` +
    `last seen ${ago}.`
  );
}

/** One-degree cells holding the most locations of a class: where activity concentrates. */
function clusters(marks: MapMark[], label: ThermalClass, top: number) {
  const cells = new Map<string, { lat: number; lon: number; members: MapMark[] }>();
  for (const m of marks) {
    if (m.label !== label) continue;
    const key = `${Math.floor(m.latitude)}:${Math.floor(m.longitude)}`;
    const cell = cells.get(key) ?? { lat: Math.floor(m.latitude) + 0.5, lon: Math.floor(m.longitude) + 0.5, members: [] };
    cell.members.push(m);
    cells.set(key, cell);
  }
  return [...cells.values()].sort((a, b) => b.members.length - a.members.length).slice(0, top);
}

export function buildBriefing(question: string, ctx: AskContext): Briefing {
  const facts: Fact[] = [];
  const add = (section: string, text: string, mark?: MapMark) => {
    facts.push({ id: facts.length + 1, section, text, mark });
  };
  const { marks, analytics, model, now } = ctx;

  // --- Where the data comes from and how current it is.
  const prov = ctx.provenance;
  add(
    "data",
    "Source: NASA FIRMS active-fire detections from the VIIRS and MODIS satellite instruments, grouped into locations of about 1 km. " +
      "The analysis area is a rectangle around India that also covers parts of Pakistan, Nepal, Bangladesh and Sri Lanka, so a " +
      "location in it is not necessarily in India. A thermal anomaly is evidence of unusual heat, not proof of a fire.",
  );
  if (prov?.oldest_detection_at && prov.newest_detection_at) {
    const days = Math.max(
      1,
      Math.round((Date.parse(prov.newest_detection_at) - Date.parse(prov.oldest_detection_at)) / 86_400_000),
    );
    const newest = Math.max(0, (now - Date.parse(prov.newest_detection_at)) / HOUR_MS);
    add("data", `The data covers ${days} days; the newest detection is ${age(newest)} old.`);
  }
  if (ctx.snapshot) {
    const s = ctx.snapshot;
    add(
      "data",
      s.current
        ? `This data was rebuilt from NASA FIRMS ${age(s.buildAgeHours)} ago and is rebuilt every ${s.cadenceHours} hours.`
        : `This data was built ${age(s.buildAgeHours)} ago and is not currently being refreshed.`,
    );
  }
  if (prov?.coverage_note) add("data", `Coverage: ${prov.coverage_note}`);

  // --- How classification works and how far to trust it.
  add(
    "method",
    "Where a location has multi-day history, deterministic rules decide its class from how many distinct days it was seen " +
      "and its distance to mapped industry; a rule decision has no probability. A trained classifier is used only for a lone detection.",
  );
  const perClass = (model?.metrics?.per_class ?? null) as Record<
    string,
    { precision: number; recall: number; support: number }
  > | null;
  if (perClass) {
    for (const [label, r] of Object.entries(perClass)) {
      add(
        "method",
        `Classifier test result for ${label}: precision ${r.precision.toFixed(3)}, recall ${r.recall.toFixed(3)}, on ${r.support} examples.`,
      );
    }
    const suppressed = Object.entries(perClass).filter(([, r]) => r.precision < 0.5).map(([l]) => l);
    if (suppressed.length) {
      add(
        "method",
        `The classifier is not trusted to report ${suppressed.join(" or ")} (precision below 0.5), so such predictions are shown as not classified.`,
      );
    }
  }
  if (model?.caveat) add("method", `Classifier caveat: ${model.caveat}`);

  // --- The whole picture.
  if (analytics) {
    add(
      "totals",
      `${analytics.total_detections.toLocaleString()} detections at ${analytics.total_cells.toLocaleString()} locations.`,
    );
    for (const c of analytics.by_class) {
      add("totals", `${n(c.cells, c.label)} (${c.detections.toLocaleString()} detections).`);
    }
    add("totals", `${analytics.flagged_for_investigation.toLocaleString()} locations are flagged for investigation.`);
  }

  for (const hours of [24, 72, 168] as const) {
    const recent = marks.filter((m) => Date.parse(m.last_seen) >= now - hours * HOUR_MS);
    add("recent", `In the last ${hours} hours, ${recent.length.toLocaleString()} locations were detected: ${breakdown(recent)}.`);
  }

  // Rankings are stated outright, so a comparison has a fact to cite.
  const ranked = (label: ThermalClass | null, by: "days" | "frp", top: number, title: string) => {
    const pool = label ? marks.filter((m) => m.label === label) : marks;
    const sorted = [...pool].sort((a, b) =>
      by === "days"
        ? b.distinct_days - a.distinct_days || b.frp_mw - a.frp_mw
        : b.frp_mw - a.frp_mw || b.distinct_days - a.distinct_days,
    );
    sorted.slice(0, top).forEach((m, i) => add("ranking", `#${i + 1} ${title}: ${describe(m, now)}`, m));
  };
  ranked("persistent_industrial", "days", 10, "most persistent industrial source by distinct days");
  ranked(null, "frp", 10, "highest peak fire radiative power of any location");
  ranked("industrial_fire", "frp", 15, "possible industrial fire by peak fire radiative power");
  const recentStrong = [...marks]
    .filter((m) => Date.parse(m.last_seen) >= now - 24 * HOUR_MS)
    .sort((a, b) => b.frp_mw - a.frp_mw)
    .slice(0, 8);
  recentStrong.forEach((m, i) =>
    add("ranking", `#${i + 1} highest peak fire radiative power among locations seen in the last 24 hours: ${describe(m, now)}`, m),
  );

  for (const label of ["persistent_industrial", "natural_fire"] as const) {
    clusters(marks, label, 6).forEach((c, i) =>
      add(
        "clusters",
        `#${i + 1} one-degree area by number of ${NOUN[label][1]}: around ${coordinates(c.lat, c.lon)}, ` +
          `${n(c.members.length, label)}.`,
      ),
    );
  }

  // --- What the visitor is looking at.
  const d = ctx.selected;
  if (d) {
    const cls = d.classification;
    add(
      "open location",
      `The location open in the side panel is at ${coordinates(d.latitude, d.longitude)}, classified "${cls.display_label}" by ` +
        (cls.source === "rule"
          ? "deterministic rules (no probability applies)."
          : cls.abstained
            ? "the classifier, which declined to decide."
            : `the classifier${cls.confidence !== null ? ` with probability ${cls.confidence.toFixed(2)}` : ""}.`),
      ctx.marks.find((m) => m.id === d.id),
    );
    for (const e of d.evidence) add("open location", `${e.kind === "absent" ? "Not established" : e.kind === "observed" ? "Measured" : "Computed"}: ${e.statement}`);
    add("open location", d.caution);
  }

  // --- The question, answered by code where it can be.
  const intent = keywordRoute(question, d !== null);
  const computed = intent.kind === "unsupported" ? null : answer(intent, ctx);
  if (computed) {
    add("computed answer", `${computed.title}: ${computed.summary}`);
    // Matched by text, not position: some answers lead with counts before the
    // per-location lines.
    computed.facts.forEach((f) =>
      add("computed answer", f, computed.items.find((item) => item.line === f)?.mark),
    );
  }

  return { facts, computed };
}

export function renderFacts(facts: Fact[]): string {
  let section = "";
  const lines: string[] = [];
  for (const f of facts) {
    if (f.section !== section) {
      section = f.section;
      lines.push(`\n## ${section}`);
    }
    lines.push(`[${f.id}] ${f.text}`);
  }
  return lines.join("\n").trim();
}
