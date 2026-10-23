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

/** True when the build has the key-holding proxy, which serves Ollama and Gemini. */
export const VIA_PROXY = BASE !== "";
/** Kept for callers that still use the older name. */
export const GEMINI_VIA_PROXY = VIA_PROXY;

/** True when Gemini is reachable, through the proxy or with a build-time key. */
const GEMINI_CONFIGURED = VIA_PROXY || DIRECT_KEY !== "";

/** False when the build can reach no model service at all. */
export const ASSISTANT_CONFIGURED = VIA_PROXY || GEMINI_CONFIGURED;

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

First work out what the user means, the way a thoughtful person would. People type fast:
"tell what happend in 24 hrs", "locations of all these spots mentioned in now". Read past
typos and shorthand. Follow-ups lean on the conversation: "these spots", "them", "those",
"all of them" usually mean everything the previous answer counted (for example every place
seen in the last 24 hours), not only the one or two it happened to name, so repeat that
search's filters exactly. Small talk (hello, thanks, how are you, who are you, what can
you do) needs no lookup: reply DONE straight away.

Call tools whenever the question needs anything the briefing does not already state:
a region, a class or time filter, a threshold, a specific location, a comparison. You
may call several, and search again with different filters. If the user names an Indian
state or union territory, or a country, search with region: it uses the real boundary.
Do not add an area box to a region search unless the user asked for part of it; a box
can cut off the region's edges. For any other place, such as a city, pass your best
approximate box or point with its name; it will be reported as an approximation. When the
user asks for locations, coordinates, a list, "which ones" or "all of them", search with
list_all true, a limit of 25 and the sort that fits the question; the page then lists every
match, not only those 25. For "now", "right now", "currently" or "today", search the last 24 hours: the
satellites pass over a given spot only a few times a day, so a shorter window usually finds
nothing even where there is heat. Do not write the answer here. When you have what you
need, reply with the word DONE.`;

const RULES = `Rules for every sentence:
- Cite the fact numbers it rests on in "cites". Every sentence that says anything about the
  data needs at least one.
- A sentence that says nothing about the data, such as a greeting, thanks, an offer to help
  or a question back to the user, has "cites": [] and must hold no number, no place, no
  kind of heat source and no amount ("most", "many"). Never recite statistics nobody asked
  for: "hello" gets "Hi! What would you like to know?", not a count of detections.
- Asked what you can do, say it from the fact that lists what this assistant can do, and
  cite it.
- Use only numbers that appear in the facts you cite. You may round them. Do not
  calculate new numbers.
- Name a place, facility or source type only if a cited fact names it. A state, union
  territory or country searched by region is its real boundary: say "in Odisha". A place
  given as "the assistant's approximation of" is only a box: say "around" or "roughly".
- When a search fact says some matches lie within 1.5 km of another state or country,
  mention it if it changes the answer: those locations may lie on the other side.
- Compare locations only by citing a ranking fact (those marked #1, #2, ...).
- A thermal anomaly is evidence of unusual heat, not proof of a fire or accident. Use
  "possible", "probable" or "consistent with"; never "confirmed" or "definitely".
- State a cause only if a cited fact states it.
- Describe a count exactly as its fact does. A count of "locations of any class" is not
  a count of industrial ones; give the class breakdown instead. (Observed: 27 locations,
  12 of them unclassified, described as "27 consistent with industrial activity".)
- When a location's evidence was looked up, lead with how that location is classified.
- When the user asks for locations or a list, cite the search fact ("Search of all …")
  together with its ranked matches. The page lists every place that search found, with
  coordinates, map links and a CSV download, under your answer. Say how many there are
  and that they are listed below, and name only the top one or two in the sentence.
- If a data question cannot be answered from the facts, say so plainly in one sentence and
  offer what you can look up instead.`;

// Measured 2026-10-23: with only "be natural", every model wrote report prose
// ("There are 3 matches around Vizag, all of which are classified as…").
const VOICE = `Write like an experienced analyst talking to a colleague in chat, not like a report:
- Lead with the answer itself: the number, the place, or what the data shows.
- Plain words. Say "places" or "spots", never "matches", "locations of any class", "cells"
  or "records", and never "detections were detected".
- Use the place names the facts give ("in Odisha", "around Vizag").
- Round numbers the way people say them ("about 10 MW", "49 days") unless an exact count
  is the point.
- Give a sentence one or two numbers, not a list of them.
- No headings, no bullet points, no "based on the data provided", no restating the question.
For example, instead of "There are 3 matches around Vizag, all of which are classified as
persistent industrial sources", write "Three spots around Vizag showed heat in the last 24
hours, and all three are persistent industrial sources." That is style only: every number
and name still comes from the facts.`;

const SYSTEMS: Record<Depth, string> = {
  // The default. The team wants a straight answer; depth is offered afterwards
  // and given only if asked for.
  brief: `${ROLE}

Reply to what the user actually meant, as a person would in chat. Answer data questions
from the numbered facts, usually in one to three short sentences; answer small talk in
one friendly sentence and offer to help.

${VOICE}

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
  /** The tool calls behind that answer, exactly as made. */
  calls?: ToolCall[];
  /** What the page listed under the answer, e.g. "All 1,602, ranked by …". */
  listed?: string;
}

export interface GeminiAnswer {
  /** Which service answered. */
  provider: "Ollama" | "Gemini";
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
  /** What the model looked up, in plain words. */
  lookups: string[];
  /** The same lookups as calls, so a follow-up can repeat their exact filters. */
  calls: ToolCall[];
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

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

type Tried = { model: string; status: number }[];

/** One model conversation during research. */
interface ResearchSession {
  /** Ask once; record the model's message; return the tools it called (none = done). */
  step(): Promise<{ model: string; tried: Tried; calls: ToolCall[] }>;
  /** Hand tool results back, one per call, in order. */
  results(items: { call: ToolCall; response: object }[]): void;
}

/** A model service that can research with tools and then write the answer. */
export interface Provider {
  name: "Ollama" | "Gemini";
  research(system: string, userText: string): ResearchSession;
  /** The final answer as JSON text in the shape SHAPES[depth] describes. */
  write(system: string, prompt: string, depth: Depth): Promise<{ model: string; text: string; tried: Tried }>;
}

// ------------------------------------------------------------------ Gemini --

async function generate(request: DirectRequest, models?: string[]): Promise<DirectResult> {
  if (VIA_PROXY) {
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

const gemini: Provider = {
  name: "Gemini",
  research(system, userText) {
    const contents: Content[] = [{ role: "user", parts: [{ text: userText }] }];
    let pinned: string[] | undefined;
    return {
      async step() {
        const reply = await generate({ system, contents, tools: TOOL_DECLARATIONS }, pinned);
        pinned ??= [reply.model!];
        const calls = (reply.content?.parts ?? [])
          .map((p) => p.functionCall as { id?: string; name?: string; args?: Record<string, unknown> } | undefined)
          .filter((c): c is { id?: string; name: string; args?: Record<string, unknown> } => Boolean(c?.name))
          .map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} }));
        // Resent exactly as received: tool calls carry signatures the model checks.
        if (calls.length) contents.push(reply.content!);
        return { model: reply.model!, tried: reply.tried, calls };
      },
      results(items) {
        contents.push({
          role: "user",
          parts: items.map(({ call, response }) => ({
            functionResponse: { ...(call.id ? { id: call.id } : {}), name: call.name, response },
          })),
        });
      },
    };
  },
  async write(system, prompt, depth) {
    const reply = await generate({ system, prompt, schema: SCHEMAS[depth] });
    return { model: reply.model!, text: reply.text ?? "", tried: reply.tried };
  },
};

// ------------------------------------------------------------------ Ollama --

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
  [key: string]: unknown;
}

/** Gemini's schema dialect uses upper-case types; Ollama takes JSON Schema. */
function toJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = k === "type" && typeof v === "string" ? v.toLowerCase() : toJsonSchema(v);
  }
  return out;
}

const OLLAMA_TOOLS = TOOL_DECLARATIONS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: toJsonSchema(t.parameters) },
}));

async function ollamaChat(
  messages: OllamaMessage[],
  options: { tools?: boolean; models?: string[] },
): Promise<{ model: string; message: OllamaMessage; tried: Tried }> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/ollama/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        messages,
        ...(options.tools ? { tools: OLLAMA_TOOLS } : {}),
        ...(options.models ? { models: options.models } : {}),
      }),
    });
  } catch (cause) {
    throw new GeminiError(
      cause instanceof DOMException && cause.name === "TimeoutError"
        ? "Ollama did not answer in time."
        : "The assistant service could not be reached.",
    );
  }
  const body = (await response.json().catch(() => null)) as
    | { model?: string; message?: OllamaMessage; tried?: Tried; error?: string }
    | null;
  if (!response.ok || !body?.model || !body.message) {
    const tried = body?.tried?.map((t) => `${t.model} ${t.status}`).join(", ");
    throw new GeminiError(
      `Ollama: ${body?.error ?? `the assistant service returned ${response.status}`}${tried ? ` (tried: ${tried})` : ""}.`,
    );
  }
  return { model: body.model, message: body.message, tried: body.tried ?? [] };
}

/**
 * Ollama Cloud does not enforce a response schema (measured on every free
 * model, on both its native and OpenAI-compatible endpoints), so the shape is
 * spelled out in words and checked on arrival; see parseAnswer.
 */
const SHAPES: Record<Depth, string> = {
  brief: `Reply with only a JSON object, no markdown fences, exactly in this shape:
{"answer": [{"text": "One sentence.", "cites": [3]}, {"text": "Another sentence.", "cites": [7, 9]}]}`,
  deep: `Reply with only a JSON object, no markdown fences, exactly in this shape:
{"answer": [{"text": "…", "cites": [3]}],
 "analysis": [{"text": "…", "cites": [5]}],
 "caveats": [{"text": "…", "cites": [2]}],
 "follow_up_questions": ["…"]}`,
};

const ollama: Provider = {
  name: "Ollama",
  research(system, userText) {
    const messages: OllamaMessage[] = [
      { role: "system", content: system },
      { role: "user", content: userText },
    ];
    let pinned: string[] | undefined;
    return {
      async step() {
        const reply = await ollamaChat(messages, { tools: true, models: pinned });
        pinned ??= [reply.model];
        const calls = (reply.message.tool_calls ?? []).map((tc) => {
          let args = tc.function.arguments;
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              args = {};
            }
          }
          return { name: tc.function.name, args: (args ?? {}) as Record<string, unknown> };
        });
        if (calls.length) messages.push(reply.message);
        return { model: reply.model, tried: reply.tried, calls };
      },
      results(items) {
        for (const { call, response } of items) {
          messages.push({ role: "tool", tool_name: call.name, content: JSON.stringify(response) });
        }
      },
    };
  },
  async write(system, prompt, depth) {
    const reply = await ollamaChat(
      [
        { role: "system", content: `${system}\n\n${SHAPES[depth]}` },
        { role: "user", content: prompt },
      ],
      {},
    );
    return { model: reply.model, text: reply.message.content ?? "", tried: reply.tried };
  },
};

/** The services this build can reach, in the order to try them. */
export const PROVIDERS: Provider[] = [...(VIA_PROXY ? [ollama] : []), ...(GEMINI_CONFIGURED ? [gemini] : [])];

// -------------------------------------------------------------- the agent --

function historyText(history: Exchange[]): string {
  const recent = history.slice(-HISTORY_TURNS);
  if (recent.length === 0) return "";
  // The calls go in verbatim. Observed: "how many in Odisha?" then "give me
  // those locations" searched a slightly different box (66, then 61), because
  // the earlier filters were visible only through the answer's wording.
  return (
    "Conversation so far:\n" +
    recent
      .map(
        (h) =>
          `User: ${h.question}\n` +
          (h.calls?.length
            ? `Assistant looked up: ${h.calls.map((c) => `${c.name} ${JSON.stringify(c.args)}`).join("; ")}\n`
            : "") +
          `Assistant: ${h.answer}` +
          (h.listed ? `\n(Listed under that answer: ${h.listed}.)` : ""),
      )
      .join("\n\n") +
    "\n\n"
  );
}

function isSentenceList(v: unknown): v is CitedSentence[] {
  return (
    Array.isArray(v) &&
    v.every(
      (s) =>
        s &&
        typeof s === "object" &&
        typeof (s as CitedSentence).text === "string" &&
        Array.isArray((s as CitedSentence).cites) &&
        (s as CitedSentence).cites.every((c) => Number.isInteger(c)),
    )
  );
}

/**
 * The model's reply as an answer, or why it is not one. Tolerates markdown
 * fences and text around the JSON (Ollama models add both), never a
 * different shape: an answer given as a bare number, or with its citations
 * under another name, is rejected rather than guessed at.
 */
export function parseAnswer(text: string, depth: Depth): RawAnswer | string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return "it was not JSON";
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return "it was not valid JSON";
  }
  const r = raw as Record<string, unknown>;
  if (!isSentenceList(r.answer)) return 'its "answer" was not a list of {"text", "cites"} sentences';
  if (depth === "deep") {
    for (const k of ["analysis", "caveats"] as const) {
      if (r[k] !== undefined && !isSentenceList(r[k])) return `its "${k}" was not a list of sentences`;
    }
  }
  return r as RawAnswer;
}

async function askWith(
  provider: Provider,
  question: string,
  ctx: AskContext,
  history: Exchange[],
  depth: Depth,
): Promise<GeminiAnswer> {
  const started = performance.now();
  const facts: Fact[] = [...buildBriefing(question, ctx).facts];
  const lookups: string[] = [];
  const made: ToolCall[] = [];
  const tried: Tried = [];
  const earlier = historyText(history);

  // --- Phase 1: research.
  const session = provider.research(
    RESEARCH,
    `${earlier}Briefing:\n${renderFacts(facts)}\n\nQuestion: ${question}`,
  );
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let step;
    try {
      step = await session.step();
    } catch (cause) {
      // Nothing found yet means nothing to answer from beyond the briefing;
      // with lookups already made, answer from those rather than lose them.
      if (round === 0) throw cause;
      break;
    }
    tried.push(...step.tried);
    const calls = step.calls.slice(0, MAX_CALLS_PER_ROUND);
    if (calls.length === 0) break;

    const items = [];
    for (const call of calls) {
      const run = await runTool(call.name, call.args, ctx);
      if (!run.error) {
        lookups.push(run.summary);
        made.push(call);
      }
      const returned: { id: number; text: string }[] = [];
      for (const f of run.facts) {
        if (facts.length >= MAX_FACTS) break;
        facts.push({
          id: facts.length + 1,
          section: `lookup: ${run.summary}`,
          text: f.text,
          mark: f.mark,
          matches: f.matches,
          ranking: f.ranking,
          listAll: f.listAll,
        });
        returned.push({ id: facts.length, text: f.text });
      }
      items.push({
        call,
        response: run.error
          ? { error: run.error }
          : { facts: returned, ...(returned.length < run.facts.length ? { note: "truncated" } : {}) },
      });
    }
    session.results(items);
  }

  // --- Phase 2: answer, from every fact gathered. A wrong shape gets one
  // second chance with the reason; after that the question fails loudly.
  const prompt = `${earlier}Facts:\n${renderFacts(facts)}\n\nQuestion: ${question}`;
  let reply = await provider.write(SYSTEMS[depth], prompt, depth);
  tried.push(...reply.tried);
  let raw = parseAnswer(reply.text, depth);
  if (typeof raw === "string") {
    reply = await provider.write(
      SYSTEMS[depth],
      `${prompt}\n\nYour previous reply could not be used because ${raw}. Reply again in exactly the required JSON shape.`,
      depth,
    );
    tried.push(...reply.tried);
    raw = parseAnswer(reply.text, depth);
    if (typeof raw === "string") {
      throw new GeminiError(`${provider.name}'s reply was not the structured answer requested (${raw}).`);
    }
  }

  // A follow-up may restate what earlier answers said ("of the 1,602 spots,
  // 92 are in Odisha"): those sentences passed this same check when shown, so
  // their numbers and names count as stated. Observed withheld otherwise.
  const said = history
    .slice(-HISTORY_TURNS)
    .map((h) => h.answer)
    .join(" ");
  const check = (items: CitedSentence[] | undefined) =>
    (items ?? []).map((s) => verifyCited(s, facts, question, said));
  const answer = check(raw.answer);
  const analysis = check(raw.analysis);
  const caveats = check(raw.caveats);
  const followUps = (raw.follow_up_questions ?? [])
    .map((q) => (typeof q === "string" ? q.trim() : ""))
    .filter((q) => q && q.length <= 200 && verifyFollowUp(q, facts))
    .slice(0, 3);

  return {
    provider: provider.name,
    depth,
    model: reply.model,
    tried,
    answer,
    analysis,
    caveats,
    followUps,
    withheld: [...answer, ...analysis, ...caveats].filter((v) => !v.ok).length,
    seconds: (performance.now() - started) / 1000,
    facts,
    lookups,
    calls: made,
  };
}

/**
 * Ask the first service that answers. A failure moves on to the next one;
 * if every service fails, the error names each failure, so the page can say
 * why it fell back to the computed answer.
 */
export async function askAgent(
  question: string,
  ctx: AskContext,
  history: Exchange[] = [],
  depth: Depth = "brief",
  providers: Provider[] = PROVIDERS,
): Promise<GeminiAnswer> {
  if (providers.length === 0) throw new GeminiError("No assistant service is configured.");
  const failures: string[] = [];
  for (const provider of providers) {
    try {
      return await askWith(provider, question, ctx, history, depth);
    } catch (cause) {
      failures.push(cause instanceof Error ? cause.message : `${provider.name} failed.`);
    }
  }
  throw new GeminiError(failures.join(" "));
}
