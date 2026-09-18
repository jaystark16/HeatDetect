import L from "leaflet";
import { useEffect, useMemo, useState } from "react";
import {
  CircleMarker,
  LayersControl,
  MapContainer,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";

import {
  CLASS_STYLES,
  radiusFromFrp,
  resolvePalette,
  strokeWeightFromDays,
  type Palette,
} from "../classes";
import type { HotspotSummary } from "../types";

/** Fallback view when there is nothing to frame. */
const INDIA_CENTER: [number, number] = [21.5, 80.0];
const INITIAL_ZOOM = 5;

/** Keep every detection in view without zooming so far in that context is lost. */
function FitToData({ hotspots }: { hotspots: HotspotSummary[] }) {
  const map = useMap();

  // Fit only when the geographic extent actually changes. Refitting on every
  // filter change fights the user, who may have panned deliberately.
  const extentKey = useMemo(() => {
    if (hotspots.length === 0) return "";
    let minLat = 90;
    let maxLat = -90;
    let minLon = 180;
    let maxLon = -180;
    for (const h of hotspots) {
      minLat = Math.min(minLat, h.latitude);
      maxLat = Math.max(maxLat, h.latitude);
      minLon = Math.min(minLon, h.longitude);
      maxLon = Math.max(maxLon, h.longitude);
    }
    return [minLat, maxLat, minLon, maxLon].map((v) => v.toFixed(1)).join(",");
  }, [hotspots]);

  useEffect(() => {
    if (!extentKey) return;
    const [minLat, maxLat, minLon, maxLon] = extentKey.split(",").map(Number);
    map.fitBounds(L.latLngBounds([minLat, minLon], [maxLat, maxLon]), {
      padding: [40, 40],
      maxZoom: 8,
      // Non-animated deliberately. An animated fit that gets interrupted by a
      // container resize leaves a residual scale transform on the zoom pane —
      // observed as the whole map stuck at 0.25 scale, showing Central Asia
      // instead of India. A deterministic jump cannot be interrupted.
      animate: false,
    });
  }, [extentKey, map]);

  return null;
}

/**
 * Keep Leaflet's idea of its own size current.
 *
 * Leaflet measures its container once at init, so a grid column that settles
 * later (or a viewport change) leaves it stale and mis-projects every point.
 *
 * Debounced because the naive version caused the bug above: firing
 * `invalidateSize` on every ResizeObserver callback interrupts an in-flight
 * zoom and corrupts the transform. One call after the resize settles is both
 * correct and cheaper.
 */
function KeepSized() {
  const map = useMap();

  useEffect(() => {
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => map.invalidateSize({ animate: false }), 150);
    });
    observer.observe(map.getContainer());

    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [map]);

  return null;
}

interface Props {
  hotspots: HotspotSummary[];
  selectedId: string | null;
  onSelect: (hotspot: HotspotSummary) => void;
}

export default function MapView({ hotspots, selectedId, onSelect }: Props) {
  // Resolved once. Canvas rendering cannot read CSS classes, so Leaflet needs
  // concrete colour values (see classes.ts).
  const [palette, setPalette] = useState<Palette | null>(null);
  useEffect(() => setPalette(resolvePalette()), []);

  /**
   * Draw order matters at these volumes. With a few thousand overlapping marks,
   * whichever renders last wins the pixel — so the rare, operationally
   * important classes are drawn last and are never hidden under a mass of
   * routine vegetation fires.
   */
  const ordered = useMemo(() => {
    const priority: Record<string, number> = {
      unknown: 0,
      natural_fire: 1,
      persistent_industrial: 2,
      industrial_fire: 3,
    };
    return [...hotspots].sort(
      (a, b) => (priority[a.label] ?? 0) - (priority[b.label] ?? 0),
    );
  }, [hotspots]);

  return (
    <MapContainer
      center={INDIA_CENTER}
      zoom={INITIAL_ZOOM}
      style={{ height: "100%", width: "100%" }}
      // Essential, not an optimisation: a few thousand SVG paths makes panning
      // unusable. Canvas keeps interaction smooth at full data volume.
      preferCanvas
    >
      <KeepSized />
      <FitToData hotspots={hotspots} />

      {/* Both basemaps are key-free. Satellite is the default because seeing the
          ground around a hotspot is what makes an industrial site legible as
          one. CARTO's basemaps now require an API key and were dropped. */}
      <LayersControl position="topright">
        <LayersControl.BaseLayer checked name="Satellite">
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            attribution="Tiles &copy; Esri — Esri, Maxar, Earthstar Geographics"
            maxZoom={18}
          />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Street map">
          <TileLayer
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            maxZoom={19}
          />
        </LayersControl.BaseLayer>
      </LayersControl>

      {palette &&
        ordered.map((hotspot) => {
          const style = CLASS_STYLES[hotspot.label];
          const colours = palette[hotspot.label];
          const selected = hotspot.id === selectedId;
          const radius = radiusFromFrp(hotspot.frp_mw);

          return (
            <CircleMarker
              key={hotspot.id}
              center={[hotspot.latitude, hotspot.longitude]}
              radius={selected ? radius + 4 : radius}
              pathOptions={{
                color: selected ? "#ffffff" : colours.stroke,
                weight: selected ? 3 : strokeWeightFromDays(hotspot.distinct_days),
                fillColor: colours.fill,
                fillOpacity: style.fill === "hollow" ? 0.25 : 0.85,
              }}
              eventHandlers={{ click: () => onSelect(hotspot) }}
            >
              <Tooltip direction="top" offset={[0, -radius]}>
                <strong>{style.shortLabel}</strong>
                <br />
                {hotspot.frp_mw.toFixed(2)} MW
                <br />
                {hotspot.distinct_days} distinct{" "}
                {hotspot.distinct_days === 1 ? "day" : "days"} at this location
              </Tooltip>
            </CircleMarker>
          );
        })}
    </MapContainer>
  );
}
