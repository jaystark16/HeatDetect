/**
 * Which locations to list under an answer.
 *
 * A sentence citing a search's total ("854 matches") is about the matches that
 * search returned, so they are listed even when no sentence cites them one by
 * one. Observed: "give me those locations" got only the count, because the
 * list showed cited locations and the answer cited the total.
 *
 * Everything listed comes from facts the code computed; the heading reads the
 * wording tools.ts writes, which tools.test.ts pins.
 */

import type { MapMark } from "../types";
import type { Fact } from "./briefing";

export interface LocationList {
  marks: MapMark[];
  /** "Top 10 of 854, ranked by distinct days seen", when one search supplied them. */
  heading: string | null;
}

const MAX_LISTED = 25;

const isSearchTotal = (f: Fact) => f.section.startsWith("lookup:") && !f.mark && /^Search of all /.test(f.text);

function headingFor(total: Fact, ranked: Fact[]): string | null {
  const count = total.text.match(/: ([\d,]+) match(?:es)?\b/)?.[1];
  const rank = ranked[0]?.text.match(/^#\d+ (.+?) among those matches:/)?.[1];
  if (!count || !rank) return null;
  const order = rank === "nearest" ? "nearest first" : `ranked ${rank}`;
  // The same search run twice shares a description; count each location once.
  const shown = new Set(ranked.map((f) => f.mark!.id)).size;
  return shown === Number(count.replace(/,/g, ""))
    ? `All ${count}, ${order}`
    : `Top ${shown} of ${count}, ${order}`;
}

export function answerLocations(facts: Fact[], citedIds: number[]): LocationList {
  const cited = facts.filter((f) => citedIds.includes(f.id));
  const totals = cited.filter(isSearchTotal);
  const listed = [
    ...cited.filter((f) => f.mark),
    ...totals.flatMap((t) => facts.filter((g) => g.section === t.section && g.mark)),
  ];
  const marks = [...new Map(listed.map((f) => [f.mark!.id, f.mark!])).values()].slice(0, MAX_LISTED);

  // A heading describes one search, so it is shown only when everything listed
  // came from exactly one.
  const only = totals.length === 1 ? totals[0] : null;
  const heading =
    only && cited.every((f) => !f.mark || f.section === only.section)
      ? headingFor(only, facts.filter((g) => g.section === only.section && g.mark))
      : null;
  return { marks, heading };
}
