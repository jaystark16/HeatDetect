/** Mirrors `backend/app/schemas.py`. Keep the two in step. */

export type ThermalClass =
  | "industrial_fire"
  | "persistent_industrial"
  | "natural_fire"
  | "unknown";

export type LandCover =
  | "industrial"
  | "urban"
  | "forest"
  | "cropland"
  | "shrubland"
  | "barren"
  | "water"
  | "unknown";

export interface HotspotContext {
  nearest_facility_name: string | null;
  nearest_facility_type: string | null;
  distance_to_facility_m: number | null;
  land_cover: LandCover;
  detections_30d: number;
  baseline_frp_mw: number | null;
  frp_ratio: number | null;
}

export interface Classification {
  predicted_class: ThermalClass;
  label: string;
  confidence: number;
  evidence: string[];
  model_version: string;
}

export interface Hotspot {
  id: string;
  latitude: number;
  longitude: number;
  acquired_at: string;
  satellite: string;
  instrument: string;
  frp_mw: number;
  brightness_k: number;
  source_confidence: string;
  day_night: string;
  context: HotspotContext;
  classification: Classification | null;
}

export interface HotspotCollection {
  count: number;
  hotspots: Hotspot[];
  data_source: "sample" | "firms";
}

export interface Analytics {
  total_hotspots: number;
  by_class: Record<ThermalClass, number>;
  alerts: number;
  data_source: "sample" | "firms";
}

export interface Health {
  status: string;
  version: string;
  data_source: "sample" | "firms";
  database_connected: boolean;
  firms_key_configured: boolean;
}

export interface Filters {
  predictedClass: ThermalClass | "all";
  minConfidence: number;
  withinHours: number | "all";
}
