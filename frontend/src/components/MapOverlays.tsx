import { CLASS_ORDER, CLASS_STYLES } from "../classes";
import type { Analytics, Filters, ThermalClass } from "../types";

interface LegendProps {
  analytics: Analytics | null;
  active: Filters["label"];
  onToggle: (cls: ThermalClass | "all") => void;
}

/**
 * Legend that doubles as the class filter.
 *
 * Identity is never colour alone: every swatch is named, unclassified is drawn
 * hollow, and the counts come from the analytics endpoint rather than being
 * decorative.
 */
export function MapLegend({ analytics, active, onToggle }: LegendProps) {
  const counts = new Map(analytics?.by_class.map((c) => [c.label, c.cells]) ?? []);

  return (
    <div className="overlay overlay--legend">
      <p className="overlay__eyebrow">Classification · locations</p>
      <div className="legend">
        {CLASS_ORDER.map((cls) => {
          const pressed = active === cls;
          return (
            <button
              type="button"
              key={cls}
              className={`legend__row ${pressed ? "is-active" : ""}`}
              aria-pressed={pressed}
              title={pressed ? "Show all classes" : `Show only ${CLASS_STYLES[cls].shortLabel.toLowerCase()}`}
              onClick={() => onToggle(pressed ? "all" : cls)}
            >
              <span className={`dot dot--lg dot--${cls}`} aria-hidden="true" />
              <span className="legend__label">{CLASS_STYLES[cls].shortLabel}</span>
              {counts.has(cls) && (
                <span className="legend__count">{counts.get(cls)!.toLocaleString()}</span>
              )}
            </button>
          );
        })}
      </div>
      <p className="legend__hint">Size ∝ FRP · hollow = unclassified</p>
    </div>
  );
}

interface RegionProps {
  detections: number | null;
  days: number | null;
}

/** What area and how much data the map covers, in one line. */
export function RegionChip({ detections, days }: RegionProps) {
  return (
    <div className="overlay overlay--region">
      <span className="dot dot--brand" aria-hidden="true" />
      <strong>India region</strong>
      {detections !== null && (
        <span className="overlay__muted">
          · {detections.toLocaleString()} detections
          {days !== null && ` over ${days} days`}
        </span>
      )}
    </div>
  );
}

interface CountProps {
  value: number;
  label: string;
}

export function BigCount({ value, label }: CountProps) {
  return (
    <div className="overlay--count" aria-live="polite">
      <div className="big-count">{value.toLocaleString()}</div>
      <div className="overlay__eyebrow">{label}</div>
    </div>
  );
}
