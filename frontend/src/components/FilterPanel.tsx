import { useEffect, useState } from "react";

import type { Analytics, Filters, Provenance } from "../types";

interface Props {
  filters: Filters;
  analytics: Analytics | null;
  onChange: (next: Filters) => void;
}

/**
 * Span of the data, in whole days, read from provenance.
 *
 * The "All" button used to say "Full 7-day window", which was true when the
 * database held one archive fetch. The pipeline appends, so after two months of
 * runs it spanned 60 days and the label was simply wrong. Deriving it means it
 * cannot drift again.
 */
export function windowDays(provenance: Provenance | null | undefined): number | null {
  const oldest = provenance?.oldest_detection_at;
  const newest = provenance?.newest_detection_at;
  if (!oldest || !newest) return null;
  return Math.max(1, Math.round((Date.parse(newest) - Date.parse(oldest)) / 86_400_000));
}

/**
 * Display filter over a location's distinct-day count.
 *
 * This is *not* the classification threshold, and the label deliberately does
 * not claim to be. That threshold is window-relative in `backend/app/labels.py`
 * — a quarter of the days available to observe, floored at four — so a fixed
 * number named "persistent" here would be true for one window and wrong for
 * the next.
 */
const MAX_DAYS_SLIDER = 60;

/** Slider ceiling near the measured p99 (~18 MW); a 100 MW cap is empty travel. */
const MAX_FRP_SLIDER = 20;

/** Commit slider drags after they settle, not once per pixel. */
const SLIDER_SETTLE_MS = 200;

export default function FilterPanel({ filters, analytics, onChange }: Props) {
  const days = windowDays(analytics?.provenance);

  const windows: { value: Filters["withinHours"]; label: string; title: string }[] = [
    { value: 24, label: "24h", title: "Detected in the last 24 hours" },
    { value: 72, label: "72h", title: "Detected in the last 3 days" },
    { value: 168, label: "7d", title: "Detected in the last 7 days" },
    {
      value: "all",
      label: days ? `All · ${days}d` : "All",
      title: days ? `Everything ingested: ${days} days of data` : "Everything ingested",
    },
  ];

  // Local draft values so the thumb moves smoothly; the filter — and the
  // request behind it — follows once the drag pauses.
  const [frp, setFrp] = useState(filters.minFrpMw);
  const [minDays, setMinDays] = useState(filters.minDistinctDays);

  useEffect(() => setFrp(filters.minFrpMw), [filters.minFrpMw]);
  useEffect(() => setMinDays(filters.minDistinctDays), [filters.minDistinctDays]);

  useEffect(() => {
    if (frp === filters.minFrpMw && minDays === filters.minDistinctDays) return;
    const timer = window.setTimeout(
      () => onChange({ ...filters, minFrpMw: frp, minDistinctDays: minDays }),
      SLIDER_SETTLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [frp, minDays, filters, onChange]);

  return (
    <div className="filters">
      <div className="segmented" role="group" aria-label="Time window">
        {windows.map((w) => {
          const active = filters.withinHours === w.value;
          return (
            <button
              type="button"
              key={String(w.value)}
              className={`segmented__option ${active ? "is-active" : ""}`}
              aria-pressed={active}
              title={w.title}
              onClick={() => onChange({ ...filters, withinHours: w.value })}
            >
              {w.label}
            </button>
          );
        })}
      </div>

      <div className="slider">
        <label className="slider__head" htmlFor="f-days">
          <span>Seen on at least</span>
          <span className="slider__value">
            {minDays === 0 ? "any day" : `${minDays} ${minDays === 1 ? "day" : "days"}`}
          </span>
        </label>
        <input
          id="f-days"
          type="range"
          min={0}
          max={MAX_DAYS_SLIDER}
          step={1}
          value={minDays}
          onChange={(e) => setMinDays(Number(e.target.value))}
        />
      </div>

      <div className="slider">
        <label className="slider__head" htmlFor="f-frp">
          <span>Min fire radiative power</span>
          <span className="slider__value">{frp.toFixed(1)} MW</span>
        </label>
        <input
          id="f-frp"
          type="range"
          min={0}
          max={MAX_FRP_SLIDER}
          step={0.5}
          value={frp}
          onChange={(e) => setFrp(Number(e.target.value))}
        />
      </div>
    </div>
  );
}
