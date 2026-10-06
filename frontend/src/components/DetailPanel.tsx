import type { EvidenceKind, HotspotDetail } from "../types";

interface Props {
  detail: HotspotDetail | null;
  loading: boolean;
  /** Set when detail came from the snapshot file rather than the API. */
  fromSnapshot: boolean;
  /** Set when neither the API nor the snapshot had detail for this selection. */
  unavailable: boolean;
  /** Set when fetching the detail failed — distinct from it not existing. */
  error: string | null;
  onBack: () => void;
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
  error,
  onBack,
}: Props) {
  const back = (
    <button type="button" className="back-button" onClick={onBack}>
      ← Back to feed
    </button>
  );

  if (loading) {
    return (
      <div className="detail">
        {back}
        <p className="detail__empty">Loading detail…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="detail">
        {back}
        <h2 className="detail__label">Detail could not be loaded</h2>
        <p className="detail__absent">
          {error} This is a failed download, not an absence of evidence. Check
          the connection and select the location again.
        </p>
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className="detail">
        {back}
        <h2 className="detail__label">Detail unavailable</h2>
        <p className="detail__empty">
          This build of the snapshot has no stored evidence for this location,
          either because it was exported without per-location detail or because
          the file could not be found. Nothing is shown rather than a partial
          panel. Select another mark, or run the API to see detail for any
          detection.
        </p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="detail">
        {back}
        <p className="detail__empty">No detail was returned for this location.</p>
      </div>
    );
  }

  const { observation: obs, persistence: p, context: ctx, classification: cls } = detail;

  return (
    <div className="detail">
      {back}
      <div className="detail__heading">
        <span className={`dot dot--lg dot--${cls.label}`} aria-hidden="true" />
        <h2 className="detail__label">{cls.display_label}</h2>
      </div>
      <p className="detail__coords">
        {detail.latitude.toFixed(4)}° N, {detail.longitude.toFixed(4)}° E
      </p>

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
          From the snapshot file, not a live query. The timestamp is the real
          acquisition time.
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
      <div className="detail__card">
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
      </div>

      <h3 className="section-title">Computed from history</h3>
      {p ? (
        <div className="detail__card">
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
        </div>
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
        <div className="detail__card">
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
        </div>
      )}
    </div>
  );
}
