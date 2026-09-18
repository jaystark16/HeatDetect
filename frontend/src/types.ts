/**
 * Mirrors `backend/app/schemas.py`. Change both together.
 *
 * The three-way split is intentional and load-bearing: `Observation` is what a
 * satellite measured, `Persistence` is what we computed, `Classification` is
 * what we inferred. They are separate types so a component cannot accidentally
 * present an inference as a measurement.
 */

export type ThermalClass =
  | "industrial_fire"
  | "persistent_industrial"
  | "natural_fire"
  | "unknown";

export type EvidenceKind = "observed" | "derived" | "absent";

export type Coverage = "surveyed" | "not_surveyed";

/** Measured by an instrument, published by NASA, unmodified by us. */
export interface Observation {
  instrument: string;
  satellite: string;
  brightness_k: number;
  brightness_long_k: number;
  dual_band_delta_k: number;
  frp_mw: number;
  confidence_raw: string;
  confidence_tier: string;
  day_night: "D" | "N";
  scan: number;
  track: number;
  dataset_id: string;
}

/** Computed by this system from the ingested window. */
export interface Persistence {
  observation_count: number;
  distinct_days: number;
  window_days: number;
  median_frp_mw: number;
  p90_frp_mw: number;
  mad_frp_mw: number;
  median_dual_band_k: number;
  night_fraction: number;
  first_seen: string;
  last_seen: string;
  baseline_usable: boolean;
  /** Null when the baseline is too thin for a ratio to mean anything. */
  deviation_ratio: number | null;
}

export interface SpatialContext {
  nearest_facility_name: string | null;
  nearest_facility_category: string | null;
  distance_to_facility_m: number | null;
  facilities_within_5km: number;
  land_cover: string;
  /** `not_surveyed` is a gap in our coverage, NOT evidence of no industry. */
  coverage: Coverage;
}

export interface EvidenceItem {
  statement: string;
  kind: EvidenceKind;
  values: Record<string, unknown>;
  dataset_id: string | null;
}

export interface Classification {
  label: ThermalClass;
  display_label: string;
  /** `rule` = deterministic thresholds over history; `model` = single-observation. */
  source: "rule" | "model";
  rule_version: string | null;
  model_version: string | null;
  /** Null for rule decisions — a threshold has no probability. */
  confidence: number | null;
  abstained: boolean;
  criteria: Array<Record<string, unknown>>;
}

export interface HotspotSummary {
  id: string;
  latitude: number;
  longitude: number;
  cell_id: string;
  acquired_at: string;
  frp_mw: number;
  confidence_tier: string;
  label: ThermalClass;
  distinct_days: number;
}

export interface HotspotDetail {
  id: string;
  latitude: number;
  longitude: number;
  cell_id: string;
  acquired_at: string;
  observation: Observation;
  persistence: Persistence | null;
  context: SpatialContext;
  classification: Classification;
  evidence: EvidenceItem[];
  caution: string;
}

export interface Provenance {
  data_source: "firms_open_archive" | "none";
  generated_at: string;
  newest_detection_at: string | null;
  oldest_detection_at: string | null;
  age_of_newest_hours: number | null;
  is_live: boolean;
  stale: boolean;
  surveyed_cells: number;
  unsurveyed_cells: number;
  coverage_note: string;
}

export interface HotspotCollection {
  count: number;
  total_matching: number;
  limit: number;
  offset: number;
  hotspots: HotspotSummary[];
  provenance: Provenance;
}

export interface ClassCount {
  label: ThermalClass;
  display_label: string;
  cells: number;
  detections: number;
}

export interface Analytics {
  total_detections: number;
  total_cells: number;
  by_class: ClassCount[];
  flagged_for_investigation: number;
  persistent_cells: number;
  provenance: Provenance;
}

export interface DatasetInfo {
  id: string;
  name: string;
  provider: string;
  kind: "observed" | "derived" | "synthetic";
  source_url: string;
  licence: string;
  update_frequency: string;
  spatial_resolution: string | null;
  fields: string[];
  limitations: string[];
  requires_credentials: boolean;
  notes: string | null;
  citation: string | null;
}

export interface ModelInfo {
  trained: boolean;
  model_version: string | null;
  model_type: string | null;
  label_rule_version: string;
  trained_at: string | null;
  feature_names: string[];
  metrics: Record<string, unknown> | null;
  caveat: string;
}

export interface Filters {
  label: ThermalClass | "all";
  minFrpMw: number;
  minDistinctDays: number;
  withinHours: number | "all";
}

/** How the currently displayed data was obtained. Drives the provenance chip. */
export type DataMode = "live" | "historical" | "cached_snapshot";
