# ADR 0009 — Gemini answers in the Ask tab, through a key-holding proxy, citing every fact

**Status:** accepted, 2026-10-07. Builds on [ADR 0008](0008-on-device-assistant.md); the
on-device model becomes the offline fallback.

## Context

ADR 0008 put a 1.7B model in the browser, confined to routing and rewording. Measured on
the deployed site, it routinely built untrue claims from true numbers, and the gate
withheld nearly everything it wrote. The team wants a model that can actually analyse:
read the system's whole picture and reason about it.

Google's Gemini API offers that, and the team has a key. The dashboard is a static site,
so the key cannot be called from the page without being published in its JavaScript.
This is a production system, so that is not acceptable at any stage.

## Decision

1. **The key lives in a Cloudflare Worker** (`proxy/worker.mjs`), deployed from CI with
   the key passed from a GitHub secret into the Worker's encrypted secrets. The Worker
   accepts one route from allowed origins, bounds request and response size, forces JSON
   output under the caller's schema, and falls back through models best-first when one
   is overloaded. It is never in the repository, the website or a log; CI fails if a
   Google key pattern is committed.
2. **Gemini sees a briefing, not the raw data** (`frontend/src/assistant/briefing.ts`):
   75-odd numbered facts computed from the same rows the map draws — provenance and
   freshness, how classification works and the classifier's measured precision and
   recall, totals, recent activity, explicit rankings, one-degree concentrations, the
   open location's full evidence, and the computed answer to the question where one
   exists.
3. **Every sentence must cite the facts it rests on**, and is checked against *those*
   facts (`verifyCited` in `verify.ts`): numbers must appear in them; names and source
   types must appear in them; comparisons need a cited ranking; stated causes must be
   stated in them; certainty words are refused. A failing sentence is withheld, its
   reason shown. The briefing itself is one click away under each answer.
4. **Fallbacks are explicit.** If Gemini is unreachable or every model is busy, the
   on-device model (if loaded) or the computed answer is shown, with the reason.

## Measured, 2026-10-07

- The full Flash models (3.8, 3.5, flash-latest) returned 503 "high demand" for long
  stretches; Flash-Lite answered in 1–3 s. A 60 s cooldown on busy models first cut a
  95 s question to 3–4 s; it was replaced by retries (below), trading speed for accuracy.
- An overall-analysis question: every sentence passed and was correct against the data.
  One nuance no rule can catch — "locations in India" for an area that includes
  neighbouring countries — led to stating the area's extent in the first fact.
- "Is there a refinery fire in Gujarat right now?": all three answer sentences were
  withheld (no fact names Gujarat or a refinery), and the page said why rather than
  substituting an unrelated computed answer. Its cited analysis passed.
- Withheld correctly in testing: a value Gemini derived by subtraction (3,174 unsurveyed
  cells) that no fact states, and an unranked comparison.

## Revised the same day: short answers, accuracy over speed

The team asked for straight answers and does not mind waiting:

- **Brief by default.** Gemini gives one or two cited sentences ("There are 15 possible
  industrial fires. [13]") and the page asks "Want a deeper analysis?". Only a yes —
  the button, or typing "yes", "go deeper", "tell me more" — requests the full answer,
  analysis, caveats and follow-ups.
- **Retries replace the cooldown.** A busy model is asked again after 3 s and 8 s before
  the next, lighter model is tried; the cooldown that pushed questions to Flash-Lite for
  speed is gone. Measured: a brief answer took 71 s after nine busy attempts (Flash-Lite
  answered); the deep follow-up got gemini-3.5-flash after three. Every number in that
  deep answer — 15 fires, 2,389 detections, 6 in 24 h, the strongest at 20.962° N,
  85.174° E, 30.6 MW, 38 days — matched an independent recount from the snapshot.

## Consequences

- Questions and the briefing are sent to Google; the Ask tab says so.
- The gate is conservative: true derived values and some true comparisons are withheld.
  That is the intended trade for never showing an unsupported claim.
- Answer quality depends on which model is available; the answer names the model.
- Deploying the Worker needs a Cloudflare account and three repository secrets
  (see `proxy/README.md`). Until then the Ask tab works without Gemini.
