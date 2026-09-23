import { CLASS_ORDER, CLASS_STYLES } from "../classes";
import type { Analytics, Filters, Provenance, ThermalClass } from "../types";

interface Props {
  filters: Filters;
  analytics: Analytics | null;
  onChange: (next: Filters) => void;
}

const TIME_WINDOWS: { value: Filters["withinHours"]; label: string }[] = [
  { value: 24, label: "Last 24 hours" },
  { value: 72, label: "Last 3 days" },
  { value: 168, label: "Last 7 days" },
];

/**
 * Label the unfiltered option with the window the data actually spans.
 *
 * It used to read "Full 7-day window", which was true when the database held
 * one archive fetch. The pipeline appends, so after two months of runs the
 * database spanned 60 days and the label was simply wrong. Deriving it from
 * provenance means it cannot drift again.
 */
function allWindowLabel(provenance: Provenance | null | undefined): string {
  const oldest = provenance?.oldest_detection_at;
  const newest = provenance?.newest_detection_at;
  if (!oldest || !newest) return "All ingested data";

  const days = Math.max(
    1,
    Math.round((Date.parse(newest) - Date.parse(oldest)) / 86_400_000),
  );
  return `All ingested data (${days} days)`;
}

/**
 * Display filter over a location's distinct-day count.
 *
 * These are *not* the classification threshold, and the labels deliberately no
 * longer claim to be. That threshold is window-relative in
 * `backend/app/labels.py` — a quarter of the days available to observe, floored
 * at four — so it is 4 against a 7-day archive and 16 against a 61-day
 * backfill. Naming a fixed number here as "persistent" was true only for the
 * original one-week window and silently became wrong once history grew.
 */
const PERSISTENCE_STEPS: { value: number; label: string }[] = [
  { value: 0, label: "Any" },
  { value: 2, label: "2+ days (recurring)" },
  { value: 4, label: "4+ days" },
  { value: 14, label: "14+ days (long-running)" },
  // The database accumulates, so baselines lengthen over time; locations in
  // the Jharia coalfield now reach 46 distinct days. A 6-day ceiling stopped
  // discriminating once the window grew past a week.
  { value: 30, label: "30+ days (entrenched)" },
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
          <option value="all">{allWindowLabel(analytics?.provenance)}</option>
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
