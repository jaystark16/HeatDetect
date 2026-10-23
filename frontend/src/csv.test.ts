import { describe, expect, it } from "vitest";

import { locationsCsv } from "./csv";
import type { MapMark } from "./types";

const mark = (over: Partial<MapMark>): MapMark => ({
  id: "d1",
  cell_id: "1760:8320",
  latitude: 17.60913,
  longitude: 83.20387,
  label: "persistent_industrial",
  distinct_days: 38,
  frp_mw: 9.96,
  observation_count: 120,
  last_seen: "2026-10-23T06:01:00Z",
  region: "Andhra Pradesh",
  country: "India",
  region_alternatives: [],
  ...over,
});

describe("locations as CSV", () => {
  it("writes one row per place, from the data's own values", () => {
    const lines = locationsCsv([mark({})]).trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "latitude,longitude,class,state_or_ut,country,near_other_region,distinct_days,peak_frp_mw,satellite_passes,last_seen_utc,google_maps",
    );
    expect(lines[1]).toBe(
      "17.60913,83.20387,Persistent industrial source,Andhra Pradesh,India,,38,9.96,120,2026-10-23T06:01:00Z," +
        "https://www.google.com/maps/search/?api=1&query=17.60913%2C83.20387",
    );
  });

  it("quotes a value that holds a comma or a quote", () => {
    const line = locationsCsv([mark({ region: 'Dadra, "Daman"', region_alternatives: ["Gujarat", "Maharashtra"] })])
      .split("\r\n")[1];
    expect(line).toContain('"Dadra, ""Daman"""');
    expect(line).toContain(",Gujarat; Maharashtra,");
  });

  it("leaves the region empty outside every boundary, rather than guessing", () => {
    const line = locationsCsv([mark({ region: null, country: null })]).split("\r\n")[1];
    expect(line.split(",").slice(3, 5)).toEqual(["", ""]);
  });
});
