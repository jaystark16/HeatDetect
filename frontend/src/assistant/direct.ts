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
const MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
];

const MAX_OUTPUT_TOKENS = 4096;
const MODEL_TIMEOUT_MS = 45_000;
const RETRY_DELAYS_MS = [3_000, 8_000];
const BUSY = new Set([429, 503]);
const RETRYABLE = new Set([404, 408, 429, 500, 502, 503, 504]);

export interface DirectRequest {
  system: string;
  prompt: string;
  schema: object;
}

export interface DirectResult {
  ok: boolean;
  model?: string;
  text?: string;
  tried: { model: string; status: number }[];
  error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function callModel(
  model: string,
  body: DirectRequest,
  key: string,
): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  const response = await fetch(`${GOOGLE}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: body.system }] },
      contents: [{ role: "user", parts: [{ text: body.prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: body.schema,
        temperature: 0.2,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    }),
  });
  if (!response.ok) return { ok: false, status: response.status };

  const data = await response.json();
  const parts: { text?: string }[] = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("");
  return text ? { ok: true, text } : { ok: false, status: 502 };
}

export async function generateDirect(body: DirectRequest, key: string): Promise<DirectResult> {
  const tried: { model: string; status: number }[] = [];
  models: for (const model of MODELS) {
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
      if (result.ok) return { ok: true, model, text: result.text, tried };
      tried.push({ model, status: result.status });
      // A request Google rejects as malformed (or a bad key) fails on every model.
      if (!RETRYABLE.has(result.status)) break models;
      // Busy: wait and ask the same model again. Gone or erroring: move on.
      if (!BUSY.has(result.status)) continue models;
    }
  }
  return { ok: false, tried, error: "no model could answer" };
}
