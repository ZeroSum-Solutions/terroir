// P1 slice 3b — the catalogue pass for a query that carries FACTS.
//
// WHY THIS EXISTS ALONGSIDE THE RPCs. lwin_search and xwines_search are
// trigram RPCs: they return the N rows most similar to a string. That is the
// right tool for "margaux" and the wrong one for "a crisp white from
// Portugal", which names no wine at all. Worse, filtering a trigram top-N
// AFTER the fact is quietly lossy — the Portuguese white ranked 21st by
// name-similarity is dropped before the filter ever sees it, and the reader
// is told there are none.
//
// So a query carrying filters is answered by filtering the catalogue tables
// directly, where the limit is applied after the facts instead of before
// them. This needs no migration and no new RPC: lwin_catalog (0003) and
// xwines_catalog (0131) are both readable by `authenticated` and are already
// read this way elsewhere (the catalogue detail page, the assistant route).
// It also means the fix works against the schema PRODUCTION ALREADY HAS,
// rather than waiting on a hand-applied migration — which matters, because
// 0145/0146 are not applied there yet (AGENTS #7).
//
// THE TRADE-OFF, stated plainly: the filtered pass matches its text with
// ILIKE, so it does not forgive typos the way trigram does. A query with
// facts in it is narrowed by those facts instead. A fuzzy top-up here is
// additive work if that proves to matter.

import type { requireMembership } from "@/lib/api/auth";
import { bodyRank, type SourcePlan } from "@/lib/unified-search/search-filters";
import type { SearchPreferences } from "@/lib/unified-search/query-parse";
import type { LwinHit, XwinesHit } from "@/lib/unified-search/merge";

type Supabase = Extract<
  Awaited<ReturnType<typeof requireMembership>>,
  { supabase: unknown }
>["supabase"];

export type Degrade = (phase: string, error: unknown, extra: Record<string, unknown>) => void;

/**
 * Every row in a filtered page matched every fact asked for, so there is no
 * similarity to report — they are equally correct answers. What orders them
 * is the order the corpus itself supplied, and the score has to carry that
 * order because mergeUnifiedResults ranks on score and would otherwise
 * re-sort the page by id. It sits below an exact cellar hit (1.0) on
 * purpose: owned beats discoverable (D4).
 */
const FILTERED_MATCH_SCORE = 0.7;
const FILTERED_RANK_SPAN = 0.2;

function scoreByRank(index: number, total: number): number {
  if (total <= 1) return FILTERED_MATCH_SCORE;
  return FILTERED_MATCH_SCORE - (index / (total - 1)) * FILTERED_RANK_SPAN;
}

export async function fetchLwinFiltered(
  supabase: Supabase,
  plan: SourcePlan,
  limit: number,
  degrade: Degrade,
  extra: Record<string, unknown>,
): Promise<LwinHit[]> {
  let query = supabase
    .from("lwin_catalog")
    .select("lwin_id, display_name, producer, region, country, colour, type");

  if (plan.countries.length > 0) query = query.in("country", plan.countries);
  if (plan.colours.length > 0) {
    // The one colour LWIN records on a different column is "Fortified Wine",
    // which lives in `type` — see the colour map in search-filters.ts.
    query =
      plan.colourColumn === "type"
        ? query.in("type", plan.colours)
        : query.in("colour", plan.colours);
  }
  // No vintage predicate: lwin_catalog has no vintage column, because an LWIN
  // row is the wine and not the bottling. That is an absent dimension, not a
  // contradicted one, so the vintage narrows the other sources and this one
  // still answers at the grain it models.
  if (plan.regionOr !== null) query = query.or(plan.regionOr);
  if (plan.textOr !== null) query = query.or(plan.textOr);

  // display_name is the only stable ordering lwin_catalog offers — it carries
  // no popularity or quality signal to rank by. Deterministic beats
  // arbitrary: a re-render must not reshuffle under the reader (0127's rule).
  const { data, error } = await query.order("display_name").order("lwin_id").limit(limit);
  if (error) {
    degrade("lwin-filtered", error, extra);
    return [];
  }

  const rows = data ?? [];
  return rows.map((row, index) => ({
    lwinId: row.lwin_id,
    displayName: row.display_name,
    producer: row.producer,
    region: row.region,
    country: row.country,
    colour: row.colour,
    type: row.type,
    score: scoreByRank(index, rows.length),
  }));
}

export async function fetchXwinesFiltered(
  supabase: Supabase,
  plan: SourcePlan,
  preferences: SearchPreferences,
  limit: number,
  degrade: Degrade,
  extra: Record<string, unknown>,
): Promise<XwinesHit[]> {
  let query = supabase
    .from("xwines_catalog")
    .select("wine_id, name, winery_name, region_name, country, type, image_url, image_kind, body");

  if (plan.countries.length > 0) query = query.in("country", plan.countries);
  if (plan.colours.length > 0) query = query.in("type", plan.colours);
  if (plan.vintages.length > 0) query = query.overlaps("vintages", plan.vintages);
  if (plan.regionOr !== null) query = query.or(plan.regionOr);
  if (plan.textOr !== null) query = query.or(plan.textOr);

  // rating_count is a real signal the corpus supplies: of the wines that match
  // the facts, show the ones most people have actually rated first.
  const { data, error } = await query
    .order("rating_count", { ascending: false })
    .order("wine_id")
    .limit(limit);
  if (error) {
    degrade("xwines-filtered", error, extra);
    return [];
  }

  // The body PREFERENCE reorders this page and never shrinks it (D1). Sorting
  // rather than weighting keeps that visible: there is no threshold here that
  // could quietly become an exclusion.
  const rows = [...(data ?? [])].sort(
    (a, b) => bodyRank(b.body, preferences) - bodyRank(a.body, preferences),
  );
  return rows.map((row, index) => ({
    wineId: row.wine_id,
    name: row.name,
    wineryName: row.winery_name,
    regionName: row.region_name,
    country: row.country,
    type: row.type,
    imageUrl: row.image_kind === "label" ? row.image_url : null,
    score: scoreByRank(index, rows.length),
  }));
}
