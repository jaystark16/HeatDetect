import { useMemo } from "react";

import { CLASS_STYLES } from "../classes";
import type { MapMark } from "../types";
import { formatAge } from "./ProvenanceBar";

function hoursSince(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 3_600_000) : null;
}

interface Props {
  marks: MapMark[];
  selectedId: string | null;
  onSelect: (mark: MapMark) => void;
}

/** Enough to scan; the map carries the rest. Rendering 18,000 cards would not. */
const FEED_LIMIT = 80;

function coordinate(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(3)}° ${value >= 0 ? positive : negative}`;
}

/**
 * Locations ranked by how persistently they burn.
 *
 * Persistence first because it is the signal this system is built on: a cell
 * seen on forty days is the story, a single bright pass is usually not. Every
 * value on a card comes straight from the mark; nothing is estimated for display.
 */
export default function LocationFeed({ marks, selectedId, onSelect }: Props) {
  const ranked = useMemo(
    () =>
      [...marks]
        .sort(
          (a, b) =>
            b.distinct_days - a.distinct_days ||
            b.frp_mw - a.frp_mw ||
            a.id.localeCompare(b.id),
        )
        .slice(0, FEED_LIMIT),
    [marks],
  );

  if (marks.length === 0) {
    return <p className="feed__empty">No locations match these filters.</p>;
  }

  return (
    <>
      <ol className="feed__list">
        {ranked.map((mark) => {
          const style = CLASS_STYLES[mark.label];
          return (
            <li key={mark.id}>
              <button
                type="button"
                className={`feed-card ${mark.id === selectedId ? "is-selected" : ""}`}
                onClick={() => onSelect(mark)}
              >
                <div className="feed-card__top">
                  <div className="feed-card__where">
                    <div className="feed-card__coords">
                      <span className={`dot dot--${mark.label}`} aria-hidden="true" />
                      {coordinate(mark.latitude, "N", "S")},{" "}
                      {coordinate(mark.longitude, "E", "W")}
                    </div>
                    <p className="feed-card__class">{style.shortLabel}</p>
                  </div>
                  <span
                    className={`badge badge--${mark.label}`}
                    title="Distinct days this location was detected"
                  >
                    {mark.distinct_days} {mark.distinct_days === 1 ? "day" : "days"}
                  </span>
                </div>
                <div className="feed-card__metrics">
                  <span title="Peak fire radiative power">
                    Peak <b>{mark.frp_mw.toFixed(1)} MW</b>
                  </span>
                  <span title="Satellite observations">
                    <b>{mark.observation_count.toLocaleString()}</b> passes
                  </span>
                  <span>
                    Seen <b>{formatAge(hoursSince(mark.last_seen))} ago</b>
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
      {marks.length > ranked.length && (
        <p className="feed__more">
          Top {ranked.length} of {marks.length.toLocaleString()} locations by days
          seen. Every one is on the map.
        </p>
      )}
    </>
  );
}
