/**
 * The Gemini path: the briefing it sees, the check on each cited sentence,
 * and the proxy that holds the key. Briefing facts are checked against values
 * recomputed here from the real snapshot, not against themselves.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { handle, MODELS, RETRY_DELAYS_MS } from "../../../proxy/worker.mjs";
import { locationToMark } from "../api";
import type { Analytics, LocationSummary, MapMark, ModelInfo } from "../types";
import { buildBriefing, renderFacts } from "./briefing";
import type { AskContext } from "./intents";
import { verifyCited, verifyFollowUp } from "./verify";

const snapshot = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../public/snapshot.json", import.meta.url)), "utf-8"),
) as {
  captured_window: { newest_detection_at: string };
  analytics: Analytics;
  model: ModelInfo;
  locations: LocationSummary[];
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
};

const briefing = buildBriefing("give me an overall analysis", ctx);
const fact = (pattern: RegExp) => briefing.facts.find((f) => pattern.test(f.text))!;

describe("the briefing", () => {
  it("numbers facts 1..n with no gaps, as the citations assume", () => {
    expect(briefing.facts.map((f) => f.id)).toEqual(briefing.facts.map((_, i) => i + 1));
    expect(renderFacts(briefing.facts)).toContain(`[${briefing.facts.length}] `);
  });

  it("states the totals the analytics report", () => {
    const a = snapshot.analytics;
    expect(fact(/detections at .* locations\.$/).text).toBe(
      `${a.total_detections.toLocaleString()} detections at ${a.total_cells.toLocaleString()} locations.`,
    );
  });

  it("ranks the most persistent industrial source correctly", () => {
    const top = marks
      .filter((m) => m.label === "persistent_industrial")
      .sort((x, y) => y.distinct_days - x.distinct_days || y.frp_mw - x.frp_mw)[0];
    const f = fact(/^#1 most persistent industrial source/);
    expect(f.mark?.id).toBe(top.id);
    expect(f.text).toContain(`seen on ${top.distinct_days} distinct days`);
  });

  it("counts the densest one-degree area of industrial sources correctly", () => {
    const cells = new Map<string, number>();
    for (const m of marks.filter((x) => x.label === "persistent_industrial")) {
      const key = `${Math.floor(m.latitude)}:${Math.floor(m.longitude)}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    const densest = Math.max(...cells.values());
    expect(fact(/^#1 one-degree area by number of persistent industrial sources/).text).toContain(
      `, ${densest} persistent industrial sources.`,
    );
  });

  it("says the analysis area is not only India", () => {
    expect(briefing.facts[0].text).toContain("not necessarily in India");
  });
});

describe("checking a cited sentence", () => {
  const top = fact(/^#1 most persistent industrial source/);
  const total = fact(/detections at .* locations\.$/);
  const days = top.text.match(/seen on (\d+) distinct days/)![1];

  it("accepts a sentence whose numbers are in the facts it cites", () => {
    const v = verifyCited(
      { text: `The most persistent industrial source was seen on ${days} distinct days.`, cites: [top.id] },
      briefing.facts,
      "q",
    );
    expect(v).toMatchObject({ ok: true });
  });

  it("rejects a true number cited to the wrong fact", () => {
    const v = verifyCited(
      { text: `The most persistent industrial source was seen on ${days} distinct days.`, cites: [total.id] },
      briefing.facts,
      "q",
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toContain(days);
  });

  it("rejects a sentence with no citation, or citing a fact that does not exist", () => {
    expect(verifyCited({ text: "Heat is concentrated.", cites: [] }, briefing.facts, "q").reason).toBe(
      "it cited no fact",
    );
    expect(verifyCited({ text: "Heat is concentrated.", cites: [9999] }, briefing.facts, "q").ok).toBe(false);
  });

  it("rejects arithmetic the facts do not state (observed: 19,889 - 16,715 = 3,174)", () => {
    const coverage = fact(/^Coverage:/);
    const v = verifyCited(
      { text: "Of these cells, 3174 have no surveyed industrial context.", cites: [coverage.id] },
      briefing.facts,
      "q",
    );
    expect(v.reason).toContain("3174");
  });

  it("rejects a place name the cited facts do not contain", () => {
    const v = verifyCited(
      { text: `The leading source, in Gujarat, was seen on ${days} distinct days.`, cites: [top.id] },
      briefing.facts,
      "is there a refinery fire in Gujarat?",
    );
    expect(v.ok).toBe(false);
  });

  it("rejects a source type the cited facts do not establish", () => {
    const v = verifyCited(
      { text: `The refinery was seen on ${days} distinct days.`, cites: [top.id] },
      briefing.facts,
      "q",
    );
    expect(v.reason).toContain("refinery");
  });

  it("allows a comparison backed by a cited ranking, refuses one that is not", () => {
    const ranked = verifyCited(
      { text: `It is the most persistent, at ${days} days.`, cites: [top.id] },
      briefing.facts,
      "q",
    );
    expect(ranked.ok).toBe(true);
    const unranked = verifyCited(
      { text: "There are more detections than locations.", cites: [total.id] },
      briefing.facts,
      "q",
    );
    expect(unranked.ok).toBe(false);
  });

  it("rejects certainty and unstated causes", () => {
    expect(verifyCited({ text: "This is a confirmed fire.", cites: [top.id] }, briefing.facts, "q").ok).toBe(false);
    expect(
      verifyCited({ text: "It burns because of a gas leak.", cites: [top.id] }, briefing.facts, "q").ok,
    ).toBe(false);
  });

  it("checks spelled-out and rounded numbers like digits (observed: 'Seventy-two', '94 thousand')", () => {
    const facts = [
      { id: 1, text: "Search of all 32,138 locations for persistent industrial sources, in Odisha: 72 matches." },
      { id: 2, text: "94,238 detections at 32,138 locations; 3 within 50 km of the point." },
    ];
    const check = (text: string, cites = [1, 2]) => verifyCited({ text, cites }, facts, "how many?");
    expect(check("Seventy-two persistent industrial sources are in Odisha.").ok).toBe(true);
    expect(check("Seventy-three persistent industrial sources are in Odisha.").ok).toBe(false);
    expect(check("Three spots showed heat, all persistent industrial sources.").ok).toBe(true);
    expect(check("Four spots showed heat.").ok).toBe(false);
    expect(check("There were about 94,000 detections.").ok).toBe(true);
    expect(check("There were about 95,000 detections.").ok).toBe(false);
    expect(check("There were 94,000 detections.").ok).toBe(false); // rounding needs a hedge
    expect(check("There were roughly 94 thousand detections.").ok).toBe(true);
    expect(check("There were 94k detections.").ok).toBe(true);
    expect(check("Around ninety-four thousand detections were made.").ok).toBe(true);
    expect(check("There were 9 lakh detections.").ok).toBe(false);
    expect(check("One of them is a persistent industrial source with 72 sightings.").ok).toBe(true);
  });

  it("reads a percentage as the fraction a fact states (observed: 0.926 written as 93%)", () => {
    const facts = [{ id: 1, text: "natural_fire: precision 0.926, recall 0.971." }];
    const check = (text: string) => verifyCited({ text, cites: [1] }, facts, "trust?");
    expect(check("It is right about 93% of the time on vegetation fires.").ok).toBe(true);
    expect(check("Its recall there is 97.1 percent.").ok).toBe(true);
    expect(check("It is right 95% of the time.").ok).toBe(false);
  });

  it("lets a negated certainty word through as the hedge it is (observed: withheld for 'confirms')", () => {
    const check = (text: string) => verifyCited({ text, cites: [top.id] }, briefing.facts, "q");
    expect(check("Nothing in the data confirms an accident there.").ok).toBe(true);
    expect(check("It is not confirmed as a fire.").ok).toBe(true);
    expect(check("The data cannot say for sure what is burning.").ok).toBe(true);
    expect(check("This is definitely an industrial accident.").ok).toBe(false);
    expect(check("There is no doubt this is confirmed.").ok).toBe(false);
    expect(check("Not only that, it is confirmed by the rules and definitely a fire.").ok).toBe(false);
  });

  it("allows hedged interpretation", () => {
    const v = verifyCited(
      { text: `Being seen on ${days} distinct days is consistent with a long-running heat source.`, cites: [top.id] },
      briefing.facts,
      "q",
    );
    expect(v.ok).toBe(true);
  });

  it("drops follow-up questions that name or number something absent", () => {
    expect(verifyFollowUp("Which locations were seen in the last 24 hours?", briefing.facts)).toBe(true);
    expect(verifyFollowUp("What is burning in Jharkhand?", briefing.facts)).toBe(false);
  });
});

describe("the proxy", () => {
  const SITE = "https://jaystark16.github.io";
  const env = { GEMINI_API_KEY: "test-key", ALLOWED_ORIGINS: SITE };
  const body = JSON.stringify({ system: "s", prompt: "p", schema: { type: "OBJECT" } });
  const post = (origin = SITE, payload = body) =>
    new Request("https://proxy.example/generate", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: payload,
    });
  const google = (status: number, text = '{"answer":[]}') =>
    new Response(
      status === 200 ? JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) : "{}",
      { status },
    );

  it("refuses other origins and never calls Google for them", async () => {
    let called = false;
    const r = await handle(post("https://evil.example"), env, (async () => {
      called = true;
      return google(200);
    }) as typeof fetch);
    expect(r.status).toBe(403);
    expect(called).toBe(false);
  });

  it("answers the browser's preflight only for allowed origins", async () => {
    const pre = (origin: string) =>
      handle(new Request("https://proxy.example/generate", { method: "OPTIONS", headers: { Origin: origin } }), env);
    expect((await pre(SITE)).headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect((await pre("https://evil.example")).status).toBe(403);
  });

  it("reports an unconfigured key instead of failing silently", async () => {
    const r = await handle(post(), { ALLOWED_ORIGINS: SITE });
    expect(r.status).toBe(503);
  });

  it("sends the key in a header, never in the URL or the reply", async () => {
    let url = "";
    let header = "";
    const r = await handle(post(), env, (async (u: string, init: RequestInit) => {
      url = u;
      header = (init.headers as Record<string, string>)["x-goog-api-key"];
      return google(200);
    }) as unknown as typeof fetch);
    expect(url).not.toContain("test-key");
    expect(header).toBe("test-key");
    expect(await r.text()).not.toContain("test-key");
  });

  const noWait = async () => {};
  const modelOf = (u: string) => u.split("/models/")[1].split(":")[0];

  it("retries a busy model before falling back, preferring the stronger answer", async () => {
    const calls: string[] = [];
    const r = await handle(
      post(),
      env,
      (async (u: string) => {
        calls.push(modelOf(u));
        return calls.length < 3 ? google(503) : google(200);
      }) as unknown as typeof fetch,
      noWait,
    );
    const j = await r.json();
    expect(r.status).toBe(200);
    // Busy twice, then answered: still the first (strongest) model.
    expect(calls).toEqual([MODELS[0], MODELS[0], MODELS[0]]);
    expect(j.model).toBe(MODELS[0]);
  });

  it("moves to the next model once a busy one has used its retries", async () => {
    const calls: string[] = [];
    const r = await handle(
      post(),
      env,
      (async (u: string) => {
        calls.push(modelOf(u));
        return modelOf(u) === MODELS[0] ? google(503) : google(200);
      }) as unknown as typeof fetch,
      noWait,
    );
    const j = await r.json();
    expect(calls.filter((m) => m === MODELS[0])).toHaveLength(RETRY_DELAYS_MS.length + 1);
    expect(j.model).toBe(MODELS[1]);
  });

  it("moves straight past a rate-limited model, whose quota is its own", async () => {
    const calls: string[] = [];
    await handle(
      post(),
      env,
      (async (u: string) => {
        calls.push(modelOf(u));
        return modelOf(u) === MODELS[0] ? google(429) : google(200);
      }) as unknown as typeof fetch,
      noWait,
    );
    expect(calls).toEqual([MODELS[0], MODELS[1]]);
  });

  it("does not retry a retired model", async () => {
    const calls: string[] = [];
    await handle(
      post(),
      env,
      (async (u: string) => {
        calls.push(modelOf(u));
        return modelOf(u) === MODELS[0] ? google(404) : google(200);
      }) as unknown as typeof fetch,
      noWait,
    );
    expect(calls).toEqual([MODELS[0], MODELS[1]]);
  });

  it("stops at a request Google rejects as malformed", async () => {
    let count = 0;
    const r = await handle(post(), env, (async () => {
      count++;
      return google(400);
    }) as typeof fetch);
    expect(r.status).toBe(503);
    expect(count).toBe(1);
  });

  it("refuses a malformed request without calling Google", async () => {
    let called = false;
    const r = await handle(post(SITE, JSON.stringify({ prompt: "p" })), env, (async () => {
      called = true;
      return google(200);
    }) as typeof fetch);
    expect(r.status).toBe(400);
    expect(called).toBe(false);
  });

  it("lists models best first", () => {
    expect(MODELS[0]).not.toContain("lite");
    expect(MODELS.at(-1)).toContain("lite");
  });
});
