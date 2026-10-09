import { useCallback, useEffect, useRef, useState } from "react";

import type { Fact } from "../assistant/briefing";
import {
  askAgent,
  GEMINI_CONFIGURED,
  type Depth,
  type Exchange,
  type GeminiAnswer,
} from "../assistant/gemini";
import {
  answer as computeAnswer,
  keywordRoute,
  type Answer,
  type AskContext,
} from "../assistant/intents";
import * as llm from "../assistant/llm";
import { verifyWording, type CitedVerdict } from "../assistant/verify";
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

interface GeminiTurn {
  kind: "gemini";
  id: number;
  question: string;
  result: GeminiAnswer;
  facts: Fact[];
}

interface LocalTurn {
  kind: "local";
  id: number;
  question: string;
  answer: Answer;
  routedBy: "keywords" | "model";
  /** On-device wording that passed the gate; null means the computed answer is shown. */
  wording: string | null;
  rejected: string | null;
  /** Why Gemini was not used, when it was configured but failed. */
  geminiFailure: string | null;
  seconds: number;
}

type Turn = GeminiTurn | LocalTurn;

/** The conversation as the user saw it, so follow-ups make sense to Gemini. */
function toHistory(turns: Turn[]): Exchange[] {
  return turns.map((t) => ({
    question: t.question,
    answer:
      t.kind === "gemini"
        ? [...t.result.answer, ...t.result.analysis]
            .filter((v) => v.ok)
            .map((v) => v.sentence.text)
            .join(" ") || "(no answer shown)"
        : (t.wording ?? t.answer.summary),
  }));
}

/** Replies that accept the offer of a deeper analysis. */
const AFFIRMATIVE =
  /^(y|yes|yeah|yep|yup|sure|ok|okay|please|go ahead|go deep|go deeper|deeper|deep|deep research|tell me more|more|explain|explain more|elaborate)[\s.!?]*$/i;

const SUGGESTIONS = [
  "Give me an overall analysis of what the data shows",
  "What was detected in the last 24 hours?",
  "Which industrial sources are the most persistent, and what stands out?",
  "Where is activity concentrated?",
  "How far can I trust these classifications?",
  "How current is this data?",
];

/**
 * Questions about the data, answered by Gemini from facts the page computes.
 *
 * Gemini sees a numbered briefing of the real data and the system's own
 * analysis, and must cite those numbers in every sentence; each sentence is
 * checked against its citations and withheld if it does not hold. When Gemini
 * cannot be reached, the on-device model or the computed answer takes over,
 * and the page says which. ADR 0008.
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

  /** Computed answer, optionally worded on-device. Used when Gemini is not. */
  const askLocally = useCallback(
    async (q: string, ctx: AskContext, geminiFailure: string | null): Promise<LocalTurn> => {
      const started = performance.now();
      const ready = llm.isLoaded();
      let intent = keywordRoute(q, ctx.selected !== null);
      let routedBy: LocalTurn["routedBy"] = "keywords";
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
      const result = computeAnswer(intent, ctx);
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
      return {
        kind: "local",
        id: nextId.current++,
        question: q,
        answer: result,
        routedBy,
        wording,
        rejected,
        geminiFailure,
        seconds: (performance.now() - started) / 1000,
      };
    },
    [],
  );

  const ask = useCallback(
    async (question: string, forceDepth?: Depth) => {
      let q = question.trim();
      if (!q || !context || busy) return;

      // "yes", "go deeper", "tell me more" after a short answer means: the
      // deep version of the previous question.
      let depth: Depth = forceDepth ?? "brief";
      const last = turns[turns.length - 1];
      if (!forceDepth && last?.kind === "gemini" && last.result.depth === "brief" && AFFIRMATIVE.test(q)) {
        q = last.question;
        depth = "deep";
      }

      setBusy(true);
      setDraft("");

      let turn: Turn;
      if (GEMINI_CONFIGURED) {
        try {
          const result = await askAgent(q, context, toHistory(turns), depth);
          turn = {
            kind: "gemini",
            id: nextId.current++,
            question: q,
            result,
            facts: result.facts,
          };
        } catch (cause) {
          turn = await askLocally(
            q,
            context,
            cause instanceof Error ? cause.message : "Gemini could not answer.",
          );
        }
      } else {
        turn = await askLocally(q, context, null);
      }

      setTurns((t) => [...t, turn]);
      setBusy(false);
    },
    [askLocally, busy, context, turns],
  );

  const suggestions = context?.selected
    ? ["Analyse the open location: why was it classified this way?", ...SUGGESTIONS]
    : SUGGESTIONS;

  return (
    <div className="ask">
      <div className="ask__intro">
        {GEMINI_CONFIGURED ? (
          <p>
            Short, cited answers by <strong>Google Gemini</strong>, checked against the
            data. Questions are sent to Google’s Gemini service.
          </p>
        ) : (
          <p>
            Ask about the data in plain words. Every answer is computed from the loaded
            detections; nothing is guessed.
          </p>
        )}
        <ModelCard state={model} onLoad={loadModel} fallbackOnly={GEMINI_CONFIGURED} />
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

        {turns.map((turn) =>
          turn.kind === "gemini" ? (
            <GeminiTurnView key={turn.id} turn={turn} onShow={onShow} onAsk={ask} busy={busy} />
          ) : (
            <LocalTurnView key={turn.id} turn={turn} onShow={onShow} />
          ),
        )}

        {busy && (
          <p className="ask__busy">
            {GEMINI_CONFIGURED
              ? "Gemini is analysing the briefing…"
              : model.status === "ready"
                ? "Computing, then wording on this device…"
                : "Computing…"}
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
          placeholder={context ? "Ask anything about the data" : "Loading locations…"}
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

function ModelCard({
  state,
  onLoad,
  fallbackOnly,
}: {
  state: ModelState;
  onLoad: () => void;
  fallbackOnly: boolean;
}) {
  const label = fallbackOnly ? "Offline fallback" : "Optional";
  switch (state.status) {
    case "checking":
      return null;
    case "unsupported":
      return fallbackOnly ? null : (
        <p className="ask__model ask__model--muted">
          The optional on-device model is not available here: {state.reason} Questions still
          work, answered directly from the data.
        </p>
      );
    case "idle":
      return (
        <details className="ask__model">
          <summary>
            <strong>{label}:</strong> an on-device model, if Gemini cannot be reached
          </summary>
          <p>
            {llm.MODEL_NAME} runs entirely in this browser and is used only when Gemini is
            unavailable. The first load downloads about {llm.MODEL_DOWNLOAD_MB} MB and takes
            several minutes.
          </p>
          <button type="button" className="ask__load" onClick={onLoad}>
            Load model ({llm.MODEL_DOWNLOAD_MB} MB)
          </button>
        </details>
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
          ● {llm.MODEL_NAME} is loaded on this device{fallbackOnly ? " as the offline fallback" : ""}.
        </p>
      );
    case "error":
      return (
        <div className="ask__model">
          <p className="ask__model--error">The on-device model failed to load: {state.message}</p>
          <button type="button" className="ask__load" onClick={onLoad}>
            Try again
          </button>
        </div>
      );
  }
}

function Citations({
  cites,
  facts,
  onShow,
}: {
  cites: number[];
  facts: Fact[];
  onShow: (mark: MapMark) => void;
}) {
  const [open, setOpen] = useState(false);
  const cited = cites.map((c) => facts.find((f) => f.id === c)).filter((f): f is Fact => Boolean(f));
  return (
    <>
      <button
        type="button"
        className={`cite ${open ? "is-open" : ""}`}
        aria-expanded={open}
        title="Show the facts this sentence rests on"
        onClick={() => setOpen((v) => !v)}
      >
        {cites.map((c) => `[${c}]`).join("")}
      </button>
      {open && (
        <span className="cite__facts">
          {cited.map((f) => (
            <span key={f.id} className="cite__fact">
              <b>[{f.id}]</b> {f.text}
              {f.mark && (
                <button type="button" className="turn__show" onClick={() => onShow(f.mark!)}>
                  Show
                </button>
              )}
            </span>
          ))}
        </span>
      )}
    </>
  );
}

function Sentences({
  verdicts,
  facts,
  onShow,
}: {
  verdicts: CitedVerdict[];
  facts: Fact[];
  onShow: (mark: MapMark) => void;
}) {
  const passed = verdicts.filter((v) => v.ok);
  return (
    <p className="turn__text">
      {passed.map((v, i) => (
        <span key={i} className="sentence">
          {v.sentence.text}{" "}
          <Citations cites={v.sentence.cites} facts={facts} onShow={onShow} />{" "}
        </span>
      ))}
    </p>
  );
}

function GeminiTurnView({
  turn,
  onShow,
  onAsk,
  busy,
}: {
  turn: GeminiTurn;
  onShow: (mark: MapMark) => void;
  onAsk: (q: string, depth?: Depth) => void;
  busy: boolean;
}) {
  const { result, facts } = turn;
  const deep = result.depth === "deep";
  const answerShown = result.answer.some((v) => v.ok);
  const withheld = [...result.answer, ...result.analysis, ...result.caveats].filter((v) => !v.ok);
  const fellBack = result.tried.length > 0;

  return (
    <div className="turn">
      <p className="turn__question">{deep ? `Deeper: ${turn.question}` : turn.question}</p>
      <div className="turn__answer">
        <p className="turn__routed">
          <strong>Gemini</strong>
          <span className="turn__meta">
            {" "}· {result.model} · {result.seconds.toFixed(1)} s
            {fellBack && ` · after ${result.tried.length} busy attempt${result.tried.length === 1 ? "" : "s"}`}
          </span>
        </p>

        {result.lookups.length > 0 && (
          <p className="turn__lookups">
            Looked up: {[...new Set(result.lookups)].join("; ")}
          </p>
        )}

        {answerShown ? (
          <Sentences verdicts={result.answer} facts={facts} onShow={onShow} />
        ) : (
          // No substitute answer: a computed answer to a keyword reading of the
          // question can be about something else entirely ("refinery fire in
          // Gujarat" read as "most persistent industrial sources").
          <p className="turn__fallback">
            The data can't establish that
            {result.answer[0]?.reason ? ` (answer withheld: ${result.answer[0].reason})` : ""}.
          </p>
        )}

        {result.analysis.some((v) => v.ok) && (
          <>
            <h4 className="turn__heading">Analysis</h4>
            <Sentences verdicts={result.analysis} facts={facts} onShow={onShow} />
          </>
        )}

        {result.caveats.some((v) => v.ok) && (
          <>
            <h4 className="turn__heading">Caveats</h4>
            <Sentences verdicts={result.caveats} facts={facts} onShow={onShow} />
          </>
        )}

        {!deep && answerShown && (
          <p className="turn__offer">
            Want a deeper analysis?{" "}
            <button
              type="button"
              className="turn__show"
              disabled={busy}
              onClick={() => onAsk(turn.question, "deep")}
            >
              Yes, go deeper
            </button>
          </p>
        )}

        <p className="turn__badge turn__badge--model">
          ✓ Checked against the data
          {withheld.length > 0 && ` · ${withheld.length} withheld`}
        </p>

        {withheld.length > 0 && (
          <details className="turn__facts">
            <summary>Why {withheld.length === 1 ? "a sentence was" : "sentences were"} withheld</summary>
            <ul>
              {withheld.map((v, i) => (
                <li key={i}>{v.reason}</li>
              ))}
            </ul>
          </details>
        )}

        {result.followUps.length > 0 && (
          <div className="ask__suggestions turn__follow">
            {result.followUps.map((q) => (
              <button type="button" key={q} className="ask__chip" disabled={busy} onClick={() => onAsk(q)}>
                {q}
              </button>
            ))}
          </div>
        )}

        <details className="turn__facts">
          <summary>Sources ({facts.length} facts)</summary>
          <ul>
            {facts.map((f) => (
              <li key={f.id}>
                <b>[{f.id}]</b> {f.text}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}

function LocalTurnView({ turn, onShow }: { turn: LocalTurn; onShow: (mark: MapMark) => void }) {
  const { answer } = turn;
  return (
    <div className="turn">
      <p className="turn__question">{turn.question}</p>
      <div className="turn__answer">
        {turn.geminiFailure && (
          <p className="turn__fallback">
            Gemini was not used: {turn.geminiFailure} Answered from the data instead.
          </p>
        )}
        <p className="turn__routed">
          Answered: <strong>{answer.title}</strong>
          <span className="turn__meta">
            {" "}· understood by {turn.routedBy === "model" ? "the on-device model" : "keywords"} ·{" "}
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
              {answer.facts.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
