import { describe, expect, it } from "vitest";

import { googleMapsUrl, plainCoordinates } from "./maps";

describe("Google Maps links", () => {
  it("pins the exact coordinates in Google's documented Maps URLs format", () => {
    expect(googleMapsUrl(17.60957, 83.20412)).toBe(
      "https://www.google.com/maps/search/?api=1&query=17.60957%2C83.20412",
    );
  });

  it("keeps the sign for southern and western coordinates", () => {
    expect(googleMapsUrl(-33.8688, -151.2093)).toBe(
      "https://www.google.com/maps/search/?api=1&query=-33.86880%2C-151.20930",
    );
  });

  it("draws no link for coordinates that cannot be a place", () => {
    expect(googleMapsUrl(91, 10)).toBeNull();
    expect(googleMapsUrl(10, 181)).toBeNull();
    expect(googleMapsUrl(Number.NaN, 10)).toBeNull();
  });

  it("writes coordinates in the plain form map searches accept", () => {
    expect(plainCoordinates(17.608, 83.2)).toBe("17.60800, 83.20000");
  });
});
