/**
 * Run the Worker locally with plain Node, no Cloudflare account needed:
 *
 *     GEMINI_API_KEY=... node proxy/dev.mjs        # listens on :8787
 *
 * or put `GEMINI_API_KEY=...` in proxy/.dev.vars (git-ignored). The same
 * handler runs in production; this only adapts Node's HTTP server to it.
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { handle } from "./worker.mjs";

function devVars() {
  try {
    const text = readFileSync(fileURLToPath(new URL("./.dev.vars", import.meta.url)), "utf8");
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^"|"$/g, "")];
        }),
    );
  } catch {
    return {};
  }
}

const env = {
  ALLOWED_ORIGINS: "http://localhost:5173,http://localhost:4173",
  ...devVars(),
  ...(process.env.GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY } : {}),
};
const port = Number(process.env.PORT || 8787);

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await handle(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => {
  console.log(
    `assistant proxy on http://localhost:${port} (key ${env.GEMINI_API_KEY ? "loaded" : "MISSING"})`,
  );
});
