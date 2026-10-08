# HeatDetect — glossary

| Term | Meaning here |
|---|---|
| **SIH** | Smart India Hackathon. This is the 2026 edition, problem SIH26162 |
| **NTRO** | National Technical Research Organisation, the body that set the problem |
| **FIRMS** | NASA's Fire Information for Resource Management System, our detection source |
| **MAP_KEY** | Free FIRMS API key. Only the `/api/` endpoints need it; `/data/active_fire/` archives don't |
| **VIIRS** | Satellite sensor (Suomi NPP, NOAA-20, NOAA-21), 375 m active-fire product |
| **MODIS** | Older sensor, 1 km active-fire product (Collection 6.1) |
| **VIIRS Nightfire** | Separate product built for gas flares. Its full data needs a licence, so we don't use it |
| **Detection / hotspot** | One row from FIRMS: one pixel flagged hot on one satellite pass |
| **Thermal anomaly** | Evidence of unusual heat. Never treated as proof of a fire or accident |
| **FRP** | Fire Radiative Power, in MW. Real values here are small (median ~1.6 MW) |
| **Brightness (K)** | Brightness temperature in kelvin from the sensor channels |
| **Confidence tier** | FIRMS's own `low` / `nominal` / `high` detection-quality field, not our confidence |
| **Location / cell** | A ~1 km grid cell (0.01°). The map draws one mark per cell, not per detection |
| **Persistence** | How many distinct days a cell is seen, relative to the ingestion window |
| **Baseline** | A cell's typical FRP over its history (median, p90) |
| **Deviation ratio / excursion** | How far an observation sits above its cell's baseline; an incident shows as an excursion |
| **Persistent industrial** | Recurring heat near mapped industry with a stable baseline, e.g. coal-seam fires or steel plants |
| **Industrial fire** | An excursion from baseline at an industrial location. Rare, and only the rules report it |
| **Natural fire** | Vegetation/biomass burning far from mapped industry |
| **Unknown** | Not enough evidence, or the model abstained or was suppressed |
| **not_surveyed** | We have no OSM survey for the area. This is *not* "no industry nearby" |
| **Rule verdict** | A class decided by thresholds over history. It carries no probability |
| **Abstain** | The model declines to classify because its top probability is below the floor |
| **Suppression** | The model's output for a class with held-out precision < 0.5 is replaced with `unknown` |
| **kind** | Record provenance tag: `observed`, `derived` or `synthetic` |
| **dataset_id** | Which catalogued source (`app/datasets.py`) a record came from |
| **Overpass** | The OpenStreetMap query API. Rate-limited, so we use a committed tile cache |
| **ODbL** | Open Database Licence, which covers OSM data |
| **Spatial hold-out** | Train/test split by 1° geographic block, so one site is never in both |
| **Leakage** | When a feature encodes the label rule, e.g. distance to industry for `natural_fire` |
| **Ablation** | Retraining with feature groups removed to see what the model actually relies on |
| **Briefing** | The numbered list of computed facts the Ask tab's language model is allowed to cite |
| **Citation gate** | `verify.ts`. It withholds any assistant sentence its cited facts don't support |
| **Analysis area** | bbox 68,6,98,37.5. It covers India and parts of its neighbours, so it is never called "India" |
