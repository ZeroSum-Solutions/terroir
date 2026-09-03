/**
 * What somebody outside this restaurant has published about one wine.
 *
 * The second of the three composable resolvers in §4.2 of
 * docs/superpowers/specs/2026-09-03-wine-page-design.md.
 *
 * WHY THE DRINK WINDOW LIVES HERE
 * -------------------------------
 * Its value and its basis both come from the sourced/override side, so putting
 * it in the cellar resolver would make a cellar resolver quietly reach for
 * reference data to compute a badge — which would make the composable split a
 * fiction (§4.2). Everything that needs Drink-now, the scan card included,
 * awaits this resolver.
 *
 * WHY `wines.drink_window_start` IS NOT TRUSTED ON ITS OWN
 * -------------------------------------------------------
 * Only two things can produce a window this page will render: somebody here set
 * it by hand, or a published source states it. So an override reads the wine
 * row (that IS the house's statement), and everything else reads the reference
 * table, which carries the name, url and fetch date a `sourced` basis requires.
 * A row whose basis is 'inferred' — or absent, which is every pre-0148 row —
 * yields nothing. There is deliberately no "estimate" basis to put it behind:
 * an invented window is removed, not captioned.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { Basis, Score, Sourced } from "@/lib/provenance/sourced";
import type { TasteAxis, XWinesProfile } from "@/lib/wine-intelligence/xwines-profile";
import { resolveRestaurantMemberNames } from "@/lib/team/restaurant-member-names";

export type DrinkWindow = { start: number; end: number };

/** The two axes X-Wines actually carries. It holds nothing for tannin or sweetness. */
export type CorpusStructure = { body: TasteAxis | null; acidity: TasteAxis | null };

export type ReferenceWine = {
  canonicalWineId: string | null;
  vintage: number | null;
  drinkWindowStart: number | null;
  drinkWindowEnd: number | null;
  drinkWindowBasis: string | null;
  drinkWindowSetBy: string | null;
  drinkWindowSetAt: string | null;
};

export type ReferenceNoteRow = {
  vintage: number;
  source_kind: string;
  source_name: string;
  source_url: string;
  fetched_at: string;
  body: string | null;
  score: number | null;
  score_scale: number | null;
  drink_window_start: number | null;
  drink_window_end: number | null;
};

export type ReferenceProfile = {
  window: Sourced<DrinkWindow> | null;
  score: Sourced<Score> | null;
  notes: Sourced<string>[];
  structure: Sourced<CorpusStructure> | null;
};

/** A producer talking about their own wine outranks a shop's listing copy. */
const KIND_ORDER = ["producer", "importer", "retailer"];

function sourcedBasis(row: ReferenceNoteRow): Basis {
  return {
    kind: "sourced",
    name: row.source_name,
    url: row.source_url,
    asOf: row.fetched_at,
  };
}

/**
 * The selection rules, pure, so every "what may this page claim a source for"
 * decision is testable without a database.
 */
export function selectReferenceProfile({
  wine,
  rows,
  profile,
  overrideAuthorName,
}: {
  wine: ReferenceWine;
  rows: ReferenceNoteRow[];
  profile: XWinesProfile | null;
  overrideAuthorName: string | null;
}): ReferenceProfile {
  // Every reference row is vintage-specific by design (D12), so a wine with no
  // vintage matches none of them and must not borrow one.
  const matching =
    wine.vintage === null ? [] : rows.filter((row) => row.vintage === wine.vintage);

  const ordered = [...matching].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.source_kind) - KIND_ORDER.indexOf(b.source_kind) ||
      a.source_name.localeCompare(b.source_name),
  );

  return {
    window: selectWindow(wine, ordered, overrideAuthorName),
    score: selectScore(ordered),
    notes: ordered
      // A null or blank body would render as an empty blockquote with a
      // source line under it — a citation for nothing.
      .filter((row): row is ReferenceNoteRow & { body: string } => Boolean(row.body?.trim()))
      .map((row) => ({ value: row.body.trim(), basis: sourcedBasis(row) })),
    structure: selectStructure(profile),
  };
}

function selectWindow(
  wine: ReferenceWine,
  rows: ReferenceNoteRow[],
  overrideAuthorName: string | null,
): Sourced<DrinkWindow> | null {
  if (wine.drinkWindowBasis === "override") {
    // 0148 backfills this basis from `manual_overrides`, a text[] that can name
    // drink_window while the year columns stayed null. An override with no
    // years is a claim with no value in it.
    if (wine.drinkWindowStart === null || wine.drinkWindowEnd === null) return null;
    return {
      value: { start: wine.drinkWindowStart, end: wine.drinkWindowEnd },
      basis: {
        kind: "override",
        // A colleague who has left, or whose name will not resolve right now,
        // is still a person. "Set by someone here" tells the reader the thing
        // that matters: a palate decided this, not a model.
        by: overrideAuthorName ?? "someone here",
        at: wine.drinkWindowSetAt ?? "",
      },
    };
  }

  const sourcedRow = rows.find(
    (row) => row.drink_window_start !== null && row.drink_window_end !== null,
  );
  if (!sourcedRow) return null;

  return {
    value: { start: sourcedRow.drink_window_start!, end: sourcedRow.drink_window_end! },
    basis: sourcedBasis(sourcedRow),
  };
}

function selectScore(rows: ReferenceNoteRow[]): Sourced<Score> | null {
  const scored = rows.filter(
    (row): row is ReferenceNoteRow & { score: number; score_scale: number } =>
      row.score !== null && row.score_scale !== null,
  );
  if (scored.length === 0) return null;

  // One named source, never a blend. Averaging a producer's 92 with a
  // retailer's 88 produces a 90 nobody published, under a basis whose shape
  // can only name one url. Most recently fetched wins; the name breaks ties so
  // two renders of identical data agree.
  const best = scored.reduce((winner, row) =>
    row.fetched_at > winner.fetched_at ||
    (row.fetched_at === winner.fetched_at && row.source_name < winner.source_name)
      ? row
      : winner,
  );

  return {
    value: { n: best.score, scale: best.score_scale === 5 ? 5 : 100 },
    basis: sourcedBasis(best),
  };
}

function selectStructure(profile: XWinesProfile | null): Sourced<CorpusStructure> | null {
  if (!profile) return null;
  // Null rather than an empty structure: an empty one renders a heading over
  // nothing, which reads as a failed load rather than an absent fact.
  if (profile.body === null && profile.acidity === null) return null;
  return {
    value: { body: profile.body, acidity: profile.acidity },
    basis: { kind: "corpus", name: "X-Wines" },
  };
}

export async function resolveReferenceProfile(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  wine: ReferenceWine,
  profile: XWinesProfile | null,
): Promise<ReferenceProfile> {
  const [rows, overrideAuthorName] = await Promise.all([
    fetchReferenceRows(supabase, wine),
    resolveOverrideAuthor(supabase, restaurantId, wine),
  ]);
  return selectReferenceProfile({ wine, rows, profile, overrideAuthorName });
}

async function fetchReferenceRows(
  supabase: SupabaseClient<Database>,
  wine: ReferenceWine,
): Promise<ReferenceNoteRow[]> {
  // No canonical identity or no vintage means nothing can match, so the query
  // is skipped rather than run to return zero rows.
  if (wine.canonicalWineId === null || wine.vintage === null) return [];

  const { data, error } = await supabase
    .from("wine_reference_notes")
    .select(
      "vintage, source_kind, source_name, source_url, fetched_at, body, score, score_scale, drink_window_start, drink_window_end",
    )
    .eq("canonical_wine_id", wine.canonicalWineId)
    .eq("vintage", wine.vintage);

  // The vintage filter is applied in SQL AND again in selectReferenceProfile.
  // Deliberate: the pure rule is what the tests pin, and a future caller that
  // hands over rows from elsewhere inherits the same containment.
  if (error) throw error;
  return data ?? [];
}

async function resolveOverrideAuthor(
  supabase: SupabaseClient<Database>,
  restaurantId: string,
  wine: ReferenceWine,
): Promise<string | null> {
  if (wine.drinkWindowBasis !== "override" || wine.drinkWindowSetBy === null) return null;
  const names = await resolveRestaurantMemberNames(supabase, restaurantId, [
    wine.drinkWindowSetBy,
  ]);
  return names.get(wine.drinkWindowSetBy) ?? null;
}
