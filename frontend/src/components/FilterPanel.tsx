import { CLASS_ORDER, CLASS_STYLES } from "../classes";
import type { Analytics, Filters, ThermalClass } from "../types";

interface Props {
  filters: Filters;
  analytics: Analytics | null;
  onChange: (next: Filters) => void;
}

const TIME_WINDOWS: { value: Filters["withinHours"]; label: string }[] = [
  { value: 24, label: "Last 24 hours" },
  { value: 72, label: "Last 3 days" },
  { value: "all", label: "Full 7-day window" },
];

/**
 * Persistence thresholds mirror the classification rules: 4+ distinct days is
 * the criterion for a persistent source, so it is offered directly rather than
 * leaving the user to discover it.
 */
const PERSISTENCE_STEPS: { value: number; label: string }[] = [
  { value: 0, label: "Any" },
  { value: 2, label: "2+ days (recurring)" },
  { value: 4, label: "4+ days (persistent)" },
  { value: 6, label: "6+ days (continuous)" },
];

export default function FilterPanel({ filters, analytics, onChange }: Props) {
  const counts = new Map(analytics?.by_class.map((c) => [c.label, c]) ?? []);

  return (
    <aside className="panel panel--filters">
      <div className="field">
        <label className="field__label" htmlFor="f-class">
          Class
        </label>
        <select
          id="f-class"
          value={filters.label}
          onChange={(e) =>
            onChange({ ...filters, label: e.target.value as ThermalClass | "all" })
          }
        >
          <option value="all">All classes</option>
          {CLASS_ORDER.map((cls) => (
            <option key={cls} value={cls}>
              {CLASS_STYLES[cls].shortLabel}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="f-window">
          Time window
        </label>
        <select
          id="f-window"
          value={String(filters.withinHours)}
          onChange={(e) =>
            onChange({
              ...filters,
              withinHours: e.target.value === "all" ? "all" : Number(e.target.value),
            })
          }
        >
          {TIME_WINDOWS.map((w) => (
            <option key={String(w.value)} value={String(w.value)}>
              {w.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="f-days">
          Persistence
        </label>
        <select
          id="f-days"
          value={filters.minDistinctDays}
          onChange={(e) =>
            onChange({ ...filters, minDistinctDays: Number(e.target.value) })
          }
        >
          {PERSISTENCE_STEPS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="f-frp">
          Minimum FRP · {filters.minFrpMw.toFixed(1)} MW
        </label>
        <input
          id="f-frp"
          type="range"
          min={0}
          // Capped near the measured p99 (~18 MW). A 100 MW cap would leave most
          // of the slider travel in a range that contains no data at all.
          max={20}
          step={0.5}
          value={filters.minFrpMw}
          onChange={(e) => onChange({ ...filters, minFrpMw: Number(e.target.value) })}
        />
      </div>

      <h2 className="section-title">Classes</h2>
      {/* Identity is never colour-alone: every swatch is labelled, and the
          counts come from the analytics endpoint rather than being decorative. */}
      <div className="legend">
        {CLASS_ORDER.map((cls) => {
          const count = counts.get(cls);
          return (
            <button
              type="button"
              key={cls}
              className={`legend__row legend__row--button ${
                filters.label === cls ? "is-active" : ""
              }`}
              onClick={() =>
                onChange({ ...filters, label: filters.label === cls ? "all" : cls })
              }
              aria-pressed={filters.label === cls}
            >
              <span className={`legend__swatch legend__swatch--${cls}`} />
              <span className="legend__label">{CLASS_STYLES[cls].shortLabel}</span>
              {count && <span className="legend__count">{count.cells}</span>}
            </button>
          );
        })}
      </div>

      <h2 className="section-title">Reading the map</h2>
      <ul className="hint-list">
        <li>Mark area is proportional to fire radiative power.</li>
        <li>Thicker outlines mean the location recurs on more days.</li>
        <li>Hollow marks are unclassified, not a fourth category.</li>
      </ul>
    </aside>
  );
}
