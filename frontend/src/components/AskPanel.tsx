import { useCallback, useEffect, useRef, useState } from "react";

import {
  answer as computeAnswer,
  keywordRoute,
  type Answer,
  type AskContext,
} from "../assistant/intents";
import * as llm from "../assistant/llm";
import { verifyWording } from "../assistant/verify";
import type { MapMark } from "../types";

interface Props {
  /** Null until every location has loaded. */
  context: AskContext | null;
  onShow: (mark: MapMark) => void;
}

type ModelState =
  | { status: "checking" }
  | { status: "unsupported"; reason: string }
  | { status: "idle" }
  | { status: "loading"; fraction: number; text: string }
  | { status: "ready" }
  | { status: "error"; message: string };

interface Turn {
  id: number;
  question: string;
  answer: Answer;
  routedBy: "keywords" | "model";
  /** Model wording that passed the gate; null means the computed answer is shown. */
  wording: string | null;
  /** Why the model's wording was not shown, when it was attempted and failed. */
  rejected: string | null;
  seconds: number;
}

const SUGGESTIONS = [
  "What was detected in the last 24 hours?",
  "Which industrial sources are the most persistent?",
  "Where is the strongest heat?",
  "Give me an overview",
  "How current is this data?",
  "How reliable is the classifier?",
];

/**
 * Questions answered from the data, optionally worded by an on-device model.
 *
 * Every answer is computed (assistant/intents.ts). The model, when loaded,
 * may choose the question type for unusual phrasing and reword the result;
 * its wording is shown only if assistant/verify.ts finds nothing in it that
 * the data does not support. ADR 0008.
 */
export default function AskPanel({ context, onShow }: Props) {
  const [model, setModel] = useState<ModelState>({ status: "checking" });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (llm.isLoaded()) {
      setModel({ status: "ready" });
      return;
    }
    void llm.checkSupport().then((s) =>
      setModel(s.ok ? { status: "idle" } : { status: "unsupported", reason: s.reason }),
    );
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns, busy]);

  const loadModel = useCallback(async () => {
    setModel({ status: "loading", fraction: 0, text: "Starting…" });
    try {
      await llm.load((fraction, text) => setModel({ status: "loading", fraction, text }));
      setModel({ status: "ready" });
    } catch (cause) {
      setModel({
        status: "error",
        message: cause instanceof Error ? cause.message : "The model could not be loaded.",
      });
    }
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || !context || busy) return;
      setBusy(true);
      setDraft("");
      const started = performance.now();
      const ready = model.status === "ready";

      // Keywords first: instant, predictable, and right for most phrasings.
      // The model routes only what keywords cannot place.
      let intent = keywordRoute(q, context.selected !== null);
      let routedBy: Turn["routedBy"] = "keywords";
      if (ready && intent.kind === "unsupported") {
        try {
          const routed = await llm.route(q);
          if (routed) {
            intent = routed;
            routedBy = "model";
          }
        } catch {
          // Keep the keyword route; the answer states what it answered.
        }
      }

      const result = computeAnswer(intent, context);
      let wording: string | null = null;
      let rejected: string | null = null;
      if (ready && intent.kind !== "unsupported") {
        try {
          const text = await llm.word(q, result);
          if (text) {
            const verdict = verifyWording(text, result, q);
            if (verdict.ok) wording = text;
            else rejected = verdict.reason ?? "it failed the check";
          }
        } catch {
          rejected = "the model failed while writing";
        }
      }

      setTurns((t) => [
        ...t,
        {
          id: nextId.current++,
          question: q,
          answer: result,
          routedBy,
          wording,
          rejected,
          seconds: (performance.now() - started) / 1000,
        },
      ]);
      setBusy(false);
    },
    [busy, context, model.status],
  );

  const suggestions = context?.selected
    ? ["Why was the open location classified this way?", ...SUGGESTIONS]
    : SUGGESTIONS;

  return (
    <div className="ask">
      <div className="ask__intro">
        <p>
          Ask about the data in plain words. Every answer is computed from the loaded
          detections; nothing is guessed.
        </p>
        <ModelCard state={model} onLoad={loadModel} />
      </div>

      <div className="ask__turns">
        {turns.length === 0 && (
          <div className="ask__suggestions">
            {suggestions.map((s) => (
              <button
                type="button"
                key={s}
                className="ask__chip"
                disabled={!context || busy}
                onClick={() => void ask(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} onShow={onShow} />
        ))}

        {busy && (
          <p className="ask__busy">
            {model.status === "ready" ? "Computing, then wording on this device…" : "Computing…"}
          </p>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="ask__form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(draft);
        }}
      >
        <input
          className="ask__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={context ? "e.g. vegetation fires in the last 3 days" : "Loading locations…"}
          disabled={!context || busy}
          aria-label="Ask a question about the data"
        />
        <button type="submit" className="ask__send" disabled={!context || busy || !draft.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}

function ModelCard({ state, onLoad }: { state: ModelState; onLoad: () => void }) {
  switch (state.status) {
    case "checking":
      return null;
    case "unsupported":
      return (
        <p className="ask__model ask__model--muted">
          The optional on-device model is not available here: {state.reason} Questions still
          work, answered directly from the data.
        </p>
      );
    case "idle":
      return (
        <div className="ask__model">
          <p>
            <strong>Optional:</strong> load {llm.MODEL_NAME} to word answers and understand
            unusual phrasing. It runs entirely in this browser; nothing you type leaves the
            device. The first load downloads about {llm.MODEL_DOWNLOAD_MB} MB and can take
            several minutes.
          </p>
          <button type="button" className="ask__load" onClick={onLoad}>
            Load model ({llm.MODEL_DOWNLOAD_MB} MB)
          </button>
        </div>
      );
    case "loading":
      return (
        <div className="ask__model">
          <div className="ask__progress" aria-label="Model loading progress">
            <span style={{ width: `${Math.round(state.fraction * 100)}%` }} />
          </div>
          <p className="ask__model--muted">{state.text}</p>
        </div>
      );
    case "ready":
      return (
        <p className="ask__model ask__model--ready">
          ● {llm.MODEL_NAME} is running on this device.
        </p>
      );
    case "error":
      return (
        <div className="ask__model">
          <p className="ask__model--error">The model failed to load: {state.message}</p>
          <button type="button" className="ask__load" onClick={onLoad}>
            Try again
          </button>
        </div>
      );
  }
}

function TurnView({ turn, onShow }: { turn: Turn; onShow: (mark: MapMark) => void }) {
  const { answer } = turn;
  return (
    <div className="turn">
      <p className="turn__question">{turn.question}</p>
      <div className="turn__answer">
        <p className="turn__routed">
          Answered: <strong>{answer.title}</strong>
          <span className="turn__meta">
            {" "}· understood by {turn.routedBy === "model" ? "the model" : "keywords"} ·{" "}
            {turn.seconds.toFixed(1)} s
          </span>
        </p>

        <p className="turn__text">{turn.wording ?? answer.summary}</p>

        <p className={`turn__badge ${turn.wording ? "turn__badge--model" : ""}`}>
          {turn.wording
            ? "Worded by the on-device model, checked against the data."
            : turn.rejected
              ? `Model wording withheld: ${turn.rejected}. Showing the computed answer.`
              : "Computed answer."}
        </p>

        {answer.items.length > 0 && (
          <ol className="turn__items">
            {answer.items.map((item) => (
              <li key={item.mark.id}>
                <span className={`dot dot--${item.mark.label}`} aria-hidden="true" />
                <span className="turn__line">{item.line}</span>
                <button type="button" className="turn__show" onClick={() => onShow(item.mark)}>
                  Show
                </button>
              </li>
            ))}
          </ol>
        )}

        {answer.facts.length > 0 && (
          <details className="turn__facts">
            <summary>What this answer is based on ({answer.facts.length})</summary>
            <ul>
              {answer.facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
