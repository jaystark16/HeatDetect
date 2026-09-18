# Feed characterisation, 2026-09-18

Measurements taken directly against live sources before designing the classifier.
Reproduce with `backend/.venv/Scripts/python -m app.pipeline probe`.

Everything below is measured output, not estimation.

## 1. Open access confirmed

The `/data/active_fire/` regional archives return HTTP 200 with no credentials:

| Product | Platform | 24h rows | 7d rows |
|---|---|---|---|
| `SUOMI_VIIRS_C2_South_Asia` | Suomi NPP | 712 | 4,764 |
| `J1_VIIRS_C2_South_Asia` | NOAA-20 | 699 | 4,985 |
| `J2_VIIRS_C2_South_Asia` | NOAA-21 | 589 | 4,951 |
| `MODIS_C6_1_South_Asia` | Terra/Aqua | 98 | 490 |

7-day total: **15,190** detections; **7,279** inside the India bounding box.
Parser acceptance was 100% (0 rejects) on every file.

Only the `/api/` endpoints require a MAP_KEY. The project therefore does not need one.

## 2. Persistence is present and measurable

Aggregating the 7-day India subset onto a 0.01° (~1 km) grid gives 2,695 active cells:

| Detected on ≥ N distinct days | Cells |
|---|---|
| 2 | 555 |
| 3 | 340 |
| 4 | 220 |
| 5 | 146 |
| 6 | 76 |
| 7 | 26 |

A persistence signal clearly exists. It is not an artefact of a single overpass.

## 3. What the persistent sources actually are

The most persistent cells cluster in recognisable places:

| Cell centre | Days | Region |
|---|---|---|
| 23.67–23.81 N, 86.20–86.41 E | 7 | **Jharia coalfield / Dhanbad** — long-burning coal-seam fires |
| 24.195 N, 82.715 E | 7 | **Singrauli** coal and thermal-power belt |
| 22.36–22.38 N, 87.28–87.31 E | 7 | **Kharagpur–Haldia** industrial belt |
| 23.565 N, 87.085 E | 7 | Durgapur–Raniganj industrial belt |
| 20.795 N, 85.255 E | 8 | Odisha industrial area |

Of the persistent cells whose surroundings could be queried before Overpass
rate-limited, **6 of 6 had mapped industrial land use within 5 km** (closest: 502 m).

## 4. The finding that changes scope

**Refinery gas flares are largely absent from active-fire products.**

Zero detections landed within 5 km of either the Reliance Jamnagar or Vadinar refinery
in the 24-hour window, despite both being confirmed present in OSM with named polygons.

This is consistent with the published literature: VIIRS **Nightfire** (VNF) exists as a
separate product precisely because active-fire algorithms are tuned for biomass burning
and handle small, very hot, persistent sources differently. VNF full data requires a
licence application to the Earth Observation Group, so it is not available here.

**Consequence for the product:** the system can credibly detect and monitor
coal-seam fires, coal-handling areas, power stations and industrial belts. It should
**not** claim to monitor refinery flaring. The UI and pitch must reflect what the feed
actually contains.

## 5. Magnitudes are small

24-hour FRP distribution across all products:

```
min 0.15   p50 1.63   p95 9.62   p99 17.72   max 57.83   (MW)
```

Any threshold written on the assumption of 100+ MW industrial fires would never fire.
The previously committed sample data claimed a 142 MW event and 18 MW "baseline"
flares — both unrepresentative. That data has been removed.

## 6. Dual-band discriminator

VIIRS `bright_ti4 − bright_ti5`, n = 2,000 (24h):

```
min 10.0   p10 11.9   median 23.3   p90 38.8   max 77.2   (K)
```

Only 10 detections exceeded 60 K. The signal is real but weak in this window, so it is
used as **one contributing feature**, never as a sole discriminator.

## 7. Operational constraint: Overpass

6 of 12 per-point Overpass queries failed with HTTP errors under light sequential load.
Per-hotspot querying is not viable. The pipeline bulk-prefetches tiles into the
database and performs distance joins locally.

## 8. Correction to record

The "India bounding box" `68,6,98,37.5` also covers parts of Pakistan, Nepal,
Bangladesh and Sri Lanka. One persistent cell found at 33.295 N, 71.185 E resolved to
the *Banda Dawood Shah* oil facility in **Pakistan**. The bbox is a bounding box, not a
national boundary, and is labelled as such in the UI.
