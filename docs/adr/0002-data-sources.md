# ADR 0002 — Data sources, and what we deliberately do not use

**Status:** accepted, 2026-09-18

## Context

The team plan calls for thermal detections, industrial infrastructure, and
land-cover data. Each has several possible sources with very different access
costs.

## Decisions

### Thermal detections: NASA FIRMS regional archives

See [ADR 0001](0001-open-firms-archives.md). Open, no key, four products.

### Industrial infrastructure: OpenStreetMap via Overpass

Free and openly licensed (ODbL), and it contains named industrial features —
verified: Overpass returned *Reliance Refinery*, *Essar Refinery*, *Belpahar Coal
Mine* and thousands of unnamed `landuse=industrial` polygons.

Overpass is a **donated community service that throttles by client**. Measured:
an identical query shape returned 89 KiB in 24 s for one tile, then returned
HTTP 504 for a strictly *smaller* tile minutes later. So:

- Only tiles that contain a detection are ever queried.
- Results are cached to disk, and **the cache is committed** — a fresh clone, CI
  and a live demo need no Overpass access at all.
- Tiles are fetched highest-value first, so partial coverage is still useful.
- Coverage is recorded per cell; an unfetched tile reports `not_surveyed`.

### Land cover: OSM land-use polygons, by centroid proximity

**This is an approximation and is labelled as one everywhere it appears.**

The correct implementation is a point-in-polygon test against a raster or vector
land-cover product. Two options were measured and rejected:

| Option | Why not |
|---|---|
| Overpass with full geometry (`out geom`) | **6.1 MiB for one 1° tile** (~116k nodes), extrapolating to ~1.8 GiB for India. Infeasible, and abusive to a donated service. |
| Broad landuse centroid query | Timed out (HTTP 504). `residential`/`commercial`/`retail` are numerically dominant and add little discriminating power over "distance to nearest industrial feature". |
| ESA WorldCover 10 m | Materially better and genuinely the right answer — but requires registered access, which blocks anyone cloning the repository. |

So land cover is the nearest mapped parcel centroid within 2 km. Beyond that it
reports `unknown`. The UI states "approximate — closest parcel centroid within
2 km, not a containment test" wherever land cover is shown, and the dataset
catalogue records the same limitation.

### VIIRS Nightfire: not used

VNF is the authoritative gas-flare product and would be the ideal label source.
Full CSV access requires a licence application to the Earth Observation Group.
Not available, so not used — and its absence is why this project has no verified
ground truth. See [ADR 0004](0004-labelling-by-information-asymmetry.md).

## Consequence for product claims

Because active-fire products under-detect small, very hot, persistent sources,
the system can credibly monitor coal-seam fires, coal handling, mining areas and
power stations, but **not refinery flaring**. Measured: zero detections within
5 km of Jamnagar or Vadinar in a 24-hour window. The UI and README claim only
what the feed supports.
