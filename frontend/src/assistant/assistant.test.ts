/**
 * The assistant's deterministic core, tested on the real committed snapshot.
 *
 * The answers are checked against values computed independently here from the
 * same rows, so a test cannot pass by agreeing with itself.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { locationToMark } from "../api";
import type { Analytics, HotspotDetail, LocationSummary, MapMark, ModelInfo } from "../types";
import {
  answer,
  DEFAULT_INTENT,
  haversineKm,
  keywordRoute,
  type AskContext,
  type Intent,
} from "./intents";
import { stripThinking } from "./llm";
import { verifyWording } from "./verify";

interface Snapshot {
  generated_at: string;
  captured_window: { newest_detection_at: string };
  analytics: Analytics;
  model: ModelInfo;
  locations: LocationSummary[];
  details: Record<string, HotspotDetail>;
}

const snapshot = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../public/snapshot.json", import.meta.url)), "utf-8"),
) as Snapshot;

const marks: MapMark[] = snapshot.locations.map(locationToMark);
// Pinned to the snapshot's own newest detection, so "recent" is reproducible.
const NOW = Date.parse(snapshot.captured_window.newest_detection_at) + 3_600_000;

function ctx(overrides: Partial<AskContext> = {}): AskContext {
  return {
    marks,
    analytics: snapshot.analytics,
    model: snapshot.model,
    provenance: snapshot.analytics.provenance,
    snapshot: null,
    mode: "historical",
    selected: null,
    now: NOW,
    ...overrides,
  };
}

const intent = (kind: Intent["kind"], extra: Partial<Intent> = {}): Intent => ({
  ...DEFAULT_INTENT,
  kind,
  ...extra,
});

describe("keyword routing", () => {
  it.each([
    ["what is new in the last 24 hours?", "recent", null, 24],
    ["vegetation fires this week", "recent", "natural_fire", 168],
    ["which industrial plants burn most persistently?", "most_persistent", "persistent_industrial", 24],
    ["strongest heat sources", "strongest", null, 24],
    ["how current is this data", "freshness", null, 24],
    ["can I trust the model?", "model", null, 24],
    ["give me an overview", "overview", null, 24],
    ["what is the capital of France", "unsupported", null, 24],
  ])("%s → %s", (question, kind, label, hours) => {
    const routed = keywordRoute(question, false);
    expect(routed.kind).toBe(kind);
    expect(routed.label).toBe(label);
    expect(routed.hours).toBe(hours);
  });

  it("takes coordinates from the question text", () => {
    const routed = keywordRoute("anything near 23.75, 86.42 within 40 km?", false);
    expect(routed).toMatchObject({ kind: "near", latitude: 23.75, longitude: 86.42, radiusKm: 40 });
  });

  it("explains the selection only when one exists", () => {
    expect(keywordRoute("why is this classified so?", true).kind).toBe("explain_selected");
    expect(keywordRoute("why is this classified so?", false).kind).not.toBe("explain_selected");
  });
});

describe("computed answers match the data", () => {
  it("lists the most persistent industrial sources in order", () => {
    const expected = marks
      .filter((m) => m.label === "persistent_industrial")
      .sort((a, b) => b.distinct_days - a.distinct_days || b.frp_mw - a.frp_mw)
      .slice(0, 5);
    const a = answer(intent("most_persistent", { label: "persistent_industrial" }), ctx());
    expect(a.items.map((i) => i.mark.id)).toEqual(expected.map((m) => m.id));
    expect(a.summary).toContain(`${expected[0].distinct_days} distinct days`);
  });

  it("counts recent locations exactly", () => {
    const cutoff = NOW - 72 * 3_600_000;
    const expected = marks.filter((m) => Date.parse(m.last_seen) >= cutoff).length;
    const a = answer(intent("recent", { hours: 72 }), ctx());
    expect(a.facts[0]).toBe(`${expected.toLocaleString()} detected in the last 72 hours.`);
  });

  it("finds a location at its own coordinates first, at 0 km", () => {
    const target = marks[100];
    const a = answer(
      intent("near", { latitude: target.latitude, longitude: target.longitude, radiusKm: 10 }),
      ctx(),
    );
    expect(a.items[0].mark.id).toBe(target.id);
    expect(a.summary).toContain("The nearest is 0.0 km away.");
  });

  it("reports the overview from the analytics, not from the marks", () => {
    const a = answer(intent("overview"), ctx());
    expect(a.summary).toContain(snapshot.analytics.total_detections.toLocaleString());
    expect(a.summary).toContain(snapshot.analytics.total_cells.toLocaleString());
  });

  it("explains a selection with its own evidence, and no probability for rules", () => {
    const detail = Object.values(snapshot.details).find((d) => d.classification.source === "rule")!;
    const a = answer(intent("explain_selected"), ctx({ selected: detail }));
    expect(a.facts).toEqual(expect.arrayContaining(detail.evidence.map((e) => e.statement)));
    expect(a.summary).toContain("no probability applies");
  });

  it("states model suppression from the measured metrics", () => {
    const perClass = snapshot.model.metrics?.per_class as Record<string, { precision: number }>;
    const suppressed = Object.entries(perClass).filter(([, r]) => r.precision < 0.5);
    const a = answer(intent("model"), ctx());
    for (const [label] of suppressed) expect(a.summary).toContain(label);
  });

  it("haversine matches a known distance (Delhi to Mumbai, ~1,150 km)", () => {
    expect(haversineKm(28.6139, 77.209, 19.076, 72.8777)).toBeGreaterThan(1130);
    expect(haversineKm(28.6139, 77.209, 19.076, 72.8777)).toBeLessThan(1170);
  });
});

describe("the wording gate", () => {
  const a = answer(intent("most_persistent", { label: "persistent_industrial" }), ctx());
  const top = a.items[0].mark;

  it("accepts a faithful rewording, including rounded values", () => {
    const text =
      `The most persistent industrial source in this data was seen on ${top.distinct_days} distinct days, ` +
      `at about ${top.latitude.toFixed(2)}° N, ${top.longitude.toFixed(2)}° E.`;
    expect(verifyWording(text, a, "most persistent sources").ok).toBe(true);
  });

  it("rejects an invented number", () => {
    const v = verifyWording(`It was seen on ${top.distinct_days + 7} days.`, a, "q");
    expect(v.ok).toBe(false);
    expect(v.reason).toContain(String(top.distinct_days + 7));
  });

  it("rejects certainty a thermal anomaly cannot support", () => {
    expect(verifyWording("This is a confirmed refinery fire.", a, "q").ok).toBe(false);
  });

  it("rejects a place name that is not in the facts", () => {
    const v = verifyWording("The top source lies near Jharia in Jharkhand.", a, "q");
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("Jharia");
  });

  it("allows numbers the visitor typed", () => {
    const recent = answer(intent("recent", { hours: 24 }), ctx());
    expect(verifyWording("Here is what was detected in the last 24 hours.", recent, "last 24 hours").ok).toBe(true);
  });

  it("rejects commentary that states none of the result (observed from the model)", () => {
    const observed =
      "The top persistent industrial sources are consistent with thermal anomalies, but the " +
      "duration of thermal activity does not directly indicate the length of coal mine operation. " +
      "Further analysis is required to determine the longest-operating coal mines.";
    expect(verifyWording(observed, a, "which coal mines have been burning the longest").ok).toBe(false);

    const neutral = "These sources are consistent with thermal anomalies. Further analysis is required.";
    expect(verifyWording(neutral, a, "q").reason).toBe("it did not state the computed result");
  });

  it("rejects adopting the question's assumption as fact (observed from the model)", () => {
    const observed =
      `The computed answer indicates that the coal mine at 31.5 MW has the longest persistence. ` +
      `This location was detected on ${top.distinct_days} distinct days.`;
    const v = verifyWording(observed, a, "which coal mines have been burning the longest");
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("coal");
  });

  it("allows a type word when the computed facts use it", () => {
    const detail = Object.values(snapshot.details).find((d) =>
      d.evidence.some((e) => /plant/i.test(e.statement)),
    );
    if (!detail) return;
    const explained = answer(intent("explain_selected"), ctx({ selected: detail }));
    const v = verifyWording(
      `${detail.classification.display_label}. The nearest mapped feature is a plant.`,
      explained,
      "why",
    );
    expect(v.reason ?? "").not.toContain("does not establish");
  });

  it("strips the empty thinking block Qwen3 emits before its answer", () => {
    expect(stripThinking('<think>\n\n</think>\n\n{"intent":"recent"}')).toBe('{"intent":"recent"}');
  });

  it("rejects an empty or runaway answer", () => {
    expect(verifyWording("   ", a, "q").ok).toBe(false);
    expect(verifyWording("word ".repeat(400), a, "q").ok).toBe(false);
  });
});
