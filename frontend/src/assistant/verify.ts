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

const CERTAINTY_ALL = new RegExp(CERTAINTY.source, "gi");

/** A negation within the three words before a certainty word. */
const NEGATED = /\b(?:not|no|nothing|never|cannot|can't|isn't|aren't|wasn't|doesn't|don't|didn't|without|neither|nor)\b(?:\W+\w+){0,3}\W*$/i;
const AFFIRMING_DOUBT = /\b(?:no|without|beyond)\s+(?:a\s+)?doubt\b/i;

/**
 * The first certainty word used as a claim, or null. "Nothing in the data
 * confirms an accident" is the hedge this project wants, and was withheld
 * for the word "confirms" (observed 2026-10-23); "no doubt it is confirmed"
 * is still a claim.
 */
function claimedCertainty(text: string): string | null {
  for (const m of text.matchAll(CERTAINTY_ALL)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 60), m.index);
    if (!NEGATED.test(before) || AFFIRMING_DOUBT.test(before)) return m[0];
  }
  return null;
}

/** Proper nouns the model may use without them appearing in the facts. */
const ALWAYS_ALLOWED = new Set(["NASA", "FIRMS", "India", "OpenStreetMap", "VIIRS", "MODIS", "MW", "km", "CSV", "Google", "Maps", "HeatDetect"]);

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
  /\b(mines?|mining|coal(?:field|fields)?|collier(?:y|ies)|refiner(?:y|ies)|factor(?:y|ies)|plants?|steel(?:works)?|cement|kilns?|bricks?|smelters?|furnaces?|power stations?|oil|gas|flares?|(?:oil |gas )?wells|(?:oil|gas) well|crops?|stubble|farms?|forests?|wildfires?|grassland|landfills?)\b/gi;

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

// ---------------------------------------------------------- written numbers --
//
// Models write "Seventy-two sources", "about 94,000" or "94 thousand" once
// asked to sound natural (observed 2026-10-23). Spelled-out numbers used to
// pass unchecked, so all of these are read as values and checked like digits.

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALE: Record<string, number> = { thousand: 1e3, k: 1e3, lakh: 1e5, lakhs: 1e5, million: 1e6, crore: 1e7, crores: 1e7 };

const WORD = `(?:${Object.keys(SMALL).join("|")}|hundred|thousand|lakhs?|million|crores?)`;
const SPELLED = new RegExp(`\\b${WORD}(?:(?:[\\s-]+(?:and[\\s-]+)?)${WORD})*\\b`, "gi");
const SCALED_DIGITS = /(-?\d[\d,]*(?:\.\d+)?)\s*(thousand|k|lakhs?|million|crores?)\b/gi;
const HEDGE_BEFORE = /\b(?:about|around|roughly|nearly|almost|approximately|some|over|under|close to)\s*$|~\s*$/i;

function parseSpelled(phrase: string): number | null {
  let total = 0;
  let current = 0;
  for (const word of phrase.toLowerCase().split(/[\s-]+/).filter((w) => w && w !== "and")) {
    if (word in SMALL) current += SMALL[word];
    else if (word === "hundred") current = (current || 1) * 100;
    else if (word in SCALE) {
      total += (current || 1) * SCALE[word];
      current = 0;
    } else return null;
  }
  return total + current;
}

interface Claim {
  value: number;
  /** As written, to read its precision. */
  written: string;
  /** Hedged ("about 94,000") or scaled ("94 thousand"): may be rounded to its magnitude. */
  approximate: boolean;
  /** "93%" for a fact's 0.926 (observed 2026-10-23, withheld before this). */
  percent?: boolean;
}

const PERCENT_AFTER = /^\s*(?:%|per\s?cent\b)/i;

function claimedNumbers(text: string): Claim[] {
  const claims: Claim[] = [];
  const hedged = (at: number) => HEDGE_BEFORE.test(text.slice(Math.max(0, at - 20), at));
  // Each pass blanks what it read, same length, so positions still match `text`.
  let masked = text;
  const blank = (at: number, length: number) => {
    masked = masked.slice(0, at) + " ".repeat(length) + masked.slice(at + length);
  };

  for (const m of [...masked.matchAll(SCALED_DIGITS)]) {
    const value = Number(m[1].replace(/,/g, "")) * SCALE[m[2].toLowerCase()];
    claims.push({ value, written: String(value), approximate: true });
    blank(m.index ?? 0, m[0].length);
  }
  for (const m of [...masked.matchAll(SPELLED)]) {
    // "one of them", "the one at": a lone "one" is a pronoun, not a count.
    if (/^one$/i.test(m[0])) continue;
    const value = parseSpelled(m[0]);
    if (value === null) continue;
    const scaled = /thousand|lakh|million|crore/i.test(m[0]);
    claims.push({ value, written: String(value), approximate: scaled || hedged(m.index ?? 0) });
    blank(m.index ?? 0, m[0].length);
  }
  for (const m of [...masked.matchAll(NUMBER)]) {
    const written = m[0].replace(/,/g, "");
    const at = m.index ?? 0;
    const percent = PERCENT_AFTER.test(text.slice(at + m[0].length, at + m[0].length + 9));
    claims.push({ value: Number(written), written, approximate: hedged(at), percent });
  }
  return claims;
}

/** "about 94,000" for 94,238: equal once the allowed value is rounded to the written magnitude. */
function roundsTo(claim: Claim, allowed: number[]): boolean {
  if (!claim.approximate || !Number.isInteger(claim.value) || claim.value === 0) return false;
  const zeros = String(Math.abs(claim.value)).match(/0+$/)?.[0].length ?? 0;
  if (zeros === 0) return false;
  const unit = 10 ** zeros;
  return allowed.some((a) => Math.round(Math.abs(a) / unit) * unit === Math.abs(claim.value));
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

  const certainty = claimedCertainty(trimmed);
  if (certainty) {
    return { ok: false, reason: `it claimed certainty ("${certainty}") the data cannot support` };
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
  /** For looked-up facts, "lookup: <what was searched>", written by code. */
  section?: string;
}

/** A lookup scoped to a box or a point, i.e. about a place rather than everywhere. */
const PLACE_SCOPED = /\b(?:inside the box|within \d+(?:\.\d+)? km of)\b/;

/**
 * A place the user typed may be named from a search of an area or point the
 * model did not label. Observed: "persistent industrial sources in vizag" was
 * searched around 17.7° N, 83.3° E with no name, and the correct answer was
 * withheld for saying "Vizag". A lookup the model did label must use that
 * label instead, so a second place in the question cannot borrow its box.
 */
function askedPlace(word: string, lookups: string[], question: string): boolean {
  if (!new RegExp(`\\b${word}\\b`, "i").test(question)) return false;
  return lookups.some((s) => PLACE_SCOPED.test(s) && !s.includes("approximation of"));
}

/** Hedges are how this project speaks; strong causal claims need a cited basis. */
const STRONG_CAUSAL =
  /\b(because|caused by|due to|as a result|result of|therefore|thus|hence|owing to|driven by|proves?|proven)\b/gi;

/** A comparison needs a cited ranking ("#1 …") or the same word in a cited fact. */
function comparisonSupported(word: string, cited: string): boolean {
  return /#\d+/.test(cited) || new RegExp(`\\b${word}\\b`, "i").test(cited);
}

// --------------------------------------------------------------- talk --
//
// A sentence that says nothing about the data needs no citation: "Hi! What
// would you like to know?" Requiring one made the model answer a greeting with
// statistics ("I can't answer a greeting, but the data shows…", observed
// 2026-10-23). Such a sentence may hold no number, no name, nothing about
// heat sources and no amount, so a claim cannot pass as small talk.

const ABOUT_THE_DATA =
  /\b(fires?|burn(?:s|ing|t|ed)?|blaze|flames?|industr(?:y|ial)|vegetation|persistent|unclassified|classif(?:y|ied|ication)|accidents?|explosions?|incidents?|smoke|hotspots?|anomal(?:y|ies)|radiative|frp|mw|detected|detections?|seen|active|busiest|hottest)\b/i;
const AMOUNTS =
  /\b(most|many|majority|minority|numerous|dozens?|hundreds|thousands|millions|plenty|lots?|few|fewer|several|none|nobody|every|always|never|rare(?:ly)?|often|usually|mostly|mainly|largely|nearly all|almost all|all of)\b/i;

/** Names conversation may use: the product and the sources it cites anyway. */
const TALK_NAMES = new Set(["HeatDetect", "I", "NASA", "FIRMS", "OpenStreetMap", "Google", "Maps", "CSV"]);
/** Ordinary sentence openings. Any other capitalised first word may be a place ("Odisha looks busy"). */
const TALK_STARTS = new Set(
  ("Hi Hello Hey Thanks Thank Sure Happy Glad Good Great Okay OK Yes No Of You Your I I'm I've I'll We " +
    "What Which Where When How Why Want Would Could Can Just Let Ask Tell Feel Anytime Welcome Morning " +
    "Evening Sorry Here There That This It Any Nice Hope Please Not Absolutely Certainly Right Got").split(" "),
);
const TYPE_WORD = new RegExp(TYPE_WORDS.source, "i");

/** Why an uncited sentence is not plain conversation, or null if it is. */
function notTalk(text: string): string | null {
  if (claimedNumbers(text).length) return "it gave a number without citing a fact";
  // Compared without a contraction: "You're" opens like "You".
  const first = text.match(/^[A-Z][A-Za-z]*/)?.[0];
  const names = [
    ...(first && !TALK_STARTS.has(first) && !TALK_NAMES.has(first) ? [first] : []),
    ...midSentenceProperNouns(text).filter((w) => !TALK_NAMES.has(w)),
  ];
  if (names.length) return `it named something without citing a fact (${[...new Set(names)].join(", ")})`;
  if (TYPE_WORD.test(text)) return "it described a source without citing a fact";
  if (AMOUNTS.test(text)) return "it said something about the data without citing a fact";
  // An offer or a question back may mention the data's kinds ("Want me to list
  // the possible industrial fires?"); with no number, name or amount, it
  // asserts nothing. A statement about them does.
  if (ABOUT_THE_DATA.test(text) && !OFFER.test(text)) return "it said something about the data without citing a fact";
  if (claimedCertainty(text)) return "it claimed certainty";
  return null;
}

// Anchored at the start (after an optional "Hi!", "Sure," …), so a statement
// cannot pass by ending in "…, and I can list them".
const OFFER =
  /\?\s*$|^(?:(?:Hi|Hello|Hey|Sure|Okay|OK|Yes|Of course|Absolutely|Great|Thanks)[!,.]?\s+)?(?:Want me to|Would you like|Shall I|Should I|Do you want|Let me know|Ask me|Happy to|Feel free|I can|I could|I'm here to|I am here to)\b/i;

/**
 * `earlier` is what earlier answers in the conversation said; each sentence of
 * it passed this check when it was shown, so a follow-up may restate its
 * numbers, names and comparisons ("of the 1,602 spots, 92 are in Odisha").
 * What the visitor typed is different: echoing their "24 hours" is fine, but
 * their "Gujarat?" does not put a cited fact in Gujarat.
 */
export function verifyCited(
  sentence: CitedSentence,
  facts: CitableFact[],
  question: string,
  earlier = "",
): CitedVerdict {
  const fail = (reason: string): CitedVerdict => ({ sentence, ok: false, reason });
  // Citations are shown as buttons, so markers the model also wrote into the
  // text are dropped (observed: "…how the classification system works cites: [4].").
  const text = (sentence.text ?? "")
    .replace(/\s*\(?\bcites?:\s*\[[\d,\s]*\]\)?/gi, "")
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .trim();
  if (!text) return fail("it was empty");
  if (text.length > 600) return fail("it ran too long");
  if (LIST_LINE.test(text)) return fail("it was formatted as a list");

  const byId = new Map(facts.map((f) => [f.id, f]));
  const cites = [...new Set((sentence.cites ?? []).filter((c) => Number.isInteger(c)))];
  if (cites.length === 0) {
    const problem = notTalk(text);
    return problem ? fail(problem) : { sentence: { text, cites: [] }, ok: true };
  }
  const unknown = cites.filter((c) => !byId.has(c));
  if (unknown.length) return fail(`it cited facts that do not exist (${unknown.join(", ")})`);
  const citedFacts = cites.map((c) => byId.get(c)!);
  const cited = citedFacts.map((f) => f.text).join(" ");
  const lookups = citedFacts.map((f) => f.section ?? "").filter((s) => s.startsWith("lookup:"));

  const certainty = claimedCertainty(text);
  if (certainty) return fail(`it claimed certainty ("${certainty}") the data cannot support`);

  // Anything the visitor typed may be echoed back, spelled out or not.
  const allowed = [
    ...numbersIn(`${cited} ${question} ${earlier}`).map(Number),
    ...claimedNumbers(`${question} ${earlier}`).map((c) => c.value),
  ].filter(Number.isFinite);
  // Citation markers like "[3]" inside the text are references, not claims.
  const claimed = claimedNumbers(text.replace(/\[\d+(?:\s*,\s*\d+)*\]/g, " "));
  // A percentage may restate a fraction the facts give (precision 0.926 as 93%).
  const asPercent = allowed.filter((a) => a > 0 && a <= 1).map((a) => a * 100);
  const unsupported = claimed.filter(
    (c) =>
      !supported(c.written, allowed) &&
      !roundsTo(c, allowed) &&
      !(c.percent && (supported(c.written, asPercent) || roundsTo(c, asPercent))),
  );
  if (unsupported.length) {
    return fail(
      `it stated ${unsupported.slice(0, 3).map((c) => c.written).join(", ")}, which its cited facts do not contain`,
    );
  }

  const lowerCited = cited.toLowerCase();
  const types = [...new Set((text.match(TYPE_WORDS) ?? []).map((w) => w.toLowerCase()))].filter(
    (w) => !lowerCited.includes(w),
  );
  if (types.length) return fail(`it described a source as something its cited facts do not (${types.join(", ")})`);

  const comparisons = [...new Set((text.match(COMPARATIVE) ?? []).map((w) => w.toLowerCase()))].filter(
    (w) => !comparisonSupported(w, `${cited} ${earlier}`),
  );
  if (comparisons.length) {
    return fail(`it made a comparison (${comparisons.join(", ")}) that no cited ranking supports`);
  }

  const causal = [...new Set((text.match(STRONG_CAUSAL) ?? []).map((w) => w.toLowerCase()))].filter(
    (w) => !new RegExp(`\\b${w}\\b`, "i").test(cited),
  );
  if (causal.length) return fail(`it asserted a cause (${causal.join(", ")}) its cited facts do not state`);

  // A lookup's description counts as cited: a ranked match ("#1 … 17.609° N")
  // does not repeat the place its search was about. A name an earlier answer
  // already used may be used again in a follow-up.
  const names = midSentenceProperNouns(text).filter(
    (w) =>
      !ALWAYS_ALLOWED.has(w) &&
      !cited.includes(w) &&
      !lookups.some((s) => s.includes(w)) &&
      !askedPlace(w, lookups, question) &&
      !new RegExp(`\\b${w}\\b`).test(earlier),
  );
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
  if (claimedCertainty(question)) return false;
  return midSentenceProperNouns(question).every((w) => ALWAYS_ALLOWED.has(w) || all.includes(w));
}
