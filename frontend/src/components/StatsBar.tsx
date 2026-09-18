import { CLASS_STYLES } from "../classes";
import type { Analytics } from "../types";

interface Props {
  analytics: Analytics | null;
  shown: number;
}

/**
 * Bottom strip from section 11 of the planning document.
 *
 * These are stat tiles, not a chart — the numbers are the headline and there is
 * no magnitude comparison to plot. Charted analytics arrive in Phase 7.
 */
export default function StatsBar({ analytics, shown }: Props) {
  if (!analytics) return <div className="stats" />;

  const { by_class: byClass } = analytics;

  return (
    <div className="stats">
      <Stat value={analytics.total_hotspots} label="Total hotspots" />
      <Stat value={shown} label="Matching filters" />
      <Stat
        value={byClass.industrial_fire}
        label={CLASS_STYLES.industrial_fire.shortLabel}
      />
      <Stat
        value={byClass.persistent_industrial}
        label={CLASS_STYLES.persistent_industrial.shortLabel}
      />
      <Stat value={byClass.natural_fire} label={CLASS_STYLES.natural_fire.shortLabel} />
      <Stat value={byClass.unknown} label={CLASS_STYLES.unknown.shortLabel} />
      <Stat
        value={analytics.alerts}
        label="Flagged for investigation"
        // Status colour carries an icon and a label, never colour alone.
        badge={analytics.alerts > 0 ? "⚠ Alert" : undefined}
      />
    </div>
  );
}

function Stat({
  value,
  label,
  badge,
}: {
  value: number;
  label: string;
  badge?: string;
}) {
  return (
    <div className="stat">
      <div className="stat__value">{value}</div>
      <div className="stat__label">
        {label}
        {badge && <span className="chip chip--alert">{badge}</span>}
      </div>
    </div>
  );
}
