# Which Ollama Cloud model answers the Ask tab — 2026-10-23

**Question.** The owner asked for "the best model" from the Ollama Cloud free list: beam,
gemma4:31b, gpt-oss:120b, gpt-oss:20b, nemotron-3-nano:30b, nemotron-3-super,
nemotron-3-ultra. Best meant natural, human answers that are still accurate.

**Result.** Order in `proxy/worker.mjs` (`OLLAMA_MODELS`): **nemotron-3-super**,
gemma4:31b, beam, gpt-oss:120b. The others are not used.

## Method

- HeatDetect's own pipeline, unchanged except for the model: `askAgent` (research with
  `search_locations` / `location_detail`, then a cited answer), the proxy's request code
  (`handle` from `proxy/worker.mjs`), and the citation check (`verifyCited`). Live
  snapshot of 2026-10-23 (32,138 locations), brief mode, one model per run.
- 14 questions in four rounds: five first-round questions; the same five after the voice
  prompt changed; five held-out questions the prompt was not tuned on; four hard ones
  after the citation check was fixed.
- Every shown answer was recounted by hand from the snapshot (counts, rankings, distances,
  classes). "Natural" is the reviewer's judgement; five to nineteen questions per model is
  a small sample.

## Results

| Model | Answered | Sentences passed | Median time | Accuracy notes |
|---|---|---|---|---|
| **nemotron-3-super** | 18/19 | 28/31 | 13.1 s | Looked up the exact point for "was there an accident at …"; once called a 45-day site "most active" while a 46-day possible industrial fire existed |
| **gemma4:31b** | 18/19 | 28/34 | 4.0 s | No error found; terser; more sentences withheld (unstated causes, comparisons) |
| **beam** | 12/14 | 29/33 | 16.5 s | Richest answers; once listed 45 days before 46 and 22.2 MW before 23.2 MW; its comparisons are often withheld |
| gpt-oss:120b (was first) | 5/5 | 9/10 | 6.6 s | Report-like; answered the accident question without a lookup and missed a persistent source 70 m from the point |
| nemotron-3-ultra | 5/5 | 8/9 | 51.0 s | Too slow (up to 89 s); also missed the source at the point |
| nemotron-3-nano:30b | 5/5 | 7/9 | 14.5 s | Two sentences withheld |
| gpt-oss:20b | 5/5 | 9/10 | 18.8 s | Same accident miss; an unqualified "top" claim |

Example, "how far can I trust the classifier?", nemotron-3-super after the fixes below:
"For persistent industrial sources it matches the rule set about 75% of the time
(precision 0.753, recall 0.801) … these scores only measure consistency with the documented
rules, not real-world correctness."

## Changes made because of what this showed

- **Voice prompt** (`frontend/src/assistant/gemini.ts`, `VOICE`): with only "be natural",
  every model wrote report prose ("There are 3 matches around Vizag, all of which are
  classified as…"). Now: lead with the answer, plain words, no "matches"/"locations of
  any class", one or two numbers per sentence. After: "Three spots around Vizag showed
  heat in the last 24 hours, and all three are persistent industrial sources."
- **"Right now" means the last 24 hours**: one model searched 6 and 12 hours, found
  nothing, and said so, while three sources had been seen 13 hours earlier.
- **Citation check** (`verify.ts`):
  - Spelled-out numbers ("Seventy-two") were never checked; they now are, like digits.
  - "about 94,000", "94 thousand", "94k" are read as values; rounding to a magnitude is
    allowed only when hedged ("about", "around", …) or scaled ("thousand").
  - "93%" may restate a fact's 0.926.
  - A negated certainty word ("nothing confirms an accident") is a hedge, not a claim.
- **Search results state the industrial total** ("97 of them possible or persistent
  industrial"), so a comparison between two states does not need the model to add.

## Limits

- Free-plan models change without notice; re-run this comparison when the list changes.
- The citation check proves numbers and names are supported, not that a ranking or a
  "most active" judgement is the right reading. Those slips were found only by hand.
