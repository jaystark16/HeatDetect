/**
 * Class presentation: colour, marker treatment and short label.
 *
 * Colours are categorical slots 1-3 of the validated palette, and the mapping to
 * classes is semantic rather than arbitrary — blue reads as routine/stable,
 * orange as hot/urgent, aqua as vegetation.
 *
 * `unknown` deliberately has NO hue. It renders as a hollow marker, because
 * "unclassified" is the absence of a value, not a fourth category. A grey fourth
 * slot was tried and rejected: it sits ΔE 2.0 from the aqua under deuteranopia,
 * i.e. indistinguishable for red-green colourblind viewers.
 *
 * Colour is never the only channel — every marker also differs in fill treatment,
 * and the legend plus the detail panel name the class in text.
 */

import type { ThermalClass } from "./types";

export interface ClassStyle {
  /** CSS custom property holding the hue, or null for the hollow treatment. */
  colorVar: string | null;
  shortLabel: string;
  /** Marker fill treatment — the secondary, non-colour encoding channel. */
  fill: "solid" | "hollow";
  /** Outer halo, reserved for the anomaly class so it reads first on the map. */
  halo: boolean;
}

export const CLASS_STYLES: Record<ThermalClass, ClassStyle> = {
  industrial_fire: {
    colorVar: "--class-industrial-fire",
    shortLabel: "Possible industrial fire",
    fill: "solid",
    halo: true,
  },
  persistent_industrial: {
    colorVar: "--class-persistent",
    shortLabel: "Persistent industrial source",
    fill: "solid",
    halo: false,
  },
  natural_fire: {
    colorVar: "--class-natural",
    shortLabel: "Probable vegetation fire",
    fill: "solid",
    halo: false,
  },
  unknown: {
    colorVar: null,
    shortLabel: "Unclassified",
    fill: "hollow",
    halo: false,
  },
};

export const CLASS_ORDER: ThermalClass[] = [
  "industrial_fire",
  "persistent_industrial",
  "natural_fire",
  "unknown",
];

/**
 * Leaflet class name for a marker.
 *
 * Styling goes through CSS rather than Leaflet's `color`/`fillColor` options on
 * purpose: those become SVG presentation attributes, which do not reliably
 * resolve `var()`. Driving fill and stroke from a stylesheet keeps the palette in
 * one place and lets the light/dark swap happen in CSS.
 */
export function markerClass(cls: ThermalClass, selected: boolean): string {
  return ["hd-marker", `hd-marker--${cls}`, selected ? "is-selected" : ""]
    .filter(Boolean)
    .join(" ");
}

/**
 * Marker radius from Fire Radiative Power.
 *
 * Square-root scaling so that *area* tracks magnitude — a linear radius would
 * exaggerate strong detections roughly quadratically. Clamped so a weak
 * detection stays clickable and a 500 MW event does not swallow the map.
 */
export function radiusFromFrp(frpMw: number): number {
  const r = 4 + Math.sqrt(Math.max(frpMw, 0)) * 1.1;
  return Math.min(Math.max(r, 5), 22);
}
