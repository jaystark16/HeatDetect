# HeatDetect — lessons log

Append-only, newest first. Record decisions and their reasons, failures and why,
and debugging discoveries. Don't repeat what git history or the code already says.

## 2026-10-09

- **The Ask tab looks things up instead of reading a fixed briefing.** Gemini only saw ~75
  precomputed facts, so anything outside them ("Gujarat this week", "what's near this
  point") came back unanswerable — the "fixed questions" complaint. It now calls tools
  that run over every location (`tools.ts`), with the conversation kept for follow-ups.
  Measured live: "anything burning in Gujarat this week?" → 110 locations (8 persistent
  industrial, 22 vegetation, 80 unclassified); the follow-up "only the industrial ones?"
  → 8 and 0; "is 23.75, 86.42 an industrial site?" → nearest location unclassified, 14 of
  27 within 5 km persistent industrial. Every number matched an independent recount.
- **A named place is Gemini's approximate box, and says so.** No gazetteer exists offline.
  The search fact reads "the assistant's approximation of Gujarat (not an official
  boundary)", and the citation check lets a sentence name the place only by citing it.
- **Rate limits are per model: move on, don't retry.** Retrying 429s made a follow-up take
  188 s. Only 503 (overloaded) is retried now; 429 goes straight to the next model.
- **A count must be described as what it counts.** Gemini called 27 locations of any class
  (12 unclassified) "consistent with industrial activity". No mechanical check catches
  that; the prompt now requires the class breakdown, and the re-run was correct.
- **The live site still has no Gemini.** The `GEMINI_API_KEY` secret is not set, so the
  public Ask tab answers from keywords only. The owner has to set it.

## 2026-10-08

- **Same-pass context made the model better; gradient boosting made it worse.** Adding
  pass-context features (`pass_context`) lifted 5-fold spatial CV macro F1 from 0.570 to
  0.606, winning in all five folds. Nearly all of the gain is the same-pass neighbourhood;
  physics, solar time and facility category alone added ~0.005. Balanced
  HistGradientBoosting on the same features scored 0.482. `industrial_fire` is still
  unreportable (precision ~0.09). A single 70/30 block split moves macro F1 by ±0.01–0.05
  depending on the blocks, so compare models with cross-validation, not one split.
- **Cloudflare proxy dropped; the public site calls Gemini directly.** The owner didn't
  want to set up Cloudflare and accepted that the key becomes readable in the site's
  JavaScript. The key comes from the `GEMINI_API_KEY` secret at build time and is never
  committed. The proxy still works if `ASSISTANT_URL` is ever set. Locally, Gemini answers
  took 50 to 60 s because the free tier kept returning "busy" for the full Flash models.
- **Dashboard chrome is neutral; colour is reserved for data.** The old orange chrome
  (`--ember`) was the same hue as `industrial_fire`, so active tabs, sliders and the
  headline count read as data. Controls are now greys and white (Apple system dark
  palette, Geist type), and orange on screen means only that class. Also removed: the
  giant gradient location count, tracked all-caps labels, the three stat tiles (now a
  grouped list), and the search box on static builds, where it could never work.
  Branch `claude/dashboard-redesign`.
- **Context files split by purpose.** The shared rules moved from `CLAUDE.md` to
  `AGENTS.md` so Antigravity and other tools read the same instructions. `CLAUDE.md`
  now imports `AGENTS.md`, `SOUL.md` and `CONTEXT.md`. The previous 19 KB `CONTEXT.md`
  handoff was redistributed across the new files.
- **Size comments went stale.** `.gitignore` and `render.yaml` call the model 2.4 MiB,
  but `single_observation_rf.joblib` measures 7,808,041 bytes (7.45 MiB). Measure
  before quoting sizes.

## 2026-10-07

- **A small on-device model built untrue claims from true numbers.** Qwen3-1.7B was
  given correct facts and still produced false comparisons and causes. Answers now go
  through Gemini behind a key-holding proxy, and `verify.ts` withholds any sentence its
  own citations don't support (ADR 0009). The on-device model stays only as an offline
  fallback.
- **Model wording that adds comparisons, reasons or lists gets withheld.** Rewording is
  where a language model slips in claims, so the gate checks those three things
  explicitly.
- **The static site carried detail for only 300 locations.** Every other mark said
  "Detail unavailable". Each location's detail is now its own small file, generated per
  Pages build (~19,900 files, ~60 MiB, not committed) and fetched on click. A failed
  fetch shows as an error, never as "no evidence".
- **Leaflet was replaced with MapLibre GL.** Leaflet can only draw Web Mercator, so
  zooming out tiled the world into a strip with every Indian mark piled into one blob.

## 2026-10-06

- **The deployed snapshot carried fabricated timestamps.** It stored each detection's
  age and rebuilt the time as "now minus age", which shifted every detection forward by
  the age of the file. A 19 September detection was shown as 2 October, and "Last 24
  hours" returned 57 two-week-old detections. The snapshot is now rebuilt from FIRMS
  every 3 hours with real timestamps, and a regression test fails on any timestamp
  outside the declared window.
- **The page only claims "Near real time" while the schedule is demonstrably keeping
  up.** If the scheduled build stops, it falls back to "Cached snapshot" on its own.

## 2026-09-23

- **The map drew detections, not locations.** A recurring source emits one row per
  satellite pass, so the top 4,000 persistence-ranked detections were *all* industrial,
  and the map showed zero vegetation fires while the database held thousands. Fixed by
  `GET /api/locations`, which aggregates to one row per cell server-side.
- **Thresholds tuned to a 7-day window broke at 60 days.** A fixed "4 distinct days"
  meant 57% of a 7-day window but 6.5% of a 61-day one. Stroke weights maxed out, and a
  label still read "Full 7-day window". Anything tied to the window must be derived from
  the data's actual span.
- **`industrial_fire` F1 of 0.127 was noise.** It was measured at the 7-day window and
  went back to zero at scale. Don't report a single-run gain on a rare class as progress.

## 2026-09-18

- **Fabricated sample data shipped first.** A hand-written `sample_data.py` held invented
  FRP values, baselines and confidences. It was deleted, and CI fails the build if it
  returns. Never reintroduce fabricated data under any name.
- **Reported metrics went stale three times.** Once, the UI said "zero recall" for a
  class whose recall had risen to 0.32. The README block is now generated from
  `metrics.json` and enforced by CI.
- **Model versions weren't unique.** Two runs on the same day produced the same version
  string, so a stale model looked like a fresh one. Versions now carry a
  training-set fingerprint.
- **A conclusion was recorded too confidently.** The `full` vs `no_coords` macro-F1 gap
  flipped sign twice across coverage levels. A difference that changes sign as data
  grows is variance, not evidence.
- **The feed was measured, not assumed** (`docs/findings/2026-09-18-feed-characterisation.md`):
  refinery flares are largely absent, FRP is small (median ~1.6 MW), and Overpass failed
  6 of 12 sequential point queries. So: scope claims to coal-seam fires and industrial
  belts, and prefetch OSM tiles in bulk.
- **The credential scanner flagged test fixtures.** Exempting test files would let a
  real leak hide there, so each deliberate fake carries a same-line marker instead.
- **Vercel and Supabase are unavailable.** The owner has no project space left on
  either. Hosting moved to GitHub Pages, with Render and Cloudflare as options.
