import {
  AttributionControl,
  GlobeControl,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type ExpressionSpecification,
  type GeoJSONSource,
  type StyleSpecification,
} from "maplibre-gl";
// MapLibre builds its worker URL at runtime, which a bundler cannot see, so the
// production build shipped without it. Importing it here makes Vite bundle it.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { FeatureCollection } from "geojson";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  CLASS_STYLES,
  radiusFromFrp,
  resolvePalette,
  STROKE_OPACITY,
  strokeWeightFromDays,
} from "../classes";
import type { MapMark } from "../types";

setWorkerUrl(workerUrl);

/** Where the globe faces before the data arrives. */
const INDIA: [number, number] = [80.0, 21.5];
const GLOBE_ZOOM = 1.6;

/** A place the user asked to be taken to, with a nonce so repeat picks re-fire. */
export interface FocusTarget {
  latitude: number;
  longitude: number;
  nonce: number;
  /** Defaults to street level, which suits a searched facility. */
  zoom?: number;
}

interface Props {
  hotspots: MapMark[];
  selectedId: string | null;
  onSelect: (mark: MapMark) => void;
  focus: FocusTarget | null;
}

type Basemap = "satellite" | "street";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";

/**
 * A globe, not a flat map.
 *
 * Leaflet could only draw Web Mercator, so zooming out tiled the world
 * sideways into an endless strip with every Indian mark piled into one blob.
 * MapLibre renders a real globe when zoomed out and flattens to an ordinary
 * map as you zoom in. All three tile sources are key-free; CARTO's now require
 * a key and were dropped earlier.
 */
const STYLE: StyleSpecification = {
  version: 8,
  projection: { type: "globe" },
  // Atmosphere only while the globe is visible; it fades out as the view
  // flattens, where a halo would just tint the edges of the map.
  sky: {
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 4, 0.8, 7, 0],
  },
  sources: {
    satellite: {
      type: "raster",
      tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
      tileSize: 256,
      maxzoom: 18,
      attribution: "Tiles &copy; Esri — Esri, Maxar, Earthstar Geographics",
    },
    street: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
    labels: {
      type: "raster",
      tiles: [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`],
      tileSize: 256,
      maxzoom: 18,
      attribution: "Labels &copy; Esri",
    },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#0a0a0b" } },
    { id: "satellite", type: "raster", source: "satellite" },
    { id: "street", type: "raster", source: "street", layout: { visibility: "none" } },
    { id: "labels", type: "raster", source: "labels", paint: { "raster-opacity": 0.75 } },
  ],
};

/**
 * Draw order, as a sort key the GPU honours.
 *
 * With thousands of overlapping marks whichever paints last wins the pixel, so
 * the rare, operationally important classes go on top and are never buried
 * under routine vegetation fires. Leaflet painted in mount order instead, which
 * a filter round-trip scrambled; a sort key cannot be scrambled.
 */
const PRIORITY: Record<MapMark["label"], number> = {
  unknown: 0,
  natural_fire: 1,
  persistent_industrial: 2,
  industrial_fire: 3,
};

/**
 * Marks shrink when zoomed out to the globe, where full-size circles would
 * merge India into one disc. Relative size — area tracking FRP — is preserved
 * at every zoom, which is what the legend promises.
 */
function radiusByZoom(extra = 0): ExpressionSpecification {
  const at = (scale: number): ExpressionSpecification => [
    "+",
    ["*", ["get", "radius"], scale],
    extra,
  ];
  // A zoom expression must be the outermost one, so the selection ring's
  // extra pixels go inside each stop rather than around the whole thing.
  return ["interpolate", ["linear"], ["zoom"], 1, at(0.3), 4, at(0.75), 6, at(1)];
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export default function MapView({ hotspots, selectedId, onSelect, focus }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [basemap, setBasemap] = useState<Basemap>("satellite");
  const [labels, setLabels] = useState(true);

  // Map event handlers are registered once, so they read these through refs
  // rather than capturing whatever was current at mount.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const byId = useRef(new Map<string, MapMark>());

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new MapLibreMap({
      container,
      style: STYLE,
      center: INDIA,
      zoom: GLOBE_ZOOM,
      attributionControl: false,
      // One Earth. In flat mode MapLibre would otherwise repeat the world
      // sideways when zoomed out — the endless strip this replaced.
      renderWorldCopies: false,
      // Far enough out to see the whole globe, not so far it shrinks to a dot.
      minZoom: 1,
      // Tilting adds nothing to point data and makes marks harder to compare.
      maxPitch: 0,
      dragRotate: false,
      touchPitch: false,
    });
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new GlobeControl(), "top-right");
    map.addControl(new AttributionControl({ compact: true }), "bottom-right");

    map.on("load", () => {
      map.addSource("locations", { type: "geojson", data: EMPTY });
      map.addLayer({
        id: "marks",
        type: "circle",
        source: "locations",
        layout: { "circle-sort-key": ["get", "priority"] },
        paint: {
          "circle-radius": radiusByZoom(),
          "circle-color": ["get", "fill"],
          "circle-opacity": ["get", "fillOpacity"],
          "circle-stroke-color": ["get", "strokeColor"],
          "circle-stroke-width": ["get", "stroke"],
          "circle-stroke-opacity": ["get", "strokeOpacity"],
          "circle-pitch-alignment": "map",
        },
      });
      map.addLayer({
        id: "selected",
        type: "circle",
        source: "locations",
        filter: ["==", ["get", "id"], ""],
        paint: {
          "circle-radius": radiusByZoom(4),
          "circle-color": ["get", "fill"],
          "circle-opacity": 0.95,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3,
          "circle-pitch-alignment": "map",
        },
      });
      setReady(true);
    });

    // Hover readout. Built with textContent, never HTML, so nothing in the
    // data can inject markup.
    const tip = new Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 12,
      className: "map-tip",
    });
    map.on("mousemove", "marks", (event) => {
      const feature = event.features?.[0];
      const mark = feature && byId.current.get(String(feature.properties?.id));
      if (!mark) return;
      map.getCanvas().style.cursor = "pointer";

      const body = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = CLASS_STYLES[mark.label].shortLabel;
      const frp = document.createElement("div");
      frp.textContent = `${mark.frp_mw.toFixed(2)} MW peak`;
      const days = document.createElement("div");
      days.textContent = `${mark.distinct_days} distinct ${
        mark.distinct_days === 1 ? "day" : "days"
      } at this location`;
      body.append(title, frp, days);

      tip.setLngLat([mark.longitude, mark.latitude]).setDOMContent(body).addTo(map);
    });
    map.on("mouseleave", "marks", () => {
      map.getCanvas().style.cursor = "";
      tip.remove();
    });
    map.on("click", "marks", (event) => {
      const feature = event.features?.[0];
      const mark = feature && byId.current.get(String(feature.properties?.id));
      if (mark) onSelectRef.current(mark);
    });

    // The container is a grid cell that settles after mount and changes with
    // the viewport; MapLibre only watches the window by itself.
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container);

    mapRef.current = map;
    return () => {
      observer.disconnect();
      tip.remove();
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  // Data. Colours are resolved from the stylesheet once and baked into each
  // feature, because WebGL cannot read CSS custom properties (see classes.ts).
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;

    const palette = resolvePalette();
    byId.current = new Map(hotspots.map((h) => [h.id, h]));

    const data: FeatureCollection = {
      type: "FeatureCollection",
      features: hotspots.map((h) => {
        const unknown = h.label === "unknown";
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [h.longitude, h.latitude] },
          properties: {
            id: h.id,
            priority: PRIORITY[h.label] ?? 0,
            radius: radiusFromFrp(h.frp_mw, h.label),
            fill: palette[h.label].fill,
            fillOpacity: CLASS_STYLES[h.label].fill === "hollow" ? 0.12 : 0.85,
            strokeColor: palette[h.label].stroke,
            stroke: unknown ? 1 : strokeWeightFromDays(h.distinct_days),
            strokeOpacity: unknown ? 0.4 : STROKE_OPACITY,
          },
        };
      }),
    };
    (map.getSource("locations") as GeoJSONSource | undefined)?.setData(data);
  }, [ready, hotspots]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setFilter("selected", ["==", ["get", "id"], selectedId ?? ""]);
  }, [ready, selectedId]);

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

  const fitted = useRef(false);
  // Once the user has searched, refitting would undo their navigation.
  const suspended = focus !== null;

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !extentKey || suspended) return;
    const [minLat, maxLat, minLon, maxLon] = extentKey.split(",").map(Number);
    // One bad row must not take the map down.
    if (![minLat, maxLat, minLon, maxLon].every(Number.isFinite)) return;

    map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      {
        padding: 40,
        maxZoom: 8,
        // The first fit flies in from the globe, which shows where the data
        // sits on Earth; later refits are instant so filtering stays snappy.
        duration: fitted.current ? 0 : 1800,
      },
    );
    fitted.current = true;
  }, [ready, extentKey, suspended]);

  // Keyed on the nonce, so picking the same result twice still moves the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !focus) return;
    map.flyTo({
      center: [focus.longitude, focus.latitude],
      zoom: focus.zoom ?? 11,
      duration: 900,
    });
  }, [ready, focus?.nonce, focus?.latitude, focus?.longitude, focus?.zoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setLayoutProperty("satellite", "visibility", basemap === "satellite" ? "visible" : "none");
    map.setLayoutProperty("street", "visibility", basemap === "street" ? "visible" : "none");
    // OSM tiles carry their own names; Esri's labels are for imagery.
    map.setLayoutProperty(
      "labels",
      "visibility",
      labels && basemap === "satellite" ? "visible" : "none",
    );
  }, [ready, basemap, labels]);

  return (
    <div className="mapview">
      <div ref={containerRef} className="mapview__canvas" />
      <div className="map-switch" role="group" aria-label="Basemap">
        <button
          type="button"
          className={basemap === "satellite" ? "is-active" : ""}
          aria-pressed={basemap === "satellite"}
          onClick={() => setBasemap("satellite")}
        >
          Satellite
        </button>
        <button
          type="button"
          className={basemap === "street" ? "is-active" : ""}
          aria-pressed={basemap === "street"}
          onClick={() => setBasemap("street")}
        >
          Street
        </button>
        {basemap === "satellite" && (
          <button
            type="button"
            className={labels ? "is-active" : ""}
            aria-pressed={labels}
            onClick={() => setLabels((v) => !v)}
          >
            Labels
          </button>
        )}
      </div>
    </div>
  );
}
