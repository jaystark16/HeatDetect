/**
 * Gemini, as an analyst that can look things up.
 *
 * Reached through HeatDetect's proxy (proxy/worker.mjs), which holds the key,
 * or, on builds with no proxy URL, directly from the browser with a key
 * injected at build time (direct.ts explains that trade-off).
 *
 * Two phases per question:
 *
 * 1. Research. Gemini reads the conversation so far, a briefing of the whole
 *    picture, and the question, and calls tools (tools.ts) to search every
 *    location — by class, time, persistence, heat, area or point — or to open
 *    one location's evidence. Code runs each search over all loaded data and
 *    returns numbered facts. So questions are not limited to the briefing.
 * 2. Answer. Gemini writes a natural reply from all the facts, citing their
 *    numbers in every sentence; each sentence is checked against the facts it
 *    cites (verify.ts) and withheld if it does not hold.
 */

import { buildBriefing, renderFacts, type Fact } from "./briefing";
import { generateDirect, MODELS, type Content, type DirectRequest, type DirectResult } from "./direct";
import type { AskContext } from "./intents";
import { runTool, TOOL_DECLARATIONS } from "./tools";
import {
  verifyCited,
  verifyFollowUp,
  type CitedSentence,
  type CitedVerdict,
} from "./verify";

const BASE = (import.meta.env.VITE_ASSISTANT_URL ?? "").replace(/\/$/, "");

/** Used only when no proxy URL is set. Public once built: see direct.ts. */
const DIRECT_KEY = (import.meta.env.VITE_GEMINI_API_KEY ?? "").trim();

/** True when the build can reach Gemini through the proxy. */
export const GEMINI_VIA_PROXY = BASE !== "";

/** False when the build has neither a proxy URL nor a key. */
export const GEMINI_CONFIGURED = GEMINI_VIA_PROXY || DIRECT_KEY !== "";

/** Accuracy over speed: busy models are retried before lighter ones. */
const TIMEOUT_MS = 240_000;
/** Research rounds before answering with what has been found. */
const MAX_ROUNDS = 4;
/** Tool calls run per round; more are ignored. */
const MAX_CALLS_PER_ROUND = 4;
/** Facts carried into the answer, so a runaway search cannot swamp it. */
const MAX_FACTS = 260;
/** Earlier exchanges kept, so follow-ups ("and last week?") make sense. */
const HISTORY_TURNS = 4;

export type Depth = "brief" | "deep";

const SENTENCE = {
  type: "OBJECT",
  properties: {
    text: { type: "STRING" },
    cites: { type: "ARRAY", items: { type: "INTEGER" } },
  },
  required: ["text", "cites"],
};

const SCHEMAS: Record<Depth, object> = {
  brief: {
    type: "OBJECT",
    properties: { answer: { type: "ARRAY", items: SENTENCE } },
    required: ["answer"],
  },
  deep: {
    type: "OBJECT",
    properties: {
      answer: { type: "ARRAY", items: SENTENCE },
      analysis: { type: "ARRAY", items: SENTENCE },
      caveats: { type: "ARRAY", items: SENTENCE },
      follow_up_questions: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["answer", "analysis", "caveats", "follow_up_questions"],
  },
};

const ROLE = `You are the analyst assistant inside HeatDetect, a production system that classifies
satellite thermal anomalies — possible industrial fires, persistent industrial sources,
probable vegetation fires, or unclassified — over an analysis area around India, and
monitors persistent sources. Its data is real: NASA FIRMS detections, the system's
persistence statistics, its deterministic rules and its trained classifier.`;

const RESEARCH = `${ROLE}

Your job right now is to gather what is needed to answer the user's question. You have
a briefing of the whole picture, the conversation so far, and two tools that look things
up in all of the data:
- search_locations: filter every location by class, distinct days seen, peak fire
  radiative power, how recently seen, an area box, or a point and radius; get the count,
  the breakdown by class and the top matches.
- location_detail: the full evidence for the location nearest a point.

Call tools whenever the question needs anything the briefing does not already state:
a region, a class or time filter, a threshold, a specific location, a comparison. You
may call several, and search again with different filters. If the user names a place,
pass your best approximate box for it with its name; it will be reported as an
approximation. Interpret follow-ups ("what about last week?") using the conversation.
Do not write the answer here. When you have what you need, reply with the word DONE.`;

const RULES = `Rules for every sentence:
- Cite the fact numbers it rests on in "cites". Every sentence needs at least one.
- Use only numbers that appear in the facts you cite. You may round them. Do not
  calculate new numbers.
- Name a place, facility or source type only if a cited fact names it. A place named in
  a search fact is the assistant's approximate box, not an official boundary: say
  "around" or "roughly" for it.
- Compare locations only by citing a ranking fact (those marked #1, #2, ...).
- A thermal anomaly is evidence of unusual heat, not proof of a fire or accident. Use
  "possible", "probable" or "consistent with"; never "confirmed" or "definitely".
- State a cause only if a cited fact states it.
- Describe a count exactly as its fact does. A count of "locations of any class" is not
  a count of industrial ones; give the class breakdown instead. (Observed: 27 locations,
  12 of them unclassified, described as "27 consistent with industrial activity".)
- When a location's evidence was looked up, lead with how that location is classified.
- If the facts cannot answer the question, say so in one sentence and say what they
  can show.`;

const VOICE = `Write the way a sharp, friendly analyst colleague talks in chat: natural, direct, plain
words, no headings, no lists, no "based on the data provided", no restating the question.`;

const SYSTEMS: Record<Depth, string> = {
  // The default. The team wants a straight answer; depth is offered afterwards
  // and given only if asked for.
  brief: `${ROLE}

Answer the user's question from the numbered facts. ${VOICE} One to three short
sentences that carry the key numbers.

${RULES}`,
  deep: `${ROLE}

The user asked for a deeper analysis. Answer from the numbered facts, then analyse them
as an expert would: what stands out, what the patterns suggest, what the classifier's
measured reliability means here, and what an analyst should check next. ${VOICE}

${RULES}

Sections:
- answer: 1 to 3 sentences that directly answer the question.
- analysis: 2 to 6 sentences of reasoning that bear on the question.
- caveats: 0 to 3 sentences on limits that matter here (coverage, freshness, reliability).
- follow_up_questions: 0 to 3 short questions the user could ask next.`,
};

export interface Exchange {
  question: string;
  /** What the user was shown. */
  answer: string;
}

export interface GeminiAnswer {
  depth: Depth;
  model: string;
  /** Busy or failed attempts made before the answer, across both phases. */
  tried: { model: string; status: number }[];
  answer: CitedVerdict[];
  analysis: CitedVerdict[];
  caveats: CitedVerdict[];
  followUps: string[];
  withheld: number;
  seconds: number;
  /** Every fact available to the answer: the briefing, then each lookup. */
  facts: Fact[];
  /** What Gemini looked up, in plain words. */
  lookups: string[];
}

export class GeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiError";
  }
}

interface RawAnswer {
  answer?: CitedSentence[];
  analysis?: CitedSentence[];
  caveats?: CitedSentence[];
  follow_up_questions?: string[];
}

interface FunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

async function generate(request: DirectRequest, models?: string[]): Promise<DirectResult> {
  if (GEMINI_VIA_PROXY) {
    let response: Response;
    try {
      response = await fetch(`${BASE}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({ ...request, ...(models ? { models } : {}) }),
      });
    } catch (cause) {
      throw new GeminiError(
        cause instanceof DOMException && cause.name === "TimeoutError"
          ? "Gemini did not answer in time."
          : "The assistant service could not be reached.",
      );
    }
    const body = (await response.json().catch(() => null)) as DirectResult | null;
    if (!response.ok || !body?.model) {
      const tried = body?.tried?.map((t) => `${t.model} ${t.status}`).join(", ");
      throw new GeminiError(
        `${body?.error ?? `The assistant service returned ${response.status}`}${tried ? ` (tried: ${tried})` : ""}.`,
      );
    }
    return { ...body, ok: true };
  }

  let result: DirectResult;
  try {
    result = await generateDirect(request, DIRECT_KEY, models ?? MODELS);
  } catch {
    throw new GeminiError("Gemini could not be reached.");
  }
  if (!result.ok || !result.model) {
    const tried = result.tried.map((t) => `${t.model} ${t.status}`).join(", ");
    throw new GeminiError(`${result.error ?? "Gemini did not answer"}${tried ? ` (tried: ${tried})` : ""}.`);
  }
  return result;
}

function historyText(history: Exchange[]): string {
  const recent = history.slice(-HISTORY_TURNS);
  if (recent.length === 0) return "";
  return (
    "Conversation so far:\n" +
    recent.map((h) => `User: ${h.question}\nAssistant: ${h.answer}`).join("\n\n") +
    "\n\n"
  );
}

export async function askAgent(
  question: string,
  ctx: AskContext,
  history: Exchange[] = [],
  depth: Depth = "brief",
): Promise<GeminiAnswer> {
  if (!GEMINI_CONFIGURED) throw new GeminiError("No assistant service is configured.");
  const started = performance.now();

  const facts: Fact[] = [...buildBriefing(question, ctx).facts];
  const lookups: string[] = [];
  const tried: { model: string; status: number }[] = [];
  const earlier = historyText(history);

  // --- Phase 1: research.
  const contents: Content[] = [
    {
      role: "user",
      parts: [
        {
          text: `${earlier}Briefing:\n${renderFacts(facts)}\n\nQuestion: ${question}`,
        },
      ],
    },
  ];
  let pinned: string[] | undefined;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let reply: DirectResult;
    try {
      reply = await generate({ system: RESEARCH, contents, tools: TOOL_DECLARATIONS }, pinned);
    } catch (cause) {
      // Nothing found yet means nothing to answer from beyond the briefing;
      // with lookups already made, answer from those rather than lose them.
      if (round === 0) throw cause;
      break;
    }
    tried.push(...reply.tried);
    pinned ??= [reply.model!];

    const calls = (reply.content?.parts ?? [])
      .map((p) => p.functionCall as FunctionCall | undefined)
      .filter((c): c is FunctionCall => Boolean(c?.name))
      .slice(0, MAX_CALLS_PER_ROUND);
    if (calls.length === 0) break;

    // Resent exactly as received: tool calls carry signatures the model checks.
    contents.push(reply.content!);
    const responses = [];
    for (const call of calls) {
      const run = await runTool(call.name, call.args ?? {}, ctx);
      lookups.push(run.summary);
      const returned: { id: number; text: string }[] = [];
      for (const f of run.facts) {
        if (facts.length >= MAX_FACTS) break;
        facts.push({ id: facts.length + 1, section: `lookup: ${run.summary}`, text: f.text, mark: f.mark });
        returned.push({ id: facts.length, text: f.text });
      }
      responses.push({
        functionResponse: {
          ...(call.id ? { id: call.id } : {}),
          name: call.name,
          response: { facts: returned, ...(returned.length < run.facts.length ? { note: "truncated" } : {}) },
        },
      });
    }
    contents.push({ role: "user", parts: responses });
  }

  // --- Phase 2: answer, from every fact gathered. A fresh request, so any
  // model may write it.
  const reply = await generate({
    system: SYSTEMS[depth],
    prompt: `${earlier}Facts:\n${renderFacts(facts)}\n\nQuestion: ${question}`,
    schema: SCHEMAS[depth],
  });
  tried.push(...reply.tried);

  let raw: RawAnswer;
  try {
    raw = JSON.parse(reply.text ?? "") as RawAnswer;
  } catch {
    throw new GeminiError("Gemini's reply was not the structured answer requested.");
  }

  const check = (items: CitedSentence[] | undefined) =>
    (items ?? []).map((s) => verifyCited(s, facts, question));
  const answer = check(raw.answer);
  const analysis = check(raw.analysis);
  const caveats = check(raw.caveats);
  const followUps = (raw.follow_up_questions ?? [])
    .map((q) => (typeof q === "string" ? q.trim() : ""))
    .filter((q) => q && q.length <= 200 && verifyFollowUp(q, facts))
    .slice(0, 3);

  return {
    depth,
    model: reply.model!,
    tried,
    answer,
    analysis,
    caveats,
    followUps,
    withheld: [...answer, ...analysis, ...caveats].filter((v) => !v.ok).length,
    seconds: (performance.now() - started) / 1000,
    facts,
    lookups,
  };
}
