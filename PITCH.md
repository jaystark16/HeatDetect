# HeatDetect — pitch and demo

The title, category, deliverables and § numbers below come from the team's planning PDF
(`SIH26162_Team_Project_Plan.pdf`), which isn't in the repo. The README confirms only
SIH26162, NTRO and Disaster Management.

## Problem statement

- **ID:** SIH26162, Smart India Hackathon 2026
- **Title:** AI-Based Detection and Classification of Industrial Fires and Persistent
  Thermal Sources
- **Organisation:** National Technical Research Organisation (NTRO) · Category: Software ·
  Theme: Disaster Management
- **Expected deliverables:** (1) classify/segregate industrial fires from forest and other
  natural fires; (2) a GIS solution for storing results and showing them as map overlays.
- **Judging criteria:** not recorded yet. Add them here when known.

## The story in one breath

Satellites tell you where unusual heat is, not what caused it. HeatDetect adds what a
single pass can't show: nearby industry, land use, and **time**. A persistent source
recurs with a stable baseline, and an incident is a deviation from it. Every verdict
shows its evidence, and when the evidence is missing the system says so.

Team pitch line (from the plan): *"Our platform does not merely show that a satellite
detected heat; it combines thermal detections with industrial, land-cover and temporal
context to classify and monitor the likely source on an interactive GIS dashboard."*

## What we may claim, and what we may not

**Can claim (measured):**
- Real NASA FIRMS data, refreshed every 3 hours, with provenance on screen.
- It detects and monitors coal-seam fires, mining and coal-handling areas, power stations
  and industrial belts. Over the 61-day backfill, the most persistent sources are all
  named heavy industry (README: Hazira steel, the Jharia BCCL coal clusters, JSW
  Vijayanagar).
- Every classification is traceable: rule thresholds are published (`/api/rules`), and
  model metrics are generated, CI-checked and include the class it fails on.

**Must not claim:**
- Refinery gas-flare monitoring. Zero detections fell within 5 km of Jamnagar or Vadinar
  in a 24-hour window. Flares are why VIIRS Nightfire exists.
- That a hotspot is a confirmed fire, accident or explosion.
- Accuracy as a headline number (it is never reported), or that labels are ground truth.
- That the model detects `industrial_fire`. It is suppressed; that class comes from the
  rules.
- Facility-level certainty. At 375 m resolution, attribution is "near", not "at".

## Demo script

Adapted from the plan's §15 to what is actually built. Use the live site; it needs no
backend.

1. **Open the dashboard.** Point at the provenance bar: real FIRMS data, when it was
   rebuilt, and when a satellite last saw anything.
2. **Show the globe flying in to the analysis area.** Click a class in the legend to
   isolate it, then click again to show all. `unknown` renders hollow on purpose.
3. **Click a persistent industrial location** (e.g. a Jharia cluster). Show the
   satellite imagery basemap, and optionally 3D terrain.
4. **Geographic context:** the nearest facility and the facility count within 5 km.
5. **Computed from history:** distinct days, median and p90 FRP, deviation ratio, first
   and last seen.
6. **Classification and its origin.** A rule verdict says "Deterministic rules" and shows
   *no probability, on purpose*: a threshold comparison doesn't have one. A model verdict
   shows its probability or says it abstained. (The plan's example "Confidence 0.87"
   doesn't apply to rule verdicts. Say why if asked.)
7. **Evidence sentences:** built from real values, not generated.
8. **Ask tab:** ask "is there a refinery fire in Gujarat right now?". It withholds its own
   answer, because no cited fact names Gujarat or a refinery, and it says so. Click a
   citation to show the facts behind a sentence. (Gemini answers only once the proxy is
   deployed. Until then it uses the on-device model or computed answers.)
9. **Close on honesty:** open the model metrics, show the suppressed class and the
   leakage caveat, and explain why that makes the system trustworthy rather than weak.

**Not demo-able yet (plan §15 step 8):** the alert view and report export. See `ROADMAP.md`.

## Likely judge questions

- *"Where is your ground truth?"* There isn't any public ground truth. Nightfire needs a
  licence. Our labels are documented heuristics, and our metrics are labelled as
  agreement, not validation.
- *"Why not a CNN on thermal images?"* There is no reliable labelled image dataset, and
  the colours are a visualisation, not a measurement (the plan's own warning).
- *"Why is your rarest class at zero?"* An industrial fire is an excursion from a
  baseline, and one observation can't see the baseline. The rules see it. The model is
  suppressed rather than allowed to guess.
