import { Fragment, useEffect } from "react";
import {
  CircleMarker,
  LayersControl,
  MapContainer,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import L from "leaflet";

import { CLASS_STYLES, markerClass, radiusFromFrp } from "../classes";
import type { Hotspot } from "../types";

/** Fallback view when there is nothing to frame: India, industrial belts included. */
const INDIA_CENTER: [number, number] = [21.5, 80.0];
const INITIAL_ZOOM = 5;

/**
 * Keep every detection in view.
 *
 * A fixed centre/zoom cut the Gujarat refineries off the western edge at narrow
 * viewport widths, which silently hid two of the most important hotspots.
 */
function FitToHotspots({ hotspots }: { hotspots: Hotspot[] }) {
  const map = useMap();

  useEffect(() => {
    if (hotspots.length === 0) return;
    const bounds = L.latLngBounds(
      hotspots.map((h) => [h.latitude, h.longitude] as [number, number]),
    );
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 7 });
  }, [hotspots, map]);

  return null;
}

/** Leaflet sizes itself on init; a grid column that settles later leaves it stale. */
function KeepSized() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);

  return null;
}

interface Props {
  hotspots: Hotspot[];
  selectedId: string | null;
  onSelect: (hotspot: Hotspot) => void;
}

export default function MapView({ hotspots, selectedId, onSelect }: Props) {
  return (
    <MapContainer
      center={INDIA_CENTER}
      zoom={INITIAL_ZOOM}
      style={{ height: "100%", width: "100%" }}
    >
      <KeepSized />
      <FitToHotspots hotspots={hotspots} />

      {/* Both basemaps are key-free. Satellite is the default because the problem
          statement's demo script calls for showing satellite context around a
          hotspot, and imagery makes an industrial site legible as one. */}
      <LayersControl position="topright">
        <LayersControl.BaseLayer checked name="Satellite">
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            attribution="Tiles &copy; Esri — Esri, Maxar, Earthstar Geographics"
            maxZoom={19}
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

      {hotspots.map((hotspot) => {
        const cls = hotspot.classification?.predicted_class ?? "unknown";
        const style = CLASS_STYLES[cls];
        const radius = radiusFromFrp(hotspot.frp_mw);
        const position: [number, number] = [hotspot.latitude, hotspot.longitude];

        return (
          <Fragment key={hotspot.id}>
            {/* Halo sits under the mark so the anomaly class reads first. */}
            {style.halo && (
              <CircleMarker
                center={position}
                radius={radius * 2.1}
                className="hd-halo"
                interactive={false}
              />
            )}

            <CircleMarker
              center={position}
              radius={radius}
              className={markerClass(cls, hotspot.id === selectedId)}
              eventHandlers={{ click: () => onSelect(hotspot) }}
            >
              {/* Hover layer: identity and magnitude without needing a click. */}
              <Tooltip direction="top" offset={[0, -radius]}>
                <strong>{style.shortLabel}</strong>
                <br />
                {hotspot.frp_mw.toFixed(1)} MW &middot;{" "}
                {hotspot.context.nearest_facility_name ?? "no facility nearby"}
              </Tooltip>
            </CircleMarker>
          </Fragment>
        );
      })}
    </MapContainer>
  );
}
