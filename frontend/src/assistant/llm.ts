/**
 * The on-device language model, confined to two jobs (ADR 0008):
 *
 * 1. route(): map a question to an intent, under a JSON schema the decoder
 *    enforces, so it cannot produce anything outside the fixed set;
 * 2. word(): rephrase a computed answer, which verify.ts then checks before
 *    anything reaches the screen.
 *
 * It never supplies a value. The library is loaded only when the visitor asks
 * for the model, so nobody downloads it by opening the page.
 */

import type { MLCEngineInterface } from "@mlc-ai/web-llm";

import { CLASS_ORDER } from "../classes";
import type { ThermalClass } from "../types";
import {
  DEFAULT_INTENT,
  MAX_LIMIT,
  parsePoint,
  type Answer,
  type Intent,
  type IntentKind,
} from "./intents";

export const MODEL_ID = "Qwen3-1.7B-q4f16_1-MLC";
/** Measured from the published weights; shown before anyone downloads. */
export const MODEL_DOWNLOAD_MB = 940;
export const MODEL_NAME = "Qwen3 1.7B (Apache-2.0)";

export type Support =
  | { ok: true }
  | { ok: false; reason: string };

/** WebGPU with half precision, which these weights need. */
export async function checkSupport(): Promise<Support> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) {
    return { ok: false, reason: "This browser has no WebGPU. Current Chrome or Edge on a desktop does." };
  }
  try {
    const adapter = (await gpu.requestAdapter()) as { features: Set<string> } | null;
    if (!adapter) return { ok: false, reason: "WebGPU is present but found no usable graphics adapter." };
    if (!adapter.features.has("shader-f16")) {
      return { ok: false, reason: "This graphics adapter lacks half-precision support the model needs." };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "WebGPU could not be initialised." };
  }
}

let engine: MLCEngineInterface | null = null;
let loading: Promise<MLCEngineInterface> | null = null;

export function isLoaded(): boolean {
  return engine !== null;
}

export async function load(onProgress: (fraction: number, text: string) => void): Promise<void> {
  if (engine) return;
  if (!loading) {
    loading = (async () => {
      const { CreateWebWorkerMLCEngine } = await import("@mlc-ai/web-llm");
      const worker = new Worker(new URL("./llm.worker.ts", import.meta.url), { type: "module" });
      return CreateWebWorkerMLCEngine(worker, MODEL_ID, {
        initProgressCallback: (p) => onProgress(p.progress, p.text),
      });
    })();
  }
  try {
    engine = await loading;
  } finally {
    loading = null;
  }
}

// ---------------------------------------------------------------- routing --

const KINDS: IntentKind[] = [
  "overview",
  "most_persistent",
  "strongest",
  "recent",
  "near",
  "explain_selected",
  "freshness",
  "model",
  "unsupported",
];

const ROUTE_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    intent: { type: "string", enum: KINDS },
    class: { type: "string", enum: ["any", ...CLASS_ORDER] },
    hours: { type: "integer", enum: [24, 72, 168] },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
  },
  required: ["intent", "class", "hours", "limit"],
});

const ROUTE_PROMPT = `You route questions for a dashboard of satellite thermal anomalies over India.
Choose the intent that answers the question. Do not answer it.

Intents:
- overview: totals and the breakdown by class.
- most_persistent: locations detected on the most distinct days.
- strongest: locations with the highest peak fire radiative power.
- recent: locations detected in the last 24, 72 or 168 hours.
- near: locations near coordinates the user gave as numbers.
- explain_selected: why the open location was classified as it was. Only when the
  question refers to it ("this", "the selected", "the open one").
- freshness: how current or up to date the data is.
- model: how accurate or reliable the classifier is.
- unsupported: anything else, including places named without coordinates.

Classes: industrial_fire (possible industrial fire), persistent_industrial (recurring
industrial heat, e.g. plants, mines, coalfields), natural_fire (vegetation, crop or
forest fire), unknown (not classified), or any.

Use limit 5 unless the user asks for a number. Use hours 24 unless they say otherwise.`;

const EXAMPLES: Array<[string, Record<string, unknown>]> = [
  ["what's new today", { intent: "recent", class: "any", hours: 24, limit: 5 }],
  ["top 3 industrial sites that keep burning", { intent: "most_persistent", class: "persistent_industrial", hours: 24, limit: 3 }],
  ["forest fires this week", { intent: "recent", class: "natural_fire", hours: 168, limit: 5 }],
  ["is this data live?", { intent: "freshness", class: "any", hours: 24, limit: 5 }],
  ["fires near Jharia", { intent: "unsupported", class: "any", hours: 24, limit: 5 }],
];

function messagesFor(question: string) {
  const shots = EXAMPLES.flatMap(([q, a]) => [
    { role: "user" as const, content: q },
    { role: "assistant" as const, content: JSON.stringify(a) },
  ]);
  return [
    { role: "system" as const, content: ROUTE_PROMPT },
    ...shots,
    { role: "user" as const, content: question },
  ];
}

/**
 * Null when the output is unusable, so the caller falls back to keyword
 * routing rather than guessing.
 */
export async function route(question: string): Promise<Intent | null> {
  if (!engine) return null;
  const reply = await engine.chat.completions.create({
    messages: messagesFor(question),
    temperature: 0,
    max_tokens: 60,
    response_format: { type: "json_object", schema: ROUTE_SCHEMA },
    extra_body: { enable_thinking: false },
  });
  let parsed: { intent?: string; class?: string; hours?: number; limit?: number };
  try {
    parsed = JSON.parse(stripThinking(reply.choices[0]?.message?.content ?? ""));
  } catch {
    return null;
  }
  const kind = KINDS.includes(parsed.intent as IntentKind) ? (parsed.intent as IntentKind) : null;
  if (!kind) return null;

  // Coordinates and radius always come from the question text, never from
  // the model, which could otherwise invent a place.
  const point = parsePoint(question);
  const resolved: Intent = {
    ...DEFAULT_INTENT,
    kind,
    label:
      parsed.class && parsed.class !== "any" && CLASS_ORDER.includes(parsed.class as ThermalClass)
        ? (parsed.class as ThermalClass)
        : null,
    hours: parsed.hours === 72 || parsed.hours === 168 ? parsed.hours : 24,
    limit: Math.max(1, Math.min(MAX_LIMIT, Number(parsed.limit) || DEFAULT_INTENT.limit)),
    radiusKm: point.radiusKm ?? DEFAULT_INTENT.radiusKm,
  };
  if (resolved.kind === "near") {
    if (point.latitude === undefined) return { ...resolved, kind: "unsupported" };
    return { ...resolved, latitude: point.latitude, longitude: point.longitude };
  }
  return resolved;
}

// ---------------------------------------------------------------- wording --

const WORD_PROMPT = `You reword a computed answer for an analyst using a thermal-anomaly dashboard.
Rules:
- Begin by stating the computed answer's main result, with its numbers.
- Then add one or two of the facts that matter most to the question.
- Use only the facts given. Do not add any number, place, name, cause or claim, and
  do not comment on what the data can or cannot show.
- Call each location only what the facts call it, even if the question assumes more.
- Do not explain causes or link one value to another, and do not compare locations
  unless the computed answer does.
- A thermal anomaly is evidence of unusual heat, not proof of a fire. Keep hedged words
  such as "possible", "probable" and "consistent with". Never say "confirmed".
- Two to four short sentences. Plain text, no lists, no markdown.`;

/** Qwen3 emits an empty thinking block even with thinking disabled. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export async function word(question: string, answer: Answer): Promise<string | null> {
  if (!engine) return null;
  const facts = answer.facts.length ? answer.facts.map((f) => `- ${f}`).join("\n") : "- (none)";
  const reply = await engine.chat.completions.create({
    messages: [
      { role: "system", content: WORD_PROMPT },
      {
        role: "user",
        content: `Question: ${question}\nWhat was answered: ${answer.title}\nComputed answer: ${answer.summary}\nFacts:\n${facts}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 220,
    extra_body: { enable_thinking: false },
  });
  const text = reply.choices[0]?.message?.content;
  return text ? stripThinking(text) : null;
}
