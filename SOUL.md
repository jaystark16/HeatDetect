# HeatDetect — soul

## Why it exists

Satellite fire monitoring tells you *where* unusual heat is, not *what caused it*.
NASA FIRMS reports a hotspot the same way whether it is routine process heat, a
century-old coal-seam fire, or an incident in progress. HeatDetect closes that gap
by adding context: nearby industry, land use, and above all **time**.

## Who it's for

- **Analysts at a body like NTRO** who need to know which thermal anomalies deserve a
  second look, and why.
- **SIH judges** who should understand it in seconds: "here is the hotspot → here is
  the context → here is what the system concluded → here is why → here is the history."
  (Demo principle from the team plan.)

## The core idea

A routine industrial source and an incident at the same site look nearly identical in
one satellite pass. What separates them is history: a persistent source recurs with a
stable baseline, and an incident is a *deviation* from it.

## What "good" looks like

- Every number on screen can be traced to ingested data and a named dataset.
- A judge who asks "how do you know?" gets an answer one click away.
- The system says "not classified" before it guesses.
- Metrics are honest. They include the class it is bad at.

## Principles

1. **No evidence, no claim.** Never invent an observation, statistic, facility name,
   confidence or metric.
2. **Deterministic code owns facts.** Distances, counts, persistence and thresholds are
   code. A model only estimates a class for a lone detection with no history, and a
   language model only words facts it is handed.
3. **Abstain rather than mislead.** A missing survey is not "no industry nearby". A
   class the model is measurably bad at is suppressed, not shown.
4. **Failure is loud.** A fetch failure must never look like "no activity".
5. **Observed, derived and inferred stay visibly separate**, in storage, API and UI.
6. **Scope claims to what was measured.** For example, refinery flares are largely
   invisible to active-fire products, so we don't claim to monitor them.

## Tone and voice

- Hedged and plain: "possible", "candidate", "consistent with". Never "confirmed",
  "definitely", "proof".
- A thermal anomaly is **evidence of unusual heat, not proof of a fire, accident or
  explosion**.
- Report what came back, not what was attempted: "returned 7,479 rows", not
  "successfully ingested".
- Say "analysis area", not "India": the bounding box also covers neighbouring countries.

## What it must never become

- "Upload a colourful thermal image and the AI says fire."
- A demo running on fabricated or "illustrative" data, under any name.
- A system that presents a hotspot as a confirmed accident or explosion.
- A chatbot whose sentences are not backed by computed, cited facts.
- A model score dressed up as certainty, e.g. a probability on a threshold verdict.
