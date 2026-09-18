import { CLASS_ORDER, CLASS_STYLES } from "../classes";
import type { Filters, ThermalClass } from "../types";

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
}

const TIME_WINDOWS: { value: Filters["withinHours"]; label: string }[] = [
  { value: 6, label: "Last 6 hours" },
  { value: 24, label: "Last 24 hours" },
  { value: 72, label: "Last 3 days" },
  { value: "all", label: "All loaded" },
];

export default function FilterPanel({ filters, onChange }: Props) {
  return (
    <aside className="panel panel--filters">
      <div className="field">
        <label className="field__label" htmlFor="f-class">
          Class
        </label>
        <select
          id="f-class"
          value={filters.predictedClass}
          onChange={(e) =>
            onChange({
              ...filters,
              predictedClass: e.target.value as ThermalClass | "all",
            })
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
              withinHours:
                e.target.value === "all" ? "all" : Number(e.target.value),
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
        <label className="field__label" htmlFor="f-conf">
          Minimum confidence &middot; {filters.minConfidence.toFixed(2)}
        </label>
        <input
          id="f-conf"
          type="range"
          min={0}
          max={0.95}
          step={0.05}
          value={filters.minConfidence}
          onChange={(e) =>
            onChange({ ...filters, minConfidence: Number(e.target.value) })
          }
        />
      </div>

      <h2 className="section-title">Legend</h2>
      {/* Identity is never colour-alone: every swatch is labelled in text. */}
      <div className="legend">
        {CLASS_ORDER.map((cls) => (
          <div className="legend__row" key={cls}>
            <span className={`legend__swatch legend__swatch--${cls}`} />
            {CLASS_STYLES[cls].shortLabel}
          </div>
        ))}
      </div>

      <h2 className="section-title">Marker size</h2>
      <p className="detail__empty">
        Marker area is proportional to Fire Radiative Power, so a stronger
        thermal signal reads as a larger mark.
      </p>
    </aside>
  );
}
