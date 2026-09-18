import { useState } from "react";

import type { DataMode, DatasetInfo, ModelInfo, Provenance } from "../types";

interface Props {
  provenance: Provenance | null;
  mode: DataMode;
  datasets: DatasetInfo[];
  model: ModelInfo | null;
  snapshotWindow: { oldest: string | null; newest: string | null } | null;
}

const MODE_COPY: Record<DataMode, { chip: string; className: string }> = {
  live: { chip: "● Live", className: "chip--live" },
  historical: { chip: "◆ Historical", className: "chip--sample" },
  cached_snapshot: { chip: "◆ Cached snapshot", className: "chip--sample" },
};

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/**
 * Provenance is permanent chrome, not a footnote.
 *
 * The three modes are visually distinct because conflating them is the most
 * likely way this dashboard could mislead: a cached file from last week and a
 * live feed look identical unless the interface insists otherwise.
 */
export default function ProvenanceBar({
  provenance,
  mode,
  datasets,
  model,
  snapshotWindow,
}: Props) {
  const [open, setOpen] = useState(false);
  const copy = MODE_COPY[mode];

  const newest = snapshotWindow?.newest ?? provenance?.newest_detection_at ?? null;
  const oldest = snapshotWindow?.oldest ?? provenance?.oldest_detection_at ?? null;

  return (
    <>
      <span className={`chip ${copy.className}`}>{copy.chip}</span>

      <span className="topbar__sub">
        {mode === "live"
          ? `Newest detection ${provenance?.age_of_newest_hours?.toFixed(1)} h ago`
          : `Data window ${formatDate(oldest)} → ${formatDate(newest)}`}
      </span>

      <button
        type="button"
        className="topbar__button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "Hide sources" : "Sources & model"}
      </button>

      {open && (
        <div className="drawer" role="dialog" aria-label="Data sources and model">
          <div className="drawer__inner">
            <section className="drawer__section">
              <h3 className="section-title">Coverage</h3>
              <p className="drawer__text">
                {provenance?.coverage_note ?? "No coverage information."}
              </p>
              <p className="drawer__text drawer__text--muted">
                The analysis area is a bounding box around India. It also covers
                parts of Pakistan, Nepal, Bangladesh and Sri Lanka — it is a
                rectangle, not a national boundary.
              </p>
            </section>

            <section className="drawer__section">
              <h3 className="section-title">Classification model</h3>
              {model?.trained ? (
                <>
                  <dl className="kv">
                    <dt>Version</dt>
                    <dd>{model.model_version}</dd>
                    <dt>Type</dt>
                    <dd>{model.model_type}</dd>
                    <dt>Label rules</dt>
                    <dd>{model.label_rule_version}</dd>
                    <dt>Features</dt>
                    <dd>{model.feature_names.length}</dd>
                  </dl>
                  <ModelMetrics metrics={model.metrics} />
                  <p className="drawer__text drawer__text--caveat">{model.caveat}</p>
                </>
              ) : (
                <p className="drawer__text">
                  {model?.caveat ?? "No model information available."}
                </p>
              )}
            </section>

            <section className="drawer__section">
              <h3 className="section-title">Data sources</h3>
              {datasets.map((d) => (
                <div key={d.id} className="dataset">
                  <div className="dataset__head">
                    <a href={d.source_url} target="_blank" rel="noreferrer noopener">
                      {d.name}
                    </a>
                    <span className={`chip chip--kind-${d.kind}`}>{d.kind}</span>
                  </div>
                  <div className="dataset__meta">
                    {d.provider} · {d.licence}
                  </div>
                  <div className="dataset__meta">
                    Updates: {d.update_frequency}
                    {d.spatial_resolution ? ` · ${d.spatial_resolution}` : ""}
                  </div>
                  <details className="dataset__limits">
                    <summary>
                      {d.limitations.length} stated limitation
                      {d.limitations.length === 1 ? "" : "s"}
                    </summary>
                    <ul>
                      {d.limitations.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  </details>
                </div>
              ))}
            </section>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Per-class metrics only. Overall accuracy is deliberately not shown: the
 * classes are heavily imbalanced, so a single figure would flatter the model
 * while hiding that the rarest and most important class performs worst.
 */
function ModelMetrics({ metrics }: { metrics: Record<string, unknown> | null }) {
  if (!metrics) return null;
  const perClass = metrics.per_class as
    | Record<string, { precision: number; recall: number; f1: number; support: number }>
    | undefined;
  if (!perClass) return null;

  return (
    <>
      <table className="metrics">
        <thead>
          <tr>
            <th>class</th>
            <th>prec.</th>
            <th>recall</th>
            <th>F1</th>
            <th>n</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(perClass).map(([label, row]) => (
            <tr key={label} className={row.recall === 0 ? "metrics__row--zero" : ""}>
              <td>{label}</td>
              <td>{row.precision.toFixed(2)}</td>
              <td>{row.recall.toFixed(2)}</td>
              <td>{row.f1.toFixed(2)}</td>
              <td>{row.support}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {perClass.industrial_fire?.recall === 0 && (
        <p className="drawer__text drawer__text--caveat">
          The model scores zero recall on industrial fires: that class is defined
          by a deviation from a location's multi-day baseline, which a single
          observation cannot reveal. Industrial-fire findings therefore come only
          from the deterministic rules, and the model is blocked from raising
          them.
        </p>
      )}
    </>
  );
}
