/**
 * The gate between the model's wording and the screen.
 *
 * The model is allowed to rephrase computed facts, nothing more. This checks
 * that it did only that: every number it wrote must be one of the computed
 * values (or a rounding of one), it must not assert certainty the data cannot
 * support, and it must not introduce a proper noun that appears nowhere in the
 * facts. Anything that fails is discarded and the computed answer is shown.
 */

import type { Answer } from "./intents";

export interface Verdict {
  ok: boolean;
  /** Why the wording was rejected, for the page to state. */
  reason?: string;
}

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/g;

/**
 * A thermal anomaly is evidence of heat, not proof of a fire (CLAUDE.md). These
 * turn a hedged finding into a claim.
 */
const CERTAINTY =
  /\b(confirmed|confirms|definitely|certainly|undoubtedly|proves?|proven|proof that|guaranteed|without doubt|for sure)\b/i;

/** Proper nouns the model may use without them appearing in the facts. */
const ALWAYS_ALLOWED = new Set(["NASA", "FIRMS", "India", "OpenStreetMap", "VIIRS", "MODIS", "MW", "km"]);

const MAX_LENGTH = 900;

/** Lines formatted as a list. The prompt forbids lists; the model wrote one
 * announcing "the top 5" and then listing two. */
const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s/m;

/**
 * Comparisons and reasons are claims about the data, and a model can build a
 * false one from true numbers. Observed: "the most persistent, with the highest
 * peak power", when another listed source peaked higher; and "consistent with
 * vegetation fire based on the thermal signature", a reason nothing computed.
 * Such words are allowed only where the computed answer already uses them.
 */
const COMPARATIVE =
  /\b(highest|lowest|largest|smallest|biggest|strongest|weakest|longest|shortest|hottest|greatest|least|fewest|higher|lower|larger|smaller|stronger|weaker|longer|shorter|greater|hotter|more|fewer|less|than)\b/gi;
const CAUSAL =
  /\b(because|due to|based on|caused by|as a result|result of|suggests?|indicates?|implies|therefore|thus|hence|owing to|driven by|likely from)\b/gi;

/**
 * What a source *is*. The data says "persistent industrial source"; calling it
 * a coal mine because the question did is the model adopting the asker's
 * assumption as fact. Observed: asked about coal mines, it wrote "the coal mine
 * at 31.5 MW" about a location the data never identified.
 */
const TYPE_WORDS =
  /\b(mines?|mining|coal(?:field|fields)?|collier(?:y|ies)|refiner(?:y|ies)|factor(?:y|ies)|plants?|steel(?:works)?|cement|kilns?|bricks?|smelters?|furnaces?|power stations?|oil|gas|flares?|wells?|crops?|stubble|farms?|forests?|wildfires?|grassland|landfills?)\b/gi;

function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((n) => n.replace(/,/g, ""));
}

function decimals(n: string): number {
  const dot = n.indexOf(".");
  return dot === -1 ? 0 : n.length - dot - 1;
}

/**
 * Numbers the model may write: every computed value, plus anything the
 * visitor typed (echoing "24 hours" back is not fabrication).
 */
function allowedNumbers(answer: Answer, question: string): number[] {
  const source = [answer.title, answer.summary, ...answer.facts, question].join(" ");
  return numbersIn(source).map(Number).filter(Number.isFinite);
}

/** A written number passes if it equals an allowed value rounded to its precision. */
function supported(written: string, allowed: number[]): boolean {
  const value = Number(written);
  if (!Number.isFinite(value)) return true;
  const places = decimals(written);
  const factor = 10 ** places;
  return allowed.some(
    (a) =>
      Math.abs(a - value) < 1e-9 ||
      Math.abs(Math.round(a * factor) / factor - value) < 1e-9 ||
      // Coordinates are written with a hemisphere letter, not a sign.
      Math.abs(Math.round(Math.abs(a) * factor) / factor - Math.abs(value)) < 1e-9,
  );
}

/** Capitalised words that are not the first word of a sentence. */
function midSentenceProperNouns(text: string): string[] {
  const found: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.split(/\s+/).slice(1);
    for (const raw of words) {
      const word = raw.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
      if (/^[A-Z][a-z]{2,}$/.test(word) || /^[A-Z]{2,}$/.test(word)) found.push(word);
    }
  }
  return found;
}

export function verifyWording(text: string, answer: Answer, question: string): Verdict {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "the model returned nothing" };
  if (trimmed.length > MAX_LENGTH) return { ok: false, reason: "the model's answer ran too long" };

  const certainty = trimmed.match(CERTAINTY);
  if (certainty) {
    return { ok: false, reason: `it claimed certainty ("${certainty[0]}") the data cannot support` };
  }

  const allowed = allowedNumbers(answer, question);
  const unsupported = numbersIn(trimmed).filter((n) => !supported(n, allowed));
  if (unsupported.length) {
    return {
      ok: false,
      reason: `it introduced ${unsupported.length === 1 ? "a number" : "numbers"} not in the data (${unsupported.slice(0, 3).join(", ")})`,
    };
  }

  const vocabulary = [answer.title, answer.summary, ...answer.facts, question].join(" ");
  const invented = midSentenceProperNouns(trimmed).filter(
    (w) => !ALWAYS_ALLOWED.has(w) && !vocabulary.includes(w),
  );
  if (invented.length) {
    return {
      ok: false,
      reason: `it named something not in the data (${[...new Set(invented)].slice(0, 3).join(", ")})`,
    };
  }

  if (LIST_LINE.test(trimmed)) {
    return { ok: false, reason: "it formatted a list, which it was told not to" };
  }

  // Only what the computed material says, not what the visitor typed.
  const computed = [answer.title, answer.summary, ...answer.facts].join(" ").toLowerCase();
  for (const [pattern, kind] of [
    [COMPARATIVE, "a comparison"],
    [CAUSAL, "a reason"],
  ] as const) {
    const used = [...new Set((trimmed.match(pattern) ?? []).map((w) => w.toLowerCase()))];
    const added = used.filter((w) => !new RegExp(`\\b${w}\\b`).test(computed));
    if (added.length) {
      return {
        ok: false,
        reason: `it added ${kind} the computed answer does not make (${added.slice(0, 3).join(", ")})`,
      };
    }
  }

  const typed = [...new Set((trimmed.match(TYPE_WORDS) ?? []).map((w) => w.toLowerCase()))];
  const unfounded = typed.filter((w) => !computed.includes(w));
  if (unfounded.length) {
    return {
      ok: false,
      reason: `it described a source as something the data does not establish (${unfounded.slice(0, 3).join(", ")})`,
    };
  }

  // Wording that restates none of the computed result is commentary, not an
  // answer. Observed: "further analysis is required to determine…" in place of
  // the list it was given.
  const resultNumbers = numbersIn(answer.summary);
  const written = numbersIn(trimmed);
  if (resultNumbers.length && !written.some((n) => supported(n, resultNumbers.map(Number)))) {
    return { ok: false, reason: "it did not state the computed result" };
  }

  return { ok: true };
}

// ------------------------------------------------------ cited sentences --
//
// Gemini answers in sentences that each name the facts they rest on. Each one
// is checked against *its own* citations, which is stricter than checking
// against the whole briefing: a true number cited to the wrong fact fails.

export interface CitedSentence {
  text: string;
  cites: number[];
}

export interface CitedVerdict {
  sentence: CitedSentence;
  ok: boolean;
  reason?: string;
}

interface CitableFact {
  id: number;
  text: string;
}

/** Hedges are how this project speaks; strong causal claims need a cited basis. */
const STRONG_CAUSAL =
  /\b(because|caused by|due to|as a result|result of|therefore|thus|hence|owing to|driven by|proves?|proven)\b/gi;

/** A comparison needs a cited ranking ("#1 …") or the same word in a cited fact. */
function comparisonSupported(word: string, cited: string): boolean {
  return /#\d+/.test(cited) || new RegExp(`\b${word}\b`, "i").test(cited);
}

export function verifyCited(
  sentence: CitedSentence,
  facts: CitableFact[],
  question: string,
): CitedVerdict {
  const fail = (reason: string): CitedVerdict => ({ sentence, ok: false, reason });
  const text = (sentence.text ?? "").trim();
  if (!text) return fail("it was empty");
  if (text.length > 600) return fail("it ran too long");
  if (LIST_LINE.test(text)) return fail("it was formatted as a list");

  const byId = new Map(facts.map((f) => [f.id, f.text]));
  const cites = [...new Set((sentence.cites ?? []).filter((c) => Number.isInteger(c)))];
  if (cites.length === 0) return fail("it cited no fact");
  const unknown = cites.filter((c) => !byId.has(c));
  if (unknown.length) return fail(`it cited facts that do not exist (${unknown.join(", ")})`);
  const cited = cites.map((c) => byId.get(c)!).join(" ");

  const certainty = text.match(CERTAINTY);
  if (certainty) return fail(`it claimed certainty ("${certainty[0]}") the data cannot support`);

  const allowed = numbersIn(`${cited} ${question}`).map(Number).filter(Number.isFinite);
  // Citation markers like "[3]" inside the text are references, not claims.
  const claimed = numbersIn(text.replace(/\[\d+(?:\s*,\s*\d+)*\]/g, " "));
  const unsupported = claimed.filter((x) => !supported(x, allowed));
  if (unsupported.length) {
    return fail(`it stated ${unsupported.slice(0, 3).join(", ")}, which its cited facts do not contain`);
  }

  const lowerCited = cited.toLowerCase();
  const types = [...new Set((text.match(TYPE_WORDS) ?? []).map((w) => w.toLowerCase()))].filter(
    (w) => !lowerCited.includes(w),
  );
  if (types.length) return fail(`it described a source as something its cited facts do not (${types.join(", ")})`);

  const comparisons = [...new Set((text.match(COMPARATIVE) ?? []).map((w) => w.toLowerCase()))].filter(
    (w) => !comparisonSupported(w, cited),
  );
  if (comparisons.length) {
    return fail(`it made a comparison (${comparisons.join(", ")}) that no cited ranking supports`);
  }

  const causal = [...new Set((text.match(STRONG_CAUSAL) ?? []).map((w) => w.toLowerCase()))].filter(
    (w) => !new RegExp(`\b${w}\b`, "i").test(cited),
  );
  if (causal.length) return fail(`it asserted a cause (${causal.join(", ")}) its cited facts do not state`);

  const names = midSentenceProperNouns(text).filter((w) => !ALWAYS_ALLOWED.has(w) && !cited.includes(w));
  if (names.length) return fail(`it named something its cited facts do not (${[...new Set(names)].join(", ")})`);

  return { sentence: { text, cites }, ok: true };
}

/**
 * Suggested follow-up questions are not claims, but they are shown as
 * clickable text, so they get the same number and name checks against the
 * whole briefing.
 */
export function verifyFollowUp(question: string, facts: CitableFact[]): boolean {
  const all = facts.map((f) => f.text).join(" ");
  const allowed = numbersIn(all).map(Number);
  if (numbersIn(question).some((x) => !supported(x, allowed))) return false;
  if (CERTAINTY.test(question)) return false;
  return midSentenceProperNouns(question).every((w) => ALWAYS_ALLOWED.has(w) || all.includes(w));
}
