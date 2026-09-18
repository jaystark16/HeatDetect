import type { Hotspot } from "../types";

interface Props {
  hotspot: Hotspot | null;
}

function metres(value: number | null): string {
  if (value === null) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

export default function DetailPanel({ hotspot }: Props) {
  if (!hotspot) {
    return (
      <aside className="panel panel--detail">
        <p className="detail__empty">
          Select a hotspot on the map to see its context, classification and the
          evidence behind it.
        </p>
      </aside>
    );
  }

  const { context: ctx, classification: cls } = hotspot;
  const acquired = new Date(hotspot.acquired_at);

  return (
    <aside className="panel panel--detail">
      {cls && (
        <>
          <h2 className="detail__label">{cls.label}</h2>
          <div className="detail__confidence">
            Confidence {cls.confidence.toFixed(2)}
            <div className="meter">
              <div
                className="meter__fill"
                style={{ width: `${Math.round(cls.confidence * 100)}%` }}
              />
            </div>
          </div>
        </>
      )}

      <h3 className="section-title">Detection</h3>
      <dl className="kv">
        <dt>Coordinates</dt>
        <dd>
          {hotspot.latitude.toFixed(4)}, {hotspot.longitude.toFixed(4)}
        </dd>
        <dt>Acquired</dt>
        <dd>{acquired.toLocaleString()}</dd>
        <dt>Platform</dt>
        <dd>
          {hotspot.satellite} / {hotspot.instrument}
        </dd>
        <dt>FRP</dt>
        <dd>{hotspot.frp_mw.toFixed(1)} MW</dd>
        <dt>Brightness</dt>
        <dd>{hotspot.brightness_k.toFixed(1)} K</dd>
        <dt>Source confidence</dt>
        <dd>{hotspot.source_confidence}</dd>
        <dt>Day / night</dt>
        <dd>{hotspot.day_night === "D" ? "Day" : "Night"}</dd>
      </dl>

      <h3 className="section-title">Context</h3>
      <dl className="kv">
        <dt>Nearest facility</dt>
        <dd>{ctx.nearest_facility_name ?? "None mapped"}</dd>
        <dt>Facility type</dt>
        <dd>{ctx.nearest_facility_type ?? "—"}</dd>
        <dt>Distance</dt>
        <dd>{metres(ctx.distance_to_facility_m)}</dd>
        <dt>Land cover</dt>
        <dd>{ctx.land_cover}</dd>
      </dl>

      <h3 className="section-title">Persistence</h3>
      <dl className="kv">
        <dt>Detections (30d)</dt>
        <dd>{ctx.detections_30d}</dd>
        <dt>Baseline FRP</dt>
        <dd>
          {ctx.baseline_frp_mw === null
            ? "No baseline"
            : `${ctx.baseline_frp_mw.toFixed(1)} MW`}
        </dd>
        <dt>Observed / baseline</dt>
        <dd>{ctx.frp_ratio === null ? "—" : `${ctx.frp_ratio.toFixed(2)}x`}</dd>
      </dl>

      {cls && cls.evidence.length > 0 && (
        <>
          <h3 className="section-title">Why this classification</h3>
          <ul className="evidence">
            {cls.evidence.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
