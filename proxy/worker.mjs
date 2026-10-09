/**
 * HeatDetect assistant proxy — a Cloudflare Worker.
 *
 * Holds the Gemini API key server-side, so it never reaches a browser. The
 * dashboard is a static site; without this, the only way to call Gemini would
 * be to ship the key in public JavaScript, where anyone can copy it.
 *
 * It does as little as possible and refuses everything else:
 *   - one route, POST /generate, from allowed origins only;
 *   - bounded request size and output length;
 *   - JSON output under the caller's schema, never free text;
 *   - retries a busy model with backoff, then falls back to the next, and
 *     reports which model answered and every attempt made.
 *
 * It is not the source of any fact. The dashboard computes every value and
 * checks the model's answer against them (frontend/src/assistant/).
 *
 * Secrets / vars (wrangler.toml, `wrangler secret put GEMINI_API_KEY`):
 *   GEMINI_API_KEY   required
 *   ALLOWED_ORIGINS  comma-separated; defaults to the production site
 */

const GOOGLE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Best first. Availability was measured, not assumed: on 2026-10-07 the full
 * Flash models returned 503 "high demand" for minutes at a time while the
 * Flash-Lite models answered in ~1 s, and gemini-2.5-flash had been closed to
 * new keys. Falling through the list keeps the assistant working through that.
 */
export const MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-flash-latest",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
];

const DEFAULT_ORIGINS = "https://jaystark16.github.io";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_OUTPUT_TOKENS = 4096;
const MODEL_TIMEOUT_MS = 45_000;

/**
 * Accuracy over speed: a busy model is asked again, with backoff, before the
 * next (lighter) model is tried. Overload spikes on the full Flash models
 * usually last seconds to minutes, and the team prefers a slower answer from
 * the stronger model to a fast one from Flash-Lite.
 */
export const RETRY_DELAYS_MS = [3_000, 8_000];
/**
 * Only an overloaded model (503) is worth asking again. A rate-limited one
 * (429) has used its own free-tier quota, which is per model, so the next model
 * is tried at once: measured 2026-10-09, retrying 429s turned a follow-up
 * question into a 188 s wait.
 */
const BUSY = new Set([503]);

/** Statuses that mean "try the next model", not "the request is wrong". */
const RETRYABLE = new Set([404, 408, 429, 500, 502, 503, 504]);

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS)
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "3600",
    Vary: "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(origin ? corsHeaders(origin) : {}),
    },
  });
}

/** Shape check on what the dashboard sends. Anything else is refused. */
const MAX_TURNS = 40;
const MAX_TOOLS = 8;

/**
 * Shape check on what the dashboard sends. Anything else is refused. A
 * request is either one prompt or a conversation (which may carry tool calls
 * and results), optionally with a JSON schema or tool declarations.
 */
function validate(body) {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  if (typeof body.system !== "string" || body.system.length === 0) return "system must be a string";
  const hasPrompt = typeof body.prompt === "string" && body.prompt.length > 0;
  const hasContents = Array.isArray(body.contents) && body.contents.length > 0;
  if (!hasPrompt && !hasContents) return "prompt or contents is required";
  if (hasContents) {
    if (body.contents.length > MAX_TURNS) return "too many turns";
    for (const turn of body.contents) {
      if (!turn || (turn.role !== "user" && turn.role !== "model") || !Array.isArray(turn.parts)) {
        return "each turn needs a role of user or model and a parts array";
      }
    }
  }
  if (body.schema !== undefined && (typeof body.schema !== "object" || body.schema === null)) {
    return "schema must be an object";
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS)) {
    return "tools must be an array of at most " + MAX_TOOLS;
  }
  if (body.models !== undefined) {
    if (!Array.isArray(body.models) || body.models.length === 0) return "models must be a non-empty array";
    if (body.models.some((m) => !MODELS.includes(m))) return "models must be from the allowed list";
  }
  return null;
}

async function callModel(model, body, key, fetchImpl) {
  const response = await fetchImpl(`${GOOGLE}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: body.system }] },
      contents: body.contents ?? [{ role: "user", parts: [{ text: body.prompt }] }],
      ...(body.tools?.length ? { tools: [{ functionDeclarations: body.tools }] } : {}),
      generationConfig: {
        ...(body.schema ? { responseMimeType: "application/json", responseSchema: body.schema } : {}),
        temperature: 0.2,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    }),
  });
  if (!response.ok) return { ok: false, status: response.status };

  const data = await response.json();
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  if (parts.length === 0) return { ok: false, status: 502, reason: candidate?.finishReason ?? "empty response" };
  const text = parts.map((p) => p.text ?? "").join("");
  // The message is returned whole: a tool conversation must resend it as-is.
  return { ok: true, text, content: { role: "model", parts }, usage: data.usageMetadata ?? null };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function handle(request, env, fetchImpl = fetch, sleep = defaultSleep) {
  const origin = request.headers.get("Origin") || "";
  const allowed = allowedOrigins(env).includes(origin) ? origin : null;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return allowed
      ? new Response(null, { status: 204, headers: corsHeaders(allowed) })
      : new Response(null, { status: 403 });
  }
  if (url.pathname === "/health" && request.method === "GET") {
    return json({ ok: true, configured: Boolean(env.GEMINI_API_KEY) }, 200, allowed);
  }
  if (url.pathname !== "/generate" || request.method !== "POST") {
    return json({ error: "not found" }, 404, allowed);
  }
  if (!allowed) return json({ error: "origin not allowed" }, 403, null);
  if (!env.GEMINI_API_KEY) return json({ error: "assistant not configured" }, 503, allowed);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "request too large" }, 413, allowed);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "body is not JSON" }, 400, allowed);
  }
  const invalid = validate(body);
  if (invalid) return json({ error: invalid }, 400, allowed);

  const tried = [];
  // A tool conversation pins one model; otherwise try the allowed list.
  const candidates = body.models ?? MODELS;
  models: for (const model of candidates) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
      let result;
      const started = Date.now();
      try {
        result = await callModel(model, body, env.GEMINI_API_KEY, fetchImpl);
      } catch (cause) {
        // Timeout or network failure: worth trying the next model.
        tried.push({ model, status: cause?.name === "TimeoutError" ? 408 : 502, ms: Date.now() - started });
        continue models;
      }
      if (result.ok) {
        return json(
          { model, text: result.text, content: result.content, usage: result.usage, ms: Date.now() - started, tried },
          200,
          allowed,
        );
      }
      tried.push({ model, status: result.status, reason: result.reason, ms: Date.now() - started });
      // A request Google rejects as malformed will be rejected by every model.
      if (!RETRYABLE.has(result.status)) break models;
      // Overloaded: wait and ask the same model again. Rate-limited, gone or erroring: move on.
      if (!BUSY.has(result.status)) continue models;
    }
  }
  return json({ error: "no model could answer", tried }, 503, allowed);
}

export default {
  fetch: (request, env) => handle(request, env),
};
