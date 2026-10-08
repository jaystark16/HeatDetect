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
      <p className="overlay__title">Locations by class</p>
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
      <p className="legend__hint">Dot size follows fire radiative power.</p>
    </div>
  );
}

interface RegionProps {
  detections: number | null;
  days: number | null;
}

/**
 * What area and how much data the map covers, in one line.
 *
 * "Analysis area", not "India": the bounding box also covers neighbouring
 * countries (SOUL.md, tone and voice).
 */
export function RegionChip({ detections, days }: RegionProps) {
  return (
    <div className="overlay overlay--region">
      <strong>Analysis area</strong>
      {detections !== null && (
        <span className="overlay__muted">
          {detections.toLocaleString()} detections
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

/** How many locations the current filters put on the map. */
export function BigCount({ value, label }: CountProps) {
  return (
    <div className="overlay overlay--count" aria-live="polite">
      <strong>{value.toLocaleString()}</strong>
      <span className="overlay__muted">{label}</span>
    </div>
  );
}
