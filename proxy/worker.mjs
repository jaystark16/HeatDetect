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
 *   - tries models best-first and falls back when one is overloaded or
 *     retired, reporting which model answered and which were tried.
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
 * Models that just said they were overloaded are skipped for a while instead
 * of being asked again first: three 503s in a row cost ~30 s on one question.
 * Per isolate, so it is a hint, not shared state; a cold isolate simply asks.
 */
const COOLDOWN_MS = 60_000;
const coolingUntil = new Map();

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
function validate(body) {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  if (typeof body.system !== "string" || body.system.length === 0) return "system must be a string";
  if (typeof body.prompt !== "string" || body.prompt.length === 0) return "prompt must be a string";
  if (!body.schema || typeof body.schema !== "object") return "schema must be an object";
  return null;
}

async function callModel(model, body, key, fetchImpl) {
  const response = await fetchImpl(`${GOOGLE}/${model}:generateContent`, {
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
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  if (!text) return { ok: false, status: 502, reason: candidate?.finishReason ?? "empty response" };
  return { ok: true, text, usage: data.usageMetadata ?? null };
}

export async function handle(request, env, fetchImpl = fetch) {
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
  const now = Date.now();
  // Cooling models go last rather than being dropped, so a request can still
  // succeed when every model has recently been busy.
  const order = [
    ...MODELS.filter((m) => !((coolingUntil.get(m) ?? 0) > now)),
    ...MODELS.filter((m) => (coolingUntil.get(m) ?? 0) > now),
  ];
  for (const model of order) {
    let result;
    const started = Date.now();
    try {
      result = await callModel(model, body, env.GEMINI_API_KEY, fetchImpl);
    } catch (cause) {
      // Timeout or network failure: worth trying the next model.
      tried.push({ model, status: cause?.name === "TimeoutError" ? 408 : 502, ms: Date.now() - started });
      continue;
    }
    if (result.ok) {
      return json(
        { model, text: result.text, usage: result.usage, ms: Date.now() - started, tried },
        200,
        allowed,
      );
    }
    tried.push({ model, status: result.status, reason: result.reason, ms: Date.now() - started });
    if (result.status === 503 || result.status === 429) coolingUntil.set(model, Date.now() + COOLDOWN_MS);
    // A request Google rejects as malformed will be rejected by every model.
    if (!RETRYABLE.has(result.status)) break;
  }
  return json({ error: "no model could answer", tried }, 503, allowed);
}

export default {
  fetch: (request, env) => handle(request, env),
};
