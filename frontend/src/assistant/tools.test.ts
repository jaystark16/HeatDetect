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
import { answerLocations } from "./locations";
import { INDIAN_REGIONS, matchRegion, runTool, TOOL_DECLARATIONS } from "./tools";
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

  it("caps the list at 25 rows", async () => {
    const run = await runTool("search_locations", { limit: 500 }, ctx);
    expect(run.facts.length).toBe(1 + 25);
    expect(run.facts[0].text).toContain(`: ${marks.length.toLocaleString()} matches`);
  });

  it("refuses a nonsense area instead of searching everywhere", async () => {
    const run = await runTool("search_locations", { area: { south: 30, north: 10, west: 70, east: 80 } }, ctx);
    expect(run.error).toContain("south < north");
    expect(run.facts).toHaveLength(0);
  });

  it("refuses an unknown class instead of answering for all classes (observed from gpt-oss)", async () => {
    const run = await runTool("search_locations", { class: "vegetation fire", seen_within_hours: 24 }, ctx);
    expect(run.error).toContain('got "vegetation fire"');
    expect(run.error).toContain("natural_fire");
    expect(run.facts).toHaveLength(0);
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

describe("naming the place the user asked about", () => {
  // As gemini.ts numbers them: each lookup fact carries what was searched.
  const asFacts = (run: Awaited<ReturnType<typeof runTool>>) =>
    run.facts.map((f, i) => ({ id: i + 1, text: f.text, section: `lookup: ${run.summary}` }));
  const vizag = {
    class: "persistent_industrial",
    area: { south: 17, west: 82.5, north: 18.5, east: 84.5 },
    near: { latitude: 17.7, longitude: 83.3, radius_km: 50 },
  };

  it("accepts the user's own place name for an unlabelled area search (observed: Vizag withheld)", async () => {
    const run = await runTool("search_locations", vizag, ctx);
    const facts = asFacts(run);
    const top = run.facts[1];
    expect(top?.mark).toBeDefined();
    const lat = top!.mark!.latitude.toFixed(3);
    const v = verifyCited(
      { text: `The most persistent industrial source around Vizag is at ${lat}° N. [2]`, cites: [2] },
      facts,
      "can you give me the coordinates where its detecting persistent industrial source in vizag",
    );
    expect(v.reason).toBeUndefined();
    expect(v.ok).toBe(true);
  });

  it("still refuses a place the user never mentioned", async () => {
    const facts = asFacts(await runTool("search_locations", vizag, ctx));
    const v = verifyCited(
      { text: "The sources around Chennai are listed. [1]", cites: [1] },
      facts,
      "persistent industrial sources in vizag",
    );
    expect(v.ok).toBe(false);
  });

  it("does not let a second place borrow a search the model labelled as another", async () => {
    const run = await runTool(
      "search_locations",
      { ...vizag, area: { ...vizag.area, name: "Visakhapatnam" }, near: undefined },
      ctx,
    );
    const facts = asFacts(run);
    const q = "compare vizag and gujarat";
    expect(verifyCited({ text: "The search around Gujarat found sources. [1]", cites: [1] }, facts, q).ok).toBe(false);
    // The labelled name is allowed even from a ranked match that does not repeat it.
    expect(verifyCited({ text: "The top source around Visakhapatnam is listed. [2]", cites: [2] }, facts, q).ok).toBe(true);
  });

  it("refuses a place name when the cited facts are not about any place", async () => {
    const facts = asFacts(await runTool("search_locations", { class: "persistent_industrial" }, ctx));
    const v = verifyCited({ text: "The sources around Vizag are listed. [1]", cites: [1] }, facts, "sources in vizag");
    expect(v.ok).toBe(false);
  });

  it("carries a named point into the search fact with its disclaimer", async () => {
    const run = await runTool(
      "search_locations",
      { near: { latitude: 17.7, longitude: 83.3, radius_km: 50, name: "Vizag" } },
      ctx,
    );
    expect(run.facts[0].text).toContain("the assistant's approximation of Vizag (not an official position)");
  });
});

describe("locations listed under an answer", () => {
  const numbered = (runs: Awaited<ReturnType<typeof runTool>>[]) => {
    let id = 0;
    return runs.flatMap((run) =>
      run.facts.map((f) => ({ id: ++id, section: `lookup: ${run.summary}`, text: f.text, mark: f.mark })),
    );
  };

  it("lists a search's matches when the answer cites only its total (observed: count, no locations)", async () => {
    const run = await runTool("search_locations", { seen_within_hours: 24, limit: 25 }, ctx);
    const facts = numbered([run]);
    const list = answerLocations(facts, [1]);
    const expected = run.facts.filter((f) => f.mark).map((f) => f.mark!.id);
    expect(list.marks.map((m) => m.id)).toEqual(expected);
    const total = marks.filter((m) => Date.parse(m.last_seen) >= NOW - 24 * 3_600_000).length;
    expect(list.heading).toBe(
      total <= 25
        ? `All ${total.toLocaleString()}, ranked by distinct days seen`
        : `Top 25 of ${total.toLocaleString()}, ranked by distinct days seen`,
    );
  });

  it("says nearest first for a point search", async () => {
    const run = await runTool("search_locations", { near: { latitude: 23.75, longitude: 86.42, radius_km: 5 } }, ctx);
    expect(answerLocations(numbered([run]), [1]).heading).toMatch(/, nearest first$/);
  });

  it("drops the heading when the list mixes two searches", async () => {
    const a = await runTool("search_locations", { class: "persistent_industrial", limit: 3 }, ctx);
    const b = await runTool("search_locations", { class: "natural_fire", limit: 3 }, ctx);
    const facts = numbered([a, b]);
    const totals = facts.filter((f) => f.text.startsWith("Search of all")).map((f) => f.id);
    const list = answerLocations(facts, totals);
    expect(list.heading).toBeNull();
    expect(list.marks).toHaveLength(6);
  });

  it("lists only the cited location when the answer cites one match", async () => {
    const run = await runTool("search_locations", { class: "persistent_industrial", limit: 5 }, ctx);
    const facts = numbered([run]);
    const list = answerLocations(facts, [2]);
    expect(list.marks.map((m) => m.id)).toEqual([run.facts[1].mark!.id]);
    expect(list.heading).toBeNull();
  });
});

describe("searching a state or country by its real boundary", () => {
  const boundaries = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../backend/data/boundaries/india_states.geojson", import.meta.url)), "utf-8"),
  ) as { features: { properties: { name: string } }[] };

  it("knows exactly the 36 states and union territories in the boundary data", () => {
    expect([...INDIAN_REGIONS].sort()).toEqual(boundaries.features.map((f) => f.properties.name).sort());
  });

  it("counts a state exactly, from the region each location carries", async () => {
    const run = await runTool("search_locations", { class: "persistent_industrial", region: "Odisha" }, ctx);
    const inside = marks.filter((m) => m.label === "persistent_industrial" && m.region === "Odisha");
    expect(inside.length).toBeGreaterThan(0);
    expect(run.error).toBeUndefined();
    expect(run.facts[0].text).toContain("in Odisha (state or union territory boundary, India's official map)");
    expect(run.facts[0].text).toContain(`: ${inside.length} match`);
    expect(run.facts[1].text).toContain("in Odisha, India");
  });

  it("reports locations too close to the boundary to be sure of", async () => {
    const run = await runTool("search_locations", { region: "Punjab" }, ctx);
    const uncertain = marks.filter((m) => m.region === "Punjab" && m.region_alternatives.length).length;
    const edge = marks.filter((m) => m.region !== "Punjab" && m.region_alternatives.includes("Punjab")).length;
    expect(uncertain + edge).toBeGreaterThan(0);
    if (uncertain) expect(run.facts[0].text).toContain(`${uncertain.toLocaleString()} of them`);
    if (edge) expect(run.facts[0].text).toContain(`${edge.toLocaleString()} more just outside`);
  });

  it("accepts common spellings and countries", () => {
    expect(matchRegion("Orissa", marks)).toEqual({ name: "Odisha", country: false });
    expect(matchRegion("pondicherry", marks)).toEqual({ name: "Puducherry", country: false });
    expect(matchRegion("J&K", marks)).toEqual({ name: "Jammu and Kashmir", country: false });
    expect(matchRegion("Daman & Diu", marks)?.name).toBe("Dadra and Nagar Haveli and Daman and Diu");
    expect(matchRegion("nepal", marks)).toEqual({ name: "Nepal", country: true });
    expect(matchRegion("India", marks)).toEqual({ name: "India", country: true });
  });

  it("answers 0 for a state with no detections instead of calling it unknown", async () => {
    const run = await runTool("search_locations", { region: "Lakshadweep" }, ctx);
    expect(run.error).toBeUndefined();
    expect(run.facts[0].text).toContain(
      `: ${marks.filter((m) => m.region === "Lakshadweep").length} match`,
    );
  });

  it("refuses a city as a region and says what to use instead", async () => {
    const run = await runTool("search_locations", { region: "Vizag" }, ctx);
    expect(run.error).toContain("use area or near instead");
  });

  it("counts a country, India included", async () => {
    const run = await runTool("search_locations", { region: "India" }, ctx);
    expect(run.facts[0].text).toContain(`: ${marks.filter((m) => m.country === "India").length.toLocaleString()} match`);
  });

  it("lets the answer say 'in Odisha' from the search fact", async () => {
    const run = await runTool("search_locations", { class: "persistent_industrial", region: "Odisha" }, ctx);
    const facts = run.facts.map((f, i) => ({ id: i + 1, text: f.text, section: `lookup: ${run.summary}` }));
    const n = run.facts[0].text.match(/: ([\d,]+) match/)![1];
    const v = verifyCited({ text: `There are ${n} persistent industrial sources in Odisha. [1]`, cites: [1] }, facts, "odisha?");
    expect(v.reason).toBeUndefined();
  });
});
