# ADR 0001 — Use the open FIRMS regional archives, not the keyed API

**Status:** accepted, 2026-09-18

## Context

The team plan assumed a free FIRMS `MAP_KEY` would be obtained. The key had not
arrived, which blocked all data work.

## Decision

Ingest the regional CSV archives under
`https://firms.modaps.eosdis.nasa.gov/data/active_fire/`, which are openly
downloadable. Measured and confirmed: HTTP 200, no credentials, 15,190 detections over
the 7-day South Asia window.

## Consequences

**Good**
- The pipeline runs for anyone who clones the repository. No credential provisioning,
  no secret to leak, nothing to rotate.
- One HTTP request per product replaces per-area API calls.

**Bad**
- Fixed windows only (24h / 7d), so "baseline" means a short-term baseline. A long-term
  normal requires accumulating snapshots over time, which the pipeline supports by
  appending to the database on each run.
- Fixed regions only. South Asia is the smallest published region covering India, so
  neighbouring countries are included and must be filtered or labelled.

`FIRMS_MAP_KEY` remains supported in config. If a key arrives it enables arbitrary
bounding boxes and date ranges, but nothing depends on it.
