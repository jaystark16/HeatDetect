import { useEffect, useRef, useState } from "react";

import { ApiError, api } from "../api";
import type { SearchMatch } from "../types";

interface Props {
  /** Disabled with an explanation when the API is unreachable. */
  disabled: boolean;
  onPick: (match: SearchMatch) => void;
}

/** Long enough to avoid a request per keystroke, short enough to feel live. */
const DEBOUNCE_MS = 250;

const KIND_LABEL: Record<SearchMatch["kind"], string> = {
  coordinates: "Coordinates",
  facility: "Facility",
  detection: "Detection",
};

/**
 * Search over coordinates and mapped facility names.
 *
 * Deliberately narrow. The searchable universe is decimal coordinates and the
 * OSM facilities table, so those are the only two things offered. A fuzzy
 * free-text box over data this sparse would mostly return confident-looking
 * near-misses, and the backend returns an explanatory note instead of a guess.
 *
 * Requires the API: facility names live in the database, not in the cached
 * snapshot. When the API is down the input is disabled and says so, rather than
 * silently returning nothing and looking broken.
 */
export default function SearchBox({ disabled, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Choosing a result rewrites the input, which would otherwise re-run the
  // search and pop the list open again straight after the user dismissed it.
  const suppressNextLookup = useRef(false);

  // Debounced lookup. Each new query aborts the one in flight, so a slow
  // earlier response cannot overwrite the results for what was typed later.
  useEffect(() => {
    if (suppressNextLookup.current) {
      suppressNextLookup.current = false;
      return;
    }

    const trimmed = query.trim();
    if (disabled || trimmed.length === 0) {
      setMatches([]);
      setNote(null);
      setOpen(false);
      return;
    }

    const timer = window.setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);

      void api
        .search(trimmed, controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setMatches(response.matches);
          setNote(response.note);
          setOpen(true);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setMatches([]);
          // Report what actually happened. An earlier version showed
          // "could not be reached" for every failure, which was wrong and
          // actively misleading when the API replied with a 404.
          setNote(
            cause instanceof ApiError && cause.status
              ? `Search failed: the API returned ${cause.status}.`
              : "Search is unavailable because the API could not be reached.",
          );
          setOpen(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query, disabled]);

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

  const choose = (match: SearchMatch) => {
    onPick(match);
    abortRef.current?.abort();
    suppressNextLookup.current = true;
    setQuery(match.label);
    setOpen(false);
  };

  return (
    <div className="search" ref={containerRef}>
      <input
        className="search__input"
        type="search"
        value={query}
        disabled={disabled}
        placeholder={
          disabled ? "Search needs the API" : "Coordinates or facility name"
        }
        title={
          disabled
            ? "Facility names come from the database, which is not in the cached snapshot."
            : "e.g. 23.755, 86.405 — or Belpahar"
        }
        aria-label="Search by coordinates or facility name"
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => {
          if (matches.length > 0 || note) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches.length > 0) choose(matches[0]);
        }}
      />

      {busy && <span className="search__busy">…</span>}

      {open && (
        <div className="search__results" role="listbox">
          {matches.map((match) => (
            <button
              type="button"
              role="option"
              aria-selected="false"
              key={`${match.kind}-${match.label}-${match.latitude}-${match.longitude}`}
              className="search__result"
              onClick={() => choose(match)}
            >
              <span className="search__kind">{KIND_LABEL[match.kind]}</span>
              <span className="search__label">{match.label}</span>
              <span className="search__coords">
                {match.latitude.toFixed(3)}, {match.longitude.toFixed(3)}
              </span>
              {match.detail && (
                <span className="search__detail">{match.detail}</span>
              )}
            </button>
          ))}

          {matches.length === 0 && note && (
            <p className="search__note">{note}</p>
          )}
        </div>
      )}
    </div>
  );
}
