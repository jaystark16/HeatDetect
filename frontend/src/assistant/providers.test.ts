/**
 * The two model services behind the Ask tab: the agent's fallback between
 * them, the answer-shape check Ollama needs, and the proxy's Ollama route.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { handle, OLLAMA_MODELS } from "../../../proxy/worker.mjs";
import { locationToMark } from "../api";
import type { Analytics, LocationSummary, ModelInfo } from "../types";
import { askAgent, parseAnswer, type Provider } from "./gemini";
import type { AskContext } from "./intents";

const snapshot = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../public/snapshot.json", import.meta.url)), "utf-8"),
) as { captured_window: { newest_detection_at: string }; analytics: Analytics; model: ModelInfo; locations: LocationSummary[] };

const ctx: AskContext = {
  marks: snapshot.locations.map(locationToMark),
  analytics: snapshot.analytics,
  model: snapshot.model,
  provenance: snapshot.analytics.provenance,
  snapshot: null,
  mode: "historical",
  selected: null,
  now: Date.parse(snapshot.captured_window.newest_detection_at) + 3_600_000,
};

/** A provider whose replies are scripted, to drive the agent without a network. */
function scripted(name: Provider["name"], answers: string[], fail = false): Provider & { writes: string[] } {
  const writes: string[] = [];
  return {
    name,
    writes,
    research: () => ({
      step: async () => {
        if (fail) throw new Error(`${name} is down.`);
        return { model: `${name.toLowerCase()}-model`, tried: [], calls: [] };
      },
      results: () => {},
    }),
    write: async (_system, prompt) => {
      writes.push(prompt);
      return { model: `${name.toLowerCase()}-model`, text: answers[writes.length - 1] ?? "", tried: [] };
    },
  };
}

const totalCells = snapshot.analytics.total_cells.toLocaleString();
// The briefing's totals fact, whose number we can cite truthfully.
const totalsFact = (n: number) => JSON.stringify({ answer: [{ text: `There are ${totalCells} locations.`, cites: [n] }] });

describe("parsing an answer", () => {
  it("accepts JSON wrapped in a markdown fence, as Ollama models send it", () => {
    const fenced = '```json\n{"answer": [{"text": "There are 15 possible industrial fires.", "cites": [2]}]}\n```';
    const parsed = parseAnswer(fenced, "brief");
    expect(typeof parsed).toBe("object");
  });

  it("rejects a bare number as the answer (observed from gpt-oss:120b)", () => {
    expect(parseAnswer('{ "answer": 15, "citations": [2] }', "brief")).toContain('"answer"');
  });

  it("rejects prose", () => {
    expect(parseAnswer("There are **15 possible industrial fires** [2].", "brief")).toBe("it was not JSON");
  });
});

describe("the agent", () => {
  it("falls back to the next service when the first fails, and says which answered", async () => {
    const down = scripted("Ollama", [], true);
    const facts = (await import("./briefing")).buildBriefing("how many locations?", ctx).facts;
    const id = facts.find((f) => /detections at .* locations\.$/.test(f.text))!.id;
    const up = scripted("Gemini", [totalsFact(id)]);
    const result = await askAgent("how many locations?", ctx, [], "brief", [down, up]);
    expect(result.provider).toBe("Gemini");
    expect(result.answer[0].ok).toBe(true);
  });

  it("gives a wrongly shaped reply one second chance, with the reason", async () => {
    const facts = (await import("./briefing")).buildBriefing("how many locations?", ctx).facts;
    const id = facts.find((f) => /detections at .* locations\.$/.test(f.text))!.id;
    const p = scripted("Ollama", ['{ "answer": 15, "citations": [2] }', totalsFact(id)]);
    const result = await askAgent("how many locations?", ctx, [], "brief", [p]);
    expect(p.writes).toHaveLength(2);
    expect(p.writes[1]).toContain("could not be used because");
    expect(result.provider).toBe("Ollama");
  });

  it("fails loudly, naming every service, when none can answer", async () => {
    await expect(
      askAgent("q", ctx, [], "brief", [scripted("Ollama", [], true), scripted("Gemini", [], true)]),
    ).rejects.toThrow(/Ollama is down\. Gemini is down\./);
  });
});

describe("the proxy's Ollama route", () => {
  const SITE = "https://jaystark16.github.io";
  const env = { OLLAMA_API_KEY: "ollama-test-key", ALLOWED_ORIGINS: SITE };
  const req = (body: object) =>
    new Request("https://p/ollama/chat", {
      method: "POST",
      headers: { Origin: SITE },
      body: JSON.stringify(body),
    });

  it("sends the key as a bearer token, never in the reply", async () => {
    let auth = "";
    let sent: { model?: string; stream?: boolean } = {};
    const r = await handle(req({ messages: [{ role: "user", content: "q" }] }), env, (async (
      _u: string,
      init: RequestInit,
    ) => {
      auth = (init.headers as Record<string, string>).Authorization;
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ message: { role: "assistant", content: "hi" } }));
    }) as unknown as typeof fetch);
    expect(auth).toBe("Bearer ollama-test-key");
    expect(sent.model).toBe(OLLAMA_MODELS[0]);
    expect(sent.stream).toBe(false);
    expect(await r.text()).not.toContain("ollama-test-key");
  });

  it("moves past a model outside the plan (402)", async () => {
    const models: string[] = [];
    const r = await handle(req({ messages: [{ role: "user", content: "q" }] }), env, (async (
      _u: string,
      init: RequestInit,
    ) => {
      const m = JSON.parse(String(init.body)).model;
      models.push(m);
      return m === OLLAMA_MODELS[0]
        ? new Response("{}", { status: 402 })
        : new Response(JSON.stringify({ message: { role: "assistant", content: "ok" } }));
    }) as unknown as typeof fetch);
    expect((await r.json()).model).toBe(OLLAMA_MODELS[1]);
    expect(models).toEqual([OLLAMA_MODELS[0], OLLAMA_MODELS[1]]);
  });

  it("refuses models outside its list and bad roles", async () => {
    expect((await handle(req({ messages: [{ role: "user", content: "q" }], models: ["deepseek-v4.1-flash"] }), env)).status).toBe(400);
    expect((await handle(req({ messages: [{ role: "admin", content: "q" }] }), env)).status).toBe(400);
  });

  it("reports Ollama unconfigured instead of failing silently", async () => {
    const r = await handle(req({ messages: [{ role: "user", content: "q" }] }), { ALLOWED_ORIGINS: SITE });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toContain("ollama is not configured");
  });
});

describe("follow-ups", () => {
  it("hand the earlier search's exact filters to the next question (observed: Odisha 66, then 61)", async () => {
    const odisha = { class: "persistent_industrial", area: { south: 17.5, west: 81.5, north: 22.8, east: 87.5, name: "Odisha" } };
    const researching = (prompts: string[]): Provider => {
      let step = 0;
      return {
        name: "Ollama",
        research: (_system, userText) => {
          prompts.push(userText);
          return {
            step: async () => ({
              model: "m",
              tried: [],
              calls: step++ === 0 ? [{ name: "search_locations", args: odisha }] : [],
            }),
            results: () => {},
          };
        },
        write: async () => ({ model: "m", text: '{"answer": [{"text": "Listed below.", "cites": [1]}]}', tried: [] }),
      };
    };

    const prompts: string[] = [];
    const first = await askAgent("how many persistent industrial sources are in odisha", ctx, [], "brief", [researching(prompts)]);
    expect(first.calls).toEqual([{ name: "search_locations", args: odisha }]);

    await askAgent(
      "give me those locations",
      ctx,
      [{ question: "how many persistent industrial sources are in odisha", answer: "There are 66.", calls: first.calls }],
      "brief",
      [researching(prompts)],
    );
    expect(prompts[1]).toContain(`Assistant looked up: search_locations ${JSON.stringify(odisha)}`);
  });
});
