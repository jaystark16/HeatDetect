# Blind hand-check of HeatDetect's classifications

There is no public list of what each satellite hotspot really was, so HeatDetect's own
accuracy figures only measure agreement with its rules. This check is the honest
alternative: people look at independent imagery for a sample of locations and say what
is there, **without seeing what HeatDetect decided**. It gives real precision per class,
the number judges will ask for.

## The files

| File | What it is | Who opens it |
|---|---|---|
| `2026-10-24-sample.csv` | 271 locations: place, date, imagery links, empty label columns | The checkers. Fill this in. |
| `2026-10-24-key.csv` | HeatDetect's answer for each row | **Nobody, until every row is labelled** |

Drawn from the live snapshot of 2026-10-24 16:28 UTC (36,147 locations), seed 20261024:
all 21 possible industrial fires, 100 persistent industrial sources, 100 probable
vegetation fires and 50 unclassified locations, in shuffled order. Re-drawing with the same
snapshot and seed gives the same rows (`python -m app.validation sample …`).

## How to check one row (about 2–3 minutes)

1. **`google_pin`**: the exact point. Switch to *Satellite* (Layers, bottom left) and look
   within about **400 m** of the pin. A VIIRS fire pixel is 375 m across, so the heat can
   come from anywhere in that radius.
2. **`google_satellite`**: the same area in satellite view, without the pin, if the pin
   hides detail.
3. **`worldview_fires`**: NASA Worldview on that date, with the satellites' fire detections
   (red dots) over true-colour imagery. Smoke plumes and burn scars show up here. Step a few
   days back and forward with the timeline arrows: the same spot burning every day suggests
   industry, a one-off suggests a passing fire.
4. **`worldview_thermal_night`**: VIIRS's thermal band at night. It can take 20–30 seconds to
   load. A spot that stays hot at night, away from towns, points to industry.

Then fill in:

- **`human_label`**, exactly one of:
  - `industrial`: a factory, plant, mine or quarry, kiln or brick works, refinery, power
    station, steel works, coal yard, oil or gas facility (including flares).
  - `vegetation`: farmland, forest, scrub or grassland, with no industrial site within
    about 400 m.
  - `other`: neither of these, for example a landfill or dump, a village or town, or a
    volcano.
  - `cannot_tell`: the imagery doesn't settle it (clouds, too coarse, a farm right next to
    a factory).
- **`sure`**: `yes` or `no`.
- **`checked_by`**: your name.
- **`notes`**: anything useful, such as "brick kiln", "sugar mill", or "crop stubble burning".

Rules:

- Decide from the imagery only. Don't look the spot up on the HeatDetect map, and don't open
  the key file.
- "Possible fire" isn't a label. The question is only **what kind of place** the heat came
  from.
- When in doubt, use `cannot_tell`. A wrong confident label is worse than an honest "can't tell".

**Hard cases, optional:** Landsat 8/9 thermal imagery (100 m) shows heat on the plant
itself. Sign in to [USGS EarthExplorer](https://earthexplorer.usgs.gov/) (free account),
search the coordinates and date, choose *Landsat 8-9 OLI/TIRS C2 L2*, and view the surface
temperature band. Most rows won't need this.

## Splitting the work

Split 271 rows across the team, for example V001–V090 to one person. About 10 to 12
person-hours in total. If you can, have a second person label 25 of the same rows without
seeing the first person's labels; how often the two agree shows how reliable the labels are.

## Scoring

When every row is labelled, from `backend/`:

```bash
python -m app.validation score --sample ../docs/validation/2026-10-24-sample.csv
```

It reports, for each class, how many places were checked, how many matched, the precision
with a 95% confidence interval, and what the unclassified places turned out to be. Rows not
yet labelled are counted as pending, not as errors. A mistyped label stops it with the row
number.
