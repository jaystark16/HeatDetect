/**
 * Class presentation: colour, marker treatment, label.
 *
 * Colours are categorical slots 1-3 of a palette validated for colourblind
 * separation across all pairs (worst CVD dE 9.4 dark / 9.2 light; normal-vision
 * dE 20.9 / 24.0). The class-to-hue mapping is semantic, not arbitrary: blue
 * reads as routine and stable, orange as hot and urgent, aqua as vegetation.
 *
 * `unknown` has **no hue**. It renders hollow, because "not classified" is the
 * absence of a value rather than a fourth category. A grey fourth slot was
 * tested and rejected — it measured dE 2.0 from the aqua under deuteranopia,
 * i.e. indistinguishable for red-green colourblind viewers.
 *
 * Colour is never the only channel: markers differ in fill treatment, the
 * legend names every class in text, and the detail panel states it in words.
 */

import type { ThermalClass } from "./types";

export interface ClassStyle {
  cssVar: string | null;
  shortLabel: string;
  fill: "solid" | "hollow";
}

export const CLASS_STYLES: Record<ThermalClass, ClassStyle> = {
  industrial_fire: {
    cssVar: "--class-industrial-fire",
    shortLabel: "Possible industrial fire",
    fill: "solid",
  },
  persistent_industrial: {
    cssVar: "--class-persistent",
    shortLabel: "Persistent industrial source",
    fill: "solid",
  },
  natural_fire: {
    cssVar: "--class-natural",
    shortLabel: "Probable vegetation fire",
    fill: "solid",
  },
  unknown: {
    cssVar: null,
    shortLabel: "Not classified",
    fill: "hollow",
  },
};

export const CLASS_ORDER: ThermalClass[] = [
  "industrial_fire",
  "persistent_industrial",
  "natural_fire",
  "unknown",
];

export type Palette = Record<ThermalClass, { stroke: string; fill: string }>;

/**
 * Resolve the palette to concrete colours.
 *
 * Leaflet is run with `preferCanvas`, which is necessary at these data volumes
 * — a few thousand SVG paths makes panning unusable. Canvas rendering cannot
 * use CSS classes, so colours have to be read out of the custom properties once
 * and handed to Leaflet as values. The stylesheet stays the single source of
 * truth; this is the only place that reads it.
 */
export function resolvePalette(root: HTMLElement = document.documentElement): Palette {
  const computed = getComputedStyle(root);
  const read = (name: string, fallback: string) =>
    computed.getPropertyValue(name).trim() || fallback;

  const surface = read("--surface-0", "#0d0d0d");
  const muted = read("--ink-muted", "#898781");

  const solid = (cssVar: string, fallback: string) => ({
    stroke: surface,
    fill: read(cssVar, fallback),
  });

  return {
    industrial_fire: solid("--class-industrial-fire", "#d95926"),
    persistent_industrial: solid("--class-persistent", "#3987e5"),
    natural_fire: solid("--class-natural", "#199e70"),
    // Hollow: stroked in muted ink with a near-transparent fill.
    unknown: { stroke: muted, fill: "rgba(137,135,129,0.15)" },
  };
}

/**
 * Marker radius from Fire Radiative Power.
 *
 * Square-root scaled so *area* tracks magnitude; a linear radius would
 * exaggerate strong detections roughly quadratically. Tuned to the measured
 * distribution — real FRP here is median ~1.6 MW and p99 ~18 MW, so the useful
 * range is small numbers, not the hundreds an earlier draft assumed.
 */
export function radiusFromFrp(frpMw: number): number {
  const r = 3 + Math.sqrt(Math.max(frpMw, 0)) * 1.6;
  return Math.min(Math.max(r, 3.5), 18);
}

/**
 * Extra weight for recurring locations.
 *
 * Persistence is the single most informative signal this system has, so it is
 * encoded visually rather than left buried in the detail panel.
 */
export function strokeWeightFromDays(distinctDays: number): number {
  if (distinctDays >= 5) return 2.5;
  if (distinctDays >= 3) return 1.75;
  return 1;
}
