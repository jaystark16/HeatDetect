/**
 * The look-up tools Gemini calls, on the real snapshot. Expected values are
 * recomputed here from the same rows, so a test cannot pass by agreeing with
 * the tool's own arithmetic.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { handle } from "../../../proxy/worker.mjs";
import { locationToMark } from "../api";
import type { Analytics, HotspotDetail, LocationSummary, MapMark, ModelInfo } from "../types";
import { haversineKm, type AskContext } from "./intents";
import { runTool, TOOL_DECLARATIONS } from "./tools";
import { verifyCited } from "./verify";

const snapshot = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../public/snapshot.json", import.meta.url)), "utf-8"),
) as {
  captured_window: { newest_detection_at: string };
  analytics: Analytics;
  model: ModelInfo;
  locations: LocationSummary[];
  details: Record<string, HotspotDetail>;
};

const marks: MapMark[] = snapshot.locations.map(locationToMark);
const NOW = Date.parse(snapshot.captured_window.newest_detection_at) + 3_600_000;
const ctx: AskContext = {
  marks,
  analytics: snapshot.analytics,
  model: snapshot.model,
  provenance: snapshot.analytics.provenance,
  snapshot: null,
  mode: "historical",
  selected: null,
  now: NOW,
  loadDetail: async (id) => snapshot.details[id] ?? null,
};

describe("search_locations", () => {
  it("counts a class in a time window exactly", async () => {
    const run = await runTool("search_locations", { class: "natural_fire", seen_within_hours: 72 }, ctx);
    const expected = marks.filter(
      (m) => m.label === "natural_fire" && Date.parse(m.last_seen) >= NOW - 72 * 3_600_000,
    ).length;
    expect(run.facts[0].text).toContain(`: ${expected.toLocaleString()} match`);
  });

  it("filters to an area box and ranks by days seen", async () => {
    const area = { south: 23, west: 85.5, north: 24.5, east: 87, name: "Jharia" };
    const run = await runTool("search_locations", { class: "persistent_industrial", area }, ctx);
    const inside = marks.filter(
      (m) =>
        m.label === "persistent_industrial" &&
        m.latitude >= 23 && m.latitude <= 24.5 && m.longitude >= 85.5 && m.longitude <= 87,
    );
    expect(run.facts[0].text).toContain(`: ${inside.length} match`);
    const top = [...inside].sort((a, b) => b.distinct_days - a.distinct_days || b.frp_mw - a.frp_mw)[0];
    expect(run.facts[1].mark?.id).toBe(top.id);
  });

  it("says a named area is the assistant's approximation, not a boundary", async () => {
    const run = await runTool(
      "search_locations",
      { area: { south: 20.1, west: 68.1, north: 24.7, east: 74.5, name: "Gujarat" } },
      ctx,
    );
    expect(run.facts[0].text).toContain("the assistant's approximation of Gujarat (not an official boundary)");
  });

  it("lets a sentence name the place only by citing that disclaimed fact", async () => {
    const run = await runTool(
      "search_locations",
      { area: { south: 20.1, west: 68.1, north: 24.7, east: 74.5, name: "Gujarat" } },
      ctx,
    );
    const facts = run.facts.map((f, i) => ({ id: i + 1, text: f.text }));
    const count = run.facts[0].text.match(/: ([\d,]+) match/)![1];
    expect(
      verifyCited({ text: `Roughly around Gujarat there are ${count} locations.`, cites: [1] }, facts, "q").ok,
    ).toBe(true);
    expect(
      verifyCited({ text: `Roughly around Gujarat there are ${count} locations.`, cites: [2] }, facts, "q").ok,
    ).toBe(false);
  });

  it("lists the nearest locations first for a point search", async () => {
    const p = marks[500];
    const run = await runTool("search_locations", { near: { latitude: p.latitude, longitude: p.longitude, radius_km: 20 } }, ctx);
    expect(run.facts[1].mark?.id).toBe(p.id);
    const within = marks.filter((m) => haversineKm(p.latitude, p.longitude, m.latitude, m.longitude) <= 20).length;
    expect(run.facts[0].text).toContain(`: ${within.toLocaleString()} match`);
  });

  it("caps the list and ignores a nonsense area instead of trusting it", async () => {
    const run = await runTool("search_locations", { limit: 500, area: { south: 30, north: 10, west: 70, east: 80 } }, ctx);
    expect(run.facts.length).toBe(1 + 25);
    expect(run.facts[0].text).toContain(`: ${marks.length.toLocaleString()} matches`);
  });
});

describe("location_detail", () => {
  it("opens the nearest location's real evidence", async () => {
    const detail = Object.values(snapshot.details)[0];
    const run = await runTool("location_detail", { latitude: detail.latitude, longitude: detail.longitude }, ctx);
    const texts = run.facts.map((f) => f.text).join("\n");
    for (const e of detail.evidence) expect(texts).toContain(e.statement);
  });

  it("says plainly when nothing is near the point", async () => {
    const run = await runTool("location_detail", { latitude: -45, longitude: 170 }, ctx);
    expect(run.facts[0].text).toContain("No location in the data lies within");
  });

  it("reports a failed evidence fetch as a failure, not as no evidence", async () => {
    const m = marks[0];
    const failing: AskContext = { ...ctx, loadDetail: async () => { throw new Error("network"); } };
    const run = await runTool("location_detail", { latitude: m.latitude, longitude: m.longitude }, failing);
    expect(run.facts.map((f) => f.text).join(" ")).toContain("could not be loaded");
  });
});

describe("tool plumbing", () => {
  it("declares only tools that runTool can run", async () => {
    for (const t of TOOL_DECLARATIONS) {
      const run = await runTool(t.name, { latitude: marks[0].latitude, longitude: marks[0].longitude }, ctx);
      expect(run.summary).not.toContain("Unknown tool");
    }
  });

  it("the proxy accepts a tool conversation and pins a model", async () => {
    let url = "";
    let sent: { tools?: unknown; contents?: unknown[] } = {};
    const r = await handle(
      new Request("https://p/generate", {
        method: "POST",
        headers: { Origin: "https://jaystark16.github.io" },
        body: JSON.stringify({
          system: "s",
          contents: [{ role: "user", parts: [{ text: "q" }] }],
          tools: TOOL_DECLARATIONS,
          models: ["gemini-3.5-flash-lite"],
        }),
      }),
      { GEMINI_API_KEY: "k", ALLOWED_ORIGINS: "https://jaystark16.github.io" },
      (async (u: string, init: RequestInit) => {
        url = u;
        sent = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "search_locations", args: {} } }] } }] }));
      }) as unknown as typeof fetch,
    );
    const j = await r.json();
    expect(url).toContain("gemini-3.5-flash-lite");
    expect(sent.tools).toBeDefined();
    expect(j.content.parts[0].functionCall.name).toBe("search_locations");
  });

  it("the proxy refuses a model outside its list", async () => {
    const r = await handle(
      new Request("https://p/generate", {
        method: "POST",
        headers: { Origin: "https://jaystark16.github.io" },
        body: JSON.stringify({ system: "s", prompt: "q", models: ["some-other-model"] }),
      }),
      { GEMINI_API_KEY: "k", ALLOWED_ORIGINS: "https://jaystark16.github.io" },
    );
    expect(r.status).toBe(400);
  });
});
