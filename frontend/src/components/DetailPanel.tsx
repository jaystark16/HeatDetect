import type { EvidenceKind, HotspotDetail } from "../types";

interface Props {
  detail: HotspotDetail | null;
  loading: boolean;
  /** Set when the API was unreachable and detail came from the cached snapshot. */
  fromSnapshot: boolean;
  /** Set when neither the API nor the snapshot had detail for this selection. */
  unavailable: boolean;
}

function metres(value: number | null): string {
  if (value === null) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

const KIND_LABEL: Record<EvidenceKind, string> = {
  observed: "Measured",
  derived: "Computed",
  absent: "Not established",
};

export default function DetailPanel({
  detail,
  loading,
  fromSnapshot,
  unavailable,
}: Props) {
  if (loading) {
    return (
      <aside className="panel panel--detail">
        <p className="detail__empty">Loading detail…</p>
      </aside>
    );
  }

  if (unavailable) {
    return (
      <aside className="panel panel--detail">
        <h2 className="detail__label">Detail unavailable</h2>
        <p className="detail__empty">
          The API is unreachable, and the cached snapshot only carries full
          evidence for the most significant locations. Select a recurring
          hotspot — larger, thicker-outlined marks — or start the backend to see
          detail for any detection.
        </p>
      </aside>
    );
  }

  if (!detail) {
    return (
      <aside className="panel panel--detail">
        <p className="detail__empty">
          Select a hotspot to see what was measured, what was computed from its
          history, and how it was classified.
        </p>
      </aside>
    );
  }

  const { observation: obs, persistence: p, context: ctx, classification: cls } = detail;

  return (
    <aside className="panel panel--detail">
      <h2 className="detail__label">{cls.display_label}</h2>

      {/* Where the verdict came from, and — for rules — that a probability
          would be meaningless rather than merely missing. */}
      <div className="detail__origin">
        {cls.source === "rule" ? (
          <>
            <span className="chip chip--rule">Deterministic rules</span>
            <span className="detail__origin-note">
              Decided by thresholds over this location's multi-day history. No
              probability is reported, because a threshold comparison does not
              have one.
            </span>
          </>
        ) : (
          <>
            <span className="chip chip--model">Model estimate</span>
            <span className="detail__origin-note">
              {cls.abstained
                ? "The model declined to classify this detection."
                : `Single-observation estimate${
                    cls.confidence !== null
                      ? `, probability ${cls.confidence.toFixed(2)}`
                      : ""
                  }. Used only because the rules could not decide.`}
            </span>
          </>
        )}
      </div>

      <p className="detail__caution">{detail.caution}</p>

      {fromSnapshot && (
        <p className="detail__snapshot">
          From the cached snapshot — the live API was not reachable.
        </p>
      )}

      {detail.evidence.length > 0 && (
        <>
          <h3 className="section-title">Evidence</h3>
          <ul className="evidence">
            {detail.evidence.map((item) => (
              <li key={item.statement} className={`evidence__item evidence__item--${item.kind}`}>
                <span className={`evidence__kind evidence__kind--${item.kind}`}>
                  {KIND_LABEL[item.kind]}
                </span>
                <span className="evidence__text">{item.statement}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="section-title">Measured by satellite</h3>
      <dl className="kv">
        <dt>Coordinates</dt>
        <dd>
          {detail.latitude.toFixed(4)}, {detail.longitude.toFixed(4)}
        </dd>
        <dt>Acquired</dt>
        <dd>{new Date(detail.acquired_at).toLocaleString()}</dd>
        <dt>Platform</dt>
        <dd>
          {obs.satellite} / {obs.instrument}
        </dd>
        <dt>Fire radiative power</dt>
        <dd>{obs.frp_mw.toFixed(2)} MW</dd>
        <dt>Brightness (4 µm)</dt>
        <dd>{obs.brightness_k.toFixed(1)} K</dd>
        <dt>Brightness (11 µm)</dt>
        <dd>{obs.brightness_long_k.toFixed(1)} K</dd>
        <dt>Dual-band separation</dt>
        <dd>{obs.dual_band_delta_k.toFixed(1)} K</dd>
        <dt>Source confidence</dt>
        <dd>
          {obs.confidence_tier}
          {obs.confidence_raw !== obs.confidence_tier && ` (${obs.confidence_raw})`}
        </dd>
        <dt>Day / night</dt>
        <dd>{obs.day_night === "D" ? "Day" : "Night"}</dd>
      </dl>

      <h3 className="section-title">Computed from history</h3>
      {p ? (
        <dl className="kv">
          <dt>Distinct days</dt>
          <dd>
            {p.distinct_days} of {p.window_days}
          </dd>
          <dt>Observations</dt>
          <dd>{p.observation_count}</dd>
          <dt>Median FRP</dt>
          <dd>{p.median_frp_mw.toFixed(2)} MW</dd>
          <dt>90th percentile FRP</dt>
          <dd>{p.p90_frp_mw.toFixed(2)} MW</dd>
          <dt>Deviation ratio</dt>
          <dd>
            {p.deviation_ratio !== null ? (
              `${p.deviation_ratio.toFixed(2)}x`
            ) : (
              <span className="kv__absent">baseline too thin</span>
            )}
          </dd>
          <dt>Night fraction</dt>
          <dd>{(p.night_fraction * 100).toFixed(0)}%</dd>
          <dt>First seen</dt>
          <dd>{new Date(p.first_seen).toLocaleDateString()}</dd>
          <dt>Last seen</dt>
          <dd>{new Date(p.last_seen).toLocaleDateString()}</dd>
        </dl>
      ) : (
        <p className="detail__empty">No history computed for this location.</p>
      )}

      <h3 className="section-title">Geographic context</h3>
      {ctx.coverage === "not_surveyed" ? (
        <p className="detail__absent">
          Industrial infrastructure here has not been surveyed. This is a gap in
          our coverage, not evidence that no industry is nearby.
        </p>
      ) : (
        <dl className="kv">
          <dt>Nearest facility</dt>
          <dd>{ctx.nearest_facility_name ?? "unnamed / none within 10 km"}</dd>
          <dt>Category</dt>
          <dd>{ctx.nearest_facility_category ?? "—"}</dd>
          <dt>Distance</dt>
          <dd>{metres(ctx.distance_to_facility_m)}</dd>
          <dt>Facilities within 5 km</dt>
          <dd>{ctx.facilities_within_5km}</dd>
          <dt>Land cover</dt>
          <dd>{ctx.land_cover}</dd>
        </dl>
      )}
    </aside>
  );
}
