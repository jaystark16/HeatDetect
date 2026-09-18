# ADR 0007 — No LLM in the pipeline

**Status:** accepted, 2026-09-18

## Context

"AI-based" in the problem title invites bolting on a language model — a chat panel, an
"AI summary", a natural-language query box.

## Decision

There is no LLM anywhere in this system.

The intelligence is a supervised tabular classifier plus deterministic statistical
persistence analysis. Evidence sentences shown to the user are produced by **templates
filled from computed values**, not generated prose.

## Reasoning

Every candidate LLM feature loses to a deterministic function on this workload:

| Candidate | Deterministic alternative | Verdict |
|---|---|---|
| "AI explanation" of a classification | Template over the actual feature values that drove it | Template wins: cannot hallucinate, cites real numbers, no latency, no cost |
| Natural-language search | Structured filters (class, date, confidence, region) | Filters win: precise, no misinterpretation |
| Report generation | Deterministic CSV/GeoJSON export plus a templated summary | Export wins: reproducible and auditable |
| Classification itself | Tabular classifier on numeric features | Classifier wins decisively; this is not a language task |

Introducing a model that generates text about safety-relevant thermal anomalies adds a
fabrication surface to the one part of the system that must never fabricate. An
evidence line reading "FRP is 9.0× this location's median" must be *true*, and the only
way to guarantee that is to compute it and substitute it.

## Consequences

- No API key, no token cost, no rate limit, no network dependency at request time.
- Evidence rendering is unit-testable: given features, assert the exact sentence.
- The project cannot claim "generative AI". It can claim something more defensible:
  every statement on screen traces to a number in the database.

## When to revisit

If a genuine language task appears — summarising free-text ground reports, parsing
incident bulletins, multilingual operator briefings — reconsider for *that* task only,
with retrieval grounding and schema-validated output. Do not add one for its own sake.
