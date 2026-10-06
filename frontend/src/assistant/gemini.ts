/**
 * Gemini, through HeatDetect's proxy (proxy/worker.mjs), which holds the key.
 *
 * Gemini sees the briefing — every fact numbered — and must answer in
 * sentences that cite those numbers. It is asked for an answer, an analysis
 * of what stands out, the caveats that matter, and follow-up questions. Each
 * sentence is then checked against the facts it cites (verify.ts); a sentence
 * that fails is withheld and the page says so.
 */

import { renderFacts, type Briefing } from "./briefing";
import {
  verifyCited,
  verifyFollowUp,
  type CitedSentence,
  type CitedVerdict,
} from "./verify";

const BASE = (import.meta.env.VITE_ASSISTANT_URL ?? "").replace(/\/$/, "");

/** False when no proxy URL was configured at build time. */
export const GEMINI_CONFIGURED = BASE !== "";

const TIMEOUT_MS = 120_000;

const SENTENCE = {
  type: "OBJECT",
  properties: {
    text: { type: "STRING" },
    cites: { type: "ARRAY", items: { type: "INTEGER" } },
  },
  required: ["text", "cites"],
};

const SCHEMA = {
  type: "OBJECT",
  properties: {
    answer: { type: "ARRAY", items: SENTENCE },
    analysis: { type: "ARRAY", items: SENTENCE },
    caveats: { type: "ARRAY", items: SENTENCE },
    follow_up_questions: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["answer", "analysis", "caveats", "follow_up_questions"],
};

const SYSTEM = `You are the analyst assistant inside HeatDetect, a production system that classifies
satellite thermal anomalies over India as possible industrial fires, persistent industrial
sources, probable vegetation fires, or unclassified, and monitors persistent sources.

You are given a briefing of numbered facts. They come from real NASA FIRMS detections,
the system's persistence statistics, its deterministic rules and its trained classifier,
all computed by the system. You cannot see anything else, and you must not use outside
knowledge about places, companies, events or causes.

Answer the user's question, then analyse the briefing as an expert would: what stands out,
what patterns the numbers show, what the classifier's measured reliability means for the
question, and what an analyst should check next.

Rules for every sentence:
- Cite the fact numbers it rests on in "cites". Every sentence needs at least one.
- Use only numbers that appear in the facts you cite. You may round them.
- Name a place, facility or source type only if a cited fact names it. Locations are given
  as coordinates; refer to them that way.
- Compare locations only by citing a ranking fact (those marked #1, #2, ...).
- A thermal anomaly is evidence of unusual heat, not proof of a fire or accident. Use
  "possible", "probable" or "consistent with"; never "confirmed" or "definitely".
- State a cause only if a cited fact states it.
- If the briefing cannot answer the question, say so plainly and say what it can show.
- Plain sentences: no lists, bullets or markdown inside "text".

Sections:
- answer: 1 to 4 sentences that directly answer the question.
- analysis: 2 to 6 sentences of reasoning over the briefing that bear on the question.
- caveats: 0 to 3 sentences on limits that matter for this answer (coverage, freshness,
  classifier reliability).
- follow_up_questions: 0 to 3 short questions the user could ask next.`;

export interface GeminiAnswer {
  model: string;
  /** Models tried before the one that answered, and why each was skipped. */
  tried: { model: string; status: number }[];
  answer: CitedVerdict[];
  analysis: CitedVerdict[];
  caveats: CitedVerdict[];
  followUps: string[];
  withheld: number;
  seconds: number;
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

export async function askGemini(question: string, briefing: Briefing): Promise<GeminiAnswer> {
  if (!GEMINI_CONFIGURED) throw new GeminiError("No assistant service is configured.");
  const started = performance.now();

  let response: Response;
  try {
    response = await fetch(`${BASE}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        system: SYSTEM,
        prompt: `Briefing:\n${renderFacts(briefing.facts)}\n\nQuestion: ${question}`,
        schema: SCHEMA,
      }),
    });
  } catch (cause) {
    throw new GeminiError(
      cause instanceof DOMException && cause.name === "TimeoutError"
        ? "Gemini did not answer in time."
        : "The assistant service could not be reached.",
    );
  }

  const body = (await response.json().catch(() => null)) as
    | { model?: string; text?: string; tried?: { model: string; status: number }[]; error?: string }
    | null;
  if (!response.ok || !body?.text || !body.model) {
    const tried = body?.tried?.map((t) => `${t.model} ${t.status}`).join(", ");
    throw new GeminiError(
      `${body?.error ?? `The assistant service returned ${response.status}`}${tried ? ` (tried: ${tried})` : ""}.`,
    );
  }

  let raw: RawAnswer;
  try {
    raw = JSON.parse(body.text) as RawAnswer;
  } catch {
    throw new GeminiError("Gemini's reply was not the structured answer requested.");
  }

  const check = (items: CitedSentence[] | undefined) =>
    (items ?? []).map((s) => verifyCited(s, briefing.facts, question));
  const answer = check(raw.answer);
  const analysis = check(raw.analysis);
  const caveats = check(raw.caveats);
  const followUps = (raw.follow_up_questions ?? [])
    .map((q) => (typeof q === "string" ? q.trim() : ""))
    .filter((q) => q && q.length <= 200 && verifyFollowUp(q, briefing.facts))
    .slice(0, 3);

  return {
    model: body.model,
    tried: body.tried ?? [],
    answer,
    analysis,
    caveats,
    followUps,
    withheld: [...answer, ...analysis, ...caveats].filter((v) => !v.ok).length,
    seconds: (performance.now() - started) / 1000,
  };
}
