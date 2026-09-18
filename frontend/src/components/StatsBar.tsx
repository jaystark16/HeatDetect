import type { Analytics } from "../types";

interface Props {
  analytics: Analytics | null;
  shown: number;
  totalMatching: number;
}

/**
 * Bottom status strip.
 *
 * These are stat tiles, not a chart: each number is a headline with no
 * magnitude comparison to plot. Every tile answers a question an operator would
 * actually ask, which is why there are six rather than a decorative grid.
 */
export default function StatsBar({ analytics, shown, totalMatching }: Props) {
  if (!analytics) return <div className="stats" />;

  const byClass = new Map(analytics.by_class.map((c) => [c.label, c]));
  const persistent = analytics.persistent_cells;
  const flagged = analytics.flagged_for_investigation;

  return (
    <div className="stats">
      <Stat
        value={analytics.total_detections.toLocaleString()}
        label="Detections ingested"
      />
      <Stat
        value={
          shown === totalMatching
            ? shown.toLocaleString()
            : `${shown.toLocaleString()} / ${totalMatching.toLocaleString()}`
        }
        label="Shown / matching"
        hint={
          shown < totalMatching
            ? "Result set truncated for map performance"
            : undefined
        }
      />
      <Stat value={analytics.total_cells.toLocaleString()} label="Locations (~1 km cells)" />
      <Stat
        value={persistent.toLocaleString()}
        label="Persistent (4+ days)"
      />
      <Stat
        value={(byClass.get("persistent_industrial")?.cells ?? 0).toLocaleString()}
        label="Industrial sources"
      />
      <Stat
        value={flagged.toLocaleString()}
        label="Flagged for investigation"
        // Status colour is paired with an icon and a label, never colour alone.
        badge={flagged > 0 ? "⚠" : undefined}
      />
    </div>
  );
}

function Stat({
  value,
  label,
  badge,
  hint,
}: {
  value: string;
  label: string;
  badge?: string;
  hint?: string;
}) {
  return (
    <div className="stat" title={hint}>
      <div className="stat__value">{value}</div>
      <div className="stat__label">
        {badge && <span className="chip chip--alert">{badge}</span>}
        {label}
      </div>
    </div>
  );
}
