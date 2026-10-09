/**
 * Gemini called straight from the browser, with no proxy.
 *
 * The owner's decision (2026-10-08): the public site calls Gemini directly
 * with a key injected at build time from the GEMINI_API_KEY repository
 * secret, accepting that anyone who reads the page's JavaScript can copy it.
 * The proxy (proxy/worker.mjs) keeps the key hidden and is still used when
 * VITE_ASSISTANT_URL is set; this path is only for builds without one.
 *
 * Mirrors the proxy's behaviour: the same models in the same order, a busy
 * model is asked again with backoff before the next is tried, and every
 * attempt is reported.
 */

const GOOGLE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Same order as proxy/worker.mjs MODELS; see the measurements noted there. */
export const MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
];

const MAX_OUTPUT_TOKENS = 4096;
const MODEL_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [3_000, 8_000];
/**
 * Only an overloaded model (503) is worth asking again. A rate-limited one
 * (429) has used its own free-tier quota, which is per model, so the next model
 * is tried at once: measured 2026-10-09, retrying 429s turned a follow-up
 * question into a 188 s wait.
 */
const BUSY = new Set([503]);
const RETRYABLE = new Set([404, 408, 429, 500, 502, 503, 504]);

/** One part of a Gemini message: text, a tool call, or a tool's result. */
export type Part = Record<string, unknown>;

export interface Content {
  role: "user" | "model";
  parts: Part[];
}

export interface DirectRequest {
  system: string;
  /** A single user turn; used when `contents` is not given. */
  prompt?: string;
  /** A whole conversation, including tool calls and results. */
  contents?: Content[];
  /** JSON schema for a structured answer. Not combined with tools. */
  schema?: object;
  /** Function declarations Gemini may call. */
  tools?: object[];
}

export interface DirectResult {
  ok: boolean;
  model?: string;
  /** All text parts joined. */
  text?: string;
  /** The model's message exactly as returned; resend it unchanged in a tool loop. */
  content?: Content;
  tried: { model: string; status: number }[];
  error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function requestBody(body: DirectRequest): object {
  const contents = body.contents ?? [{ role: "user", parts: [{ text: body.prompt ?? "" }] }];
  return {
    systemInstruction: { parts: [{ text: body.system }] },
    contents,
    ...(body.tools?.length ? { tools: [{ functionDeclarations: body.tools }] } : {}),
    generationConfig: {
      ...(body.schema ? { responseMimeType: "application/json", responseSchema: body.schema } : {}),
      temperature: 0.2,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  };
}

async function callModel(
  model: string,
  body: DirectRequest,
  key: string,
): Promise<{ ok: true; text: string; content: Content } | { ok: false; status: number }> {
  const response = await fetch(`${GOOGLE}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    body: JSON.stringify(requestBody(body)),
  });
  if (!response.ok) return { ok: false, status: response.status };

  const data = await response.json();
  const content = data?.candidates?.[0]?.content as Content | undefined;
  const parts = content?.parts ?? [];
  if (parts.length === 0) return { ok: false, status: 502 };
  const text = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  return { ok: true, text, content: { role: "model", parts } };
}

/**
 * Try `models` best-first. A tool conversation must stay on one model — its
 * tool calls carry signatures only that model accepts back — so the caller
 * pins it by passing a single model after the first reply.
 */
export async function generateDirect(
  body: DirectRequest,
  key: string,
  models: string[] = MODELS,
): Promise<DirectResult> {
  const tried: { model: string; status: number }[] = [];
  models: for (const model of models) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
      let result;
      try {
        result = await callModel(model, body, key);
      } catch (cause) {
        // Timeout or network failure: worth trying the next model.
        tried.push({ model, status: cause instanceof DOMException && cause.name === "TimeoutError" ? 408 : 502 });
        continue models;
      }
      if (result.ok) return { ok: true, model, text: result.text, content: result.content, tried };
      tried.push({ model, status: result.status });
      // A request Google rejects as malformed (or a bad key) fails on every model.
      if (!RETRYABLE.has(result.status)) break models;
      // Overloaded: wait and ask the same model again. Rate-limited, gone or erroring: move on.
      if (!BUSY.has(result.status)) continue models;
    }
  }
  return { ok: false, tried, error: "no model could answer" };
}
