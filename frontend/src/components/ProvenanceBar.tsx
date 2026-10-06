import { useEffect, useRef, useState } from "react";

import type { FallbackMeta } from "../fallback";
import type { DataMode, DatasetInfo, ModelInfo, Provenance } from "../types";

interface Props {
  provenance: Provenance | null;
  mode: DataMode;
  datasets: DatasetInfo[];
  model: ModelInfo | null;
  /** Set when the data came from the snapshot file rather than the API. */
  snapshot: FallbackMeta | null;
}

const MODE_COPY: Record<DataMode, { chip: string; className: string }> = {
  live: { chip: "● Live", className: "chip--live" },
  // NASA's own name for this data class. It is not "Live": the page is reading
  // a file a scheduled build wrote, and the line beside the chip says when.
  near_real_time: { chip: "● Near real time", className: "chip--live" },
  historical: { chip: "◆ Historical", className: "chip--sample" },
  cached_snapshot: { chip: "◆ Cached snapshot", className: "chip--sample" },
};

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/** "40 min", "5 h", "13 days" — whichever unit a person reads at a glance. */
export function formatAge(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "unknown";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
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
  snapshot,
}: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const copy = MODE_COPY[mode];

  // A panel announced as a dialog must be dismissable without a mouse, and
  // must not trap a user who clicks away from it.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const newest = snapshot?.newestDetectionAt ?? provenance?.newest_detection_at ?? null;
  const oldest = snapshot?.oldestDetectionAt ?? provenance?.oldest_detection_at ?? null;

  let detailLine: string;
  if (mode === "live") {
    detailLine = `Newest detection ${formatAge(provenance?.age_of_newest_hours ?? null)} ago`;
  } else if (mode === "near_real_time" && snapshot) {
    // Both ages, because they answer different questions: is the pipeline
    // keeping up, and when did a satellite last see something.
    detailLine =
      `Rebuilt from NASA FIRMS ${formatAge(snapshot.buildAgeHours)} ago · ` +
      `newest detection ${formatAge(snapshot.newestAgeHours)} ago · ` +
      `refreshes every ${snapshot.cadenceHours} h`;
  } else if (mode === "cached_snapshot" && snapshot) {
    detailLine =
      `Data ${formatDate(oldest)} → ${formatDate(newest)} · ` +
      (snapshot.scheduled
        ? `last rebuilt ${formatAge(snapshot.buildAgeHours)} ago — scheduled refresh has fallen behind`
        : `one-off build from ${formatAge(snapshot.buildAgeHours)} ago`);
  } else {
    detailLine = `Data window ${formatDate(oldest)} → ${formatDate(newest)}`;
  }

  return (
    <div className="provenance" ref={containerRef}>
      <span className={`chip ${copy.className}`}>{copy.chip}</span>

      <span className="topbar__sub">{detailLine}</span>

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
    </div>
  );
}

/**
 * Per-class metrics only. Overall accuracy is deliberately not shown: the
 * classes are heavily imbalanced, so a single figure would flatter the model
 * while hiding that the rarest and most important class performs worst.
 *
 * The caveat below is derived from the numbers rather than hardcoded. An
 * earlier version rendered only when recall was exactly 0 and asserted "zero
 * recall" in prose; when coverage improved and recall rose to 0.32, the panel
 * silently stopped warning while the underlying limitation remained. Reading
 * the measurement means the copy cannot go stale behind the data.
 */

/** Matches MIN_PRECISION_TO_REPORT in backend/app/model.py. */
const MIN_PRECISION_TO_REPORT = 0.5;

interface ClassMetrics {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

function ModelMetrics({ metrics }: { metrics: Record<string, unknown> | null }) {
  if (!metrics) return null;
  const perClass = metrics.per_class as Record<string, ClassMetrics> | undefined;
  if (!perClass) return null;

  const suppressed = Object.entries(perClass).filter(
    ([, row]) => row.precision < MIN_PRECISION_TO_REPORT,
  );

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
            <tr
              key={label}
              className={
                row.precision < MIN_PRECISION_TO_REPORT
                  ? "metrics__row--suppressed"
                  : ""
              }
            >
              <td>{label}</td>
              <td>{row.precision.toFixed(3)}</td>
              <td>{row.recall.toFixed(3)}</td>
              <td>{row.f1.toFixed(3)}</td>
              <td>{row.support}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {suppressed.length > 0 && (
        <p className="drawer__text drawer__text--caveat">
          {suppressed.map(([label, row]) => (
            <span key={label}>
              The model is not trusted to report <strong>{label}</strong>:
              measured precision {row.precision.toFixed(3)} means most such
              predictions would be wrong, so it is suppressed and reported as
              unclassified instead.{" "}
            </span>
          ))}
          Findings for these classes come only from the deterministic rules,
          which use multi-day history.
        </p>
      )}

      {perClass.natural_fire && perClass.natural_fire.precision > 0.99 && (
        <p className="drawer__text drawer__text--caveat">
          Near-perfect precision on <strong>natural_fire</strong> is partly
          leakage, not skill: the label requires a location to be far from mapped
          industry, and the model is given that distance directly. With proximity
          features removed it falls to 0.747.
        </p>
      )}
    </>
  );
}
