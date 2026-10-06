# ADR 0008 — An on-device assistant that words answers but never supplies facts

**Status:** accepted, 2026-10-07. Narrows [ADR 0007](0007-no-llm.md) for one task.

## Context

ADR 0007 kept language models out of the system: every candidate feature lost to a
deterministic function. It named the condition for revisiting: a genuine language task,
handled with retrieval grounding and schema-validated output.

The team asked for an assistant beside the map: a place to ask, in plain words, "what
is new in the last day?" or "which industrial sources are most persistent?" and get a
short answer. Turning free-text questions into a structured query, and a table of
results into two readable sentences, is a language task. Doing it with a filter panel is
possible but asks a non-specialist judge or operator to learn the panel first.

Hosting constraints rule out a server-side model: the dashboard is a static site on
GitHub Pages with no backend, and no paid hosting is available.

## Decision

Run a small open-weight model **in the visitor's browser** (WebLLM over WebGPU), and
confine it to two jobs, neither of which lets it state a fact:

1. **Routing.** It maps the question to one of a fixed set of intents with parameters
   (class, time window, limit, coordinates), under a JSON schema enforced by grammar-
   constrained decoding. It cannot produce anything outside that schema.
2. **Wording.** Code answers the intent from the loaded data and produces the facts
   and a templated answer. The model may rephrase those facts in two to four sentences.

Then a **verifier** checks the model's wording: every number in it must appear among the
computed facts, and certainty words ("confirmed", "definitely", "proof") are rejected.
If the wording fails, the templated answer is shown instead, and the page says the
model's wording was rejected and why. The facts behind every answer are always shown
beneath it, each with a link to its location on the map.

Model: Qwen3-1.7B, 4-bit (`Qwen3-1.7B-q4f16_1-MLC`), Apache-2.0, ~940 MiB downloaded
once and cached by the browser. It is never loaded without the visitor pressing a
button that states the download size.

## Reasoning

- **Facts stay deterministic.** The model selects and phrases; code computes. A wrong
  route produces a correct answer to the wrong question, which is visible because the
  answer states what it answered. A wrong number cannot reach the screen.
- **No server, no key, no cost per question**, and nothing the visitor types leaves
  their device.
- **Degrades to nothing worse than buttons.** Without WebGPU, or before the download,
  the suggested questions still work through the same deterministic intents.

## Measured on the development laptop (Intel Arc integrated graphics, Chrome)

- First load: 502 s — about 255 s downloading 924 MB, then about 245 s loading the
  weights onto the GPU. Loading from the browser's cache still takes minutes, not
  seconds, on this hardware.
- Routing a question: ~5 s once warm; the first request after loading took 29 s.
- Wording an answer: 7–11 s.
- Routing quality, 6 test questions: 5 correct; "hottest industrial spots" went to
  *most persistent* instead of *strongest*. Keywords now route first and the model
  only handles what keywords cannot place, which also saves the 5 s.
- Wording quality: one of three answers was faithful and useful; one was commentary
  with no result; one called a location "the coal mine" because the question did.
  Both failures led to gate rules (state the result; no source type the data does not
  establish), each with a regression test built from the observed text.
- On the deployed site, in a fresh browser with no cache: loaded in 348 s. Two worded
  answers passed the gate as it then stood, and both carried a claim nothing computed:
  "the most persistent, with the highest peak power" when another listed source peaked
  higher, and "consistent with vegetation fire based on the thermal signature". Both are
  now rejected: comparisons and reasons are allowed only where the computed answer
  makes them, and lists are rejected. A region named without coordinates ("Punjab") was
  correctly refused. A vague question ("where should an analyst look first?") was routed
  to the open location; the routing prompt now restricts that intent.

**What this adds up to.** Under the current gate, all five worded answers observed in
testing would be withheld — four for real faults, one (a true comparison) because the
rule cannot tell true comparisons from false ones. A 1.7B model routinely builds untrue
claims from true numbers. Its wording therefore rarely reaches the screen, and that is
the gate working as intended: the computed answer is shown, with the reason. The model's
practical value here is routing unusual phrasing, not prose. A larger model, on-device
or hosted, would be needed for wording that survives the gate.

## Consequences

- First use costs a ~940 MiB download and minutes of loading; it is opt-in for that
  reason, and the page says so before anything downloads.
- Needs WebGPU: current Chrome and Edge on desktop, not many phones.
- The assistant can only answer what the intents cover. Questions outside them get a
  plain statement of what it can answer, not an attempt.
- There is no place-name lookup offline, so "near Jharia" is not answerable; "near
  23.75, 86.42" is.

## Not decided here

A server-side model with a paid key remains possible later. It would change where the
model runs, not this division of labour.
