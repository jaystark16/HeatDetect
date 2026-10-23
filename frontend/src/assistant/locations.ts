/**
 * Which locations to list under an answer.
 *
 * A sentence citing a search's total ("1,602 matches") is about every place
 * that search found, so all of them are listed (the page pages through them
 * and offers a CSV), even when no sentence names them one by one. Observed:
 * "give me those locations" got only the count, then only the two places the
 * previous answer had named.
 *
 * Everything listed comes from what the code computed: the search's own
 * ranked matches, carried on its total fact (tools.ts), never the model's text.
 */

import type { MapMark } from "../types";
import type { Fact } from "./briefing";

export interface LocationList {
  marks: MapMark[];
  /** "All 1,602, ranked by peak fire radiative power", when one search supplied them. */
  heading: string | null;
}

const isSearchTotal = (f: Fact) => f.section.startsWith("lookup:") && Array.isArray(f.matches);

function headingFor(total: Fact): string | null {
  if (!total.matches || !total.ranking) return null;
  const order = total.ranking === "nearest" ? "nearest first" : `ranked ${total.ranking}`;
  return `All ${total.matches.length.toLocaleString()}, ${order}`;
}

export function answerLocations(facts: Fact[], citedIds: number[]): LocationList {
  const cited = facts.filter((f) => citedIds.includes(f.id));
  // A search is listed whole when its total is cited, or when the user asked
  // for the places (listAll) and the answer cites any of its matches.
  const sections = new Set(cited.map((f) => f.section));
  const totals = facts.filter(
    (f) => isSearchTotal(f) && (citedIds.includes(f.id) || (f.listAll === true && sections.has(f.section))),
  );
  const listed = [...cited.filter((f) => f.mark).map((f) => f.mark!), ...totals.flatMap((t) => t.matches!)];
  const marks = [...new Map(listed.map((m) => [m.id, m])).values()];

  // A heading describes one search, so it is shown only when everything listed
  // came from exactly one.
  const only = totals.length === 1 ? totals[0] : null;
  const fromOnly = only && cited.every((f) => !f.mark || only.matches!.some((m) => m.id === f.mark!.id));
  return { marks, heading: only && fromOnly ? headingFor(only) : null };
}
