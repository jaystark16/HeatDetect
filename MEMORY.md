# HeatDetect — lessons log

Append-only, newest first. Record decisions and their reasons, failures and why,
and debugging discoveries. Don't repeat what git history or the code already says.

## 2026-10-23

- **Ollama model order chosen by measurement, not by size.** The owner asked for the best
  free model. All seven were run through the real Ask pipeline on up to 19 questions,
  every answer recounted by hand: nemotron-3-super first (most natural and complete),
  gemma4:31b second (no error found, fastest), then beam and gpt-oss:120b. The biggest,
  nemotron-3-ultra, took 51 s per answer. Details:
  `docs/findings/2026-10-23-ollama-model-comparison.md`.
- **"Be natural" alone did not make any model natural.** A voice prompt with concrete rules
  and a before/after example did.
- **Spelled-out numbers bypassed the citation check.** Asking for natural wording produced
  "Seventy-two sources"; the check only read digits. It now reads number words, "94
  thousand", "about 94,000" (rounding only when hedged) and percentages of stated
  fractions. "Nothing confirms an accident" is no longer withheld for "confirms".

- **States are searched by their real boundary, not a box the model guesses.** The
  model's "Odisha" box returned 66 persistent sources; by boundary there are 36. The
  other 30 were in Chhattisgarh (16), West Bengal (7), Jharkhand (5) and Andhra Pradesh (2).
- **Boundary source choice.** The owner chose India's official map for disputed areas.
  Natural Earth draws Kashmir along the line of control and put Puducherry town in Tamil
  Nadu, so India comes from datta07/INDIAN-SHAPEFILES (MIT; it draws India's official
  boundary, but its upstream source is unnamed). Natural Earth is used for neighbouring
  countries only: its provinces there are stale (Nepal's 14 zones, Pakistan's FATA,
  7 Bangladesh divisions). geoBoundaries was ruled out because it replaces disputed areas
  with US State Department lines.
- **How it was checked.** Reference places, including Gilgit, Muzaffarabad and Aksai Chin
  under India's view, were all right. Natural Earth's India agreed on 98.4% of Indian
  locations. Of the 43 disagreements more than 1.5 km from a boundary, OpenStreetMap
  (Nominatim) sided with our file in 42; the one miss is Assam vs West Bengal near Dhubri.
  76 locations fall in no region; the ones checked are offshore (Bombay High, Gulf of Kutch).
- **Older databases gain the new columns in place.** `init_schema` adds missing nullable
  columns, so a database from before regions does not fail on the new query.

- **"Give me those locations" got a count and no locations.** Brief mode allows one to
  three sentences and no lists, and the location list showed only locations a sentence
  cited; the answer cited the search total. A cited search total now lists that search's
  ranked matches under a heading ("Top 25 of 66, ranked by distinct days seen"), and the
  research prompt asks for a limit of 25 when locations are wanted.
- **Follow-ups searched a different box.** "How many in Odisha?" → 66, then "give me
  those locations" → 61: the model only saw the earlier answer's wording. The history now
  carries each earlier tool call verbatim; retested, 66 then 66.

- **A correct Vizag answer was withheld for saying "Vizag".** gpt-oss searched the right
  box (17.7° N, 83.3° E) but did not label it, and the check only accepted place names
  found in cited fact text. Now a place the user typed may be named from an unlabelled
  area or point search; a search the model did label must use its own label, and a
  ranked match counts its search's description as cited. If an answer is still withheld,
  the lookup's computed facts and locations are shown instead of a dead end.
- **Google Maps links come from the data, never the model.** `frontend/src/maps.ts`
  builds `google.com/maps/search/?api=1&query=lat,lon` (Google's documented Maps URLs
  format) from each location's own coordinates at 5 decimals. Verified: the link for
  17.60913, 83.20387 opened Google Maps at exactly that point (Nadupuru, Andhra Pradesh).
  Google rejects "17.609° N, 83.204° E" when pasted; the page now also shows "17.60913,
  83.20387".
- **Two template-literal regexes in `verify.ts` never matched.** `\b` inside a
  backtick string is a backspace character, so "a cited fact uses the same comparison
  word" and "a cited fact states this cause" were always false. Fixed to `\\b`; all
  sources scanned for stray control characters (none left).

- **Ollama Cloud added; it answers first.** Free plan: gpt-oss:120b, gemma4:31b,
  gpt-oss:20b; other big models return 402. Ollama has no browser path (CORS preflight
  405), so it needs the proxy, and the owner chose to create the Cloudflare account.
  `OLLAMA_API_KEY`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are GitHub secrets.
- **A new Cloudflare account cannot deploy a Worker until it has a workers.dev
  subdomain.** The first deploy uploaded the script and then failed; registering the
  subdomain once in the dashboard fixed it. The new URL then failed TLS for about a
  minute while its certificate was issued.
- **The public Ask tab answers with Ollama (2026-10-23).** "anything burning in Gujarat
  this week?" → 13 persistent, 70 vegetation in 8.5 s; the deep follow-up → 13 / 91 (a
  wider box), top source 21.101° N, 72.641° E at 55 days, 49.1 MW. All matched a recount
  from the live snapshot.
- **No Ollama model enforces a JSON schema.** `format` and `response_format` were both
  ignored; replies came back as prose, fenced JSON, or `{"answer": 15}`. The shape is now
  checked on arrival with one retry.
- **A model asked for a class that does not exist and would have got everything.** The
  search treated an unknown class as "any"; it now refuses with the valid values.
- **The Pages build no longer inlines the Gemini key once the proxy exists.** Unused, it
  would still have been in the public bundle.

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
