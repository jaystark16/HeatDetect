# Assistant proxy

A Cloudflare Worker that holds the Gemini API key, so it never reaches a browser. The Ask
tab sends it a briefing of computed facts and a question; it calls Gemini and returns a
structured answer. Design and measurements: [ADR 0009](../docs/adr/0009-gemini-through-a-proxy.md).

## Deploy (once)

1. Create a free Cloudflare account (no card needed) at <https://dash.cloudflare.com>.
2. **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template.
   Copy the token. Note your **Account ID** (Workers & Pages overview, right-hand side).
3. In Google AI Studio, create a new API key for this service. Do not reuse one that has
   ever been pasted anywhere else.
4. In the GitHub repository, **Settings → Secrets and variables → Actions**, add secrets:
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GEMINI_API_KEY`.
5. Run **Actions → Deploy assistant proxy → Run workflow**. It prints the Worker's URL,
   e.g. `https://heatdetect-assistant.<your-subdomain>.workers.dev`.
6. Add the repository **variable** `ASSISTANT_URL` with that URL, and re-run
   **Deploy dashboard to GitHub Pages**. The Ask tab then answers with Gemini.

The workflow redeploys whenever `proxy/` changes.

## Run locally

```bash
node proxy/dev.mjs
```

with `GEMINI_API_KEY=...` in `proxy/.dev.vars` (git-ignored), and
`VITE_ASSISTANT_URL=http://localhost:8787` in `frontend/.env.local` (git-ignored).

## What it refuses

Any origin not in `ALLOWED_ORIGINS` (`wrangler.toml`), any route but `POST /generate`,
bodies over 256 KiB, and requests without a system prompt, prompt and JSON schema. It
never returns free text, never echoes the key, and reports which models it tried.
