/**
 * Links that open a location in Google Maps.
 *
 * Built only from coordinates in the data, never from model text, in Google's
 * documented Maps URLs format (developers.google.com/maps/documentation/urls):
 * a search for "latitude,longitude" drops a pin on exactly that point. Five
 * decimals is the precision FIRMS reports, about 1 m.
 */

import type { MapMark } from "./types";

function valid(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

/**
 * "Odisha", "Nepal", or "Odisha (near West Bengal)" when another region is
 * within 1.5 km. Null when the location is outside every boundary or the data
 * predates regions; the page then says nothing rather than guess.
 */
export function placeLabel(m: Pick<MapMark, "region" | "country" | "region_alternatives">): string | null {
  const where = m.region ?? m.country;
  if (!where) return null;
  return m.region_alternatives.length ? `${where} (near ${m.region_alternatives.join(", ")})` : where;
}

/** "17.60957, 83.20412": the form Google Maps accepts when pasted. */
export function plainCoordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

/** Null for coordinates that cannot be a place, so no link is drawn at all. */
export function googleMapsUrl(latitude: number, longitude: number): string | null {
  if (!valid(latitude, longitude)) return null;
  const query = encodeURIComponent(plainCoordinates(latitude, longitude).replace(" ", ""));
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}
