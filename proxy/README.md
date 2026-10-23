# Assistant proxy

A Cloudflare Worker that holds the model API keys, so they never reach a browser. The Ask
tab sends it a conversation of computed facts and tool results; it relays them to
**Ollama Cloud** (`POST /ollama/chat`, answers first) or **Gemini** (`POST /generate`,
fallback) and returns the reply. Ollama refuses browser calls outright (CORS preflight 405),
so this Worker is the only way the site can use it. Design and measurements:
[ADR 0009](../docs/adr/0009-gemini-through-a-proxy.md).

## Deploy (once)

1. Create a free Cloudflare account (no card needed) at <https://dash.cloudflare.com>.
2. **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template.
   Copy the token. Note your **Account ID** (Workers & Pages overview, right-hand side).
3. Model keys, as GitHub secrets: `OLLAMA_API_KEY` (set 2026-10-23) and, optionally,
   `GEMINI_API_KEY` as a fallback. Use keys that have never been pasted anywhere else.
4. In the GitHub repository, **Settings → Secrets and variables → Actions**, add secrets:
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. Run **Actions → Deploy assistant proxy → Run workflow**. It prints the Worker's URL,
   e.g. `https://heatdetect-assistant.<your-subdomain>.workers.dev`.
6. Add the repository **variable** `ASSISTANT_URL` with that URL, and re-run
   **Deploy dashboard to GitHub Pages**. The Ask tab then answers with Ollama, falling
   back to Gemini.

The workflow redeploys whenever `proxy/` changes.

## Run locally

```bash
node proxy/dev.mjs
```

with `OLLAMA_API_KEY=...` and/or `GEMINI_API_KEY=...` in `proxy/.dev.vars` (git-ignored), and
`VITE_ASSISTANT_URL=http://localhost:8787` in `frontend/.env.local` (git-ignored).

## What it refuses

Any origin not in `ALLOWED_ORIGINS` (`wrangler.toml`), any route but `POST /generate` and
`POST /ollama/chat`, bodies over 256 KiB, malformed conversations, and models outside its
allow-lists (`MODELS`, `OLLAMA_MODELS`). It never echoes a key, and reports which models it
tried and why each was skipped.
