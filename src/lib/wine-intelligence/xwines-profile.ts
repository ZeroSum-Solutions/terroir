// Taste profile, food pairings and community rating for a wine, read from the
// X-Wines reference corpus (0131_xwines_catalog.sql; CC0-1.0).
//
// The cellar stores no column anywhere for how a wine tastes. Everything this
// module returns is corpus data about a producer's cuvée, attached at the
// shared-catalog grain, never written back onto a tenant's `wines` row.
//
// ── THE ACCEPTANCE RULE, AND THE MEASUREMENTS BEHIND IT ────────────────────
//
// A wine reaches the corpus one of two ways: an explicit
// `canonical_wines.xwines_wine_id` link (trusted outright — a human or a
// deliberate linking pass put it there), or a live trigram match. Only the
// second needs a rule, and it needs a strict one: enriching a wine with the
// WRONG entry means telling a sommelier this bottle is high-acid and pairs
// with shellfish when it is neither. A miss shows nothing; a false positive
// lies. So this is tuned for precision and accepts losing real matches.
//
// Measured on this repo's own 250-wine seed cellar, whose producers are
// invented ("Juniper Vale", "Hollow Hill") and therefore CANNOT legitimately
// match a real-world corpus — a clean negative set:
//
//   match_xwines default threshold (0.30)   124 of 250 matched  (49.6% wrong)
//   blended score >= 0.50                     7 of 250
//   blended score >= 0.65                     0 of 250   (highest FP: 0.552)
//   producer >= 0.80 AND score >= 0.65        0 of 250
//
// The blended score alone is not sufficient, because an exactly-matching cuvée
// name drags a wrong producer over the line:
//
//   "Bodegas Muga" / "Reserva"  -> Borsao Bodegas / Reserva
//                                  score 0.667, producer only 0.444   WRONG
//   "Chateau Margaux" / "Margaux" -> Château Confidence de Margaux / Margaux
//                                  score 0.644, producer only 0.406   WRONG
//
// Hence the independent producer floor. Against known-correct pairs it keeps
// what it should: Penfolds/Koonunga Hill 1.000, Domaine Leflaive 1.000,
// Ridge/Monte Bello 1.000, Penfolds with a stray vintage in the name 0.943,
// E. Guigal/Côtes-du-Rhône 0.744 (producer 1.000).
//
// It is deliberately lossy. "Dom Perignon" / "Vintage Brut" scores 0.462
// against the corpus's "Brut Champagne" — right producer, differently-named
// cuvée — and is rejected. Showing nothing there is the correct outcome under
// this rule; widening it to catch that case re-admits Borsao.
//
// These are FITTED engineering defaults on one negative set, not sealed
// acceptance evidence. Re-derive them against a real partner cellar when one
// exists — that measurement is the one that matters, and it is still blocked
// on the partner CSV (see docs/plans/2026-08-25-spike-04-corpus-join-rates.md).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/** Blended-score floor. Highest false positive on the seed cellar was 0.552. */
export const XWINES_SCORE_FLOOR = 0.65;
/** Independent producer-similarity floor. Rejects Borsao-for-Muga at 0.444. */
export const XWINES_PRODUCER_FLOOR = 0.8;

// ── Taste axes ─────────────────────────────────────────────────────────────
//
// The corpus carries exactly two of the four axes a taste display conventionally
// shows: body and acidity. It carries NOTHING for tannin or sweetness, so this
// module returns nothing for them and callers must render only what they get.
// Inferring "Dessert type therefore sweet" would be a guess wearing the costume
// of a measurement.

/** Corpus `Body` values, in order, with their position on a Light↔Bold axis. */
const BODY_SCALE: ReadonlyMap<string, number> = new Map([
  ["Very light-bodied", 0.1],
  ["Light-bodied", 0.3],
  ["Medium-bodied", 0.5],
  ["Full-bodied", 0.75],
  ["Very full-bodied", 0.95],
]);

/** Corpus `Acidity` values with their position on a Soft↔Acidic axis. */
const ACIDITY_SCALE: ReadonlyMap<string, number> = new Map([
  ["Low", 0.15],
  ["Medium", 0.5],
  ["High", 0.85],
]);

export type TasteAxis = {
  /** Axis endpoints, low to high — e.g. "Light" / "Bold". */
  low: string;
  high: string;
  /** Where this wine sits, 0–1. */
  position: number;
  /** The corpus's own word for it, shown so the number is never the only claim. */
  label: string;
};

export function bodyAxis(body: string | null): TasteAxis | null {
  if (body === null) return null;
  const position = BODY_SCALE.get(body);
  if (position === undefined) return null;
  return { low: "Light", high: "Bold", position, label: body };
}

export function acidityAxis(acidity: string | null): TasteAxis | null {
  if (acidity === null) return null;
  const position = ACIDITY_SCALE.get(acidity);
  if (position === undefined) return null;
  return { low: "Soft", high: "Acidic", position, label: `${acidity} acidity` };
}

// ── Profile ────────────────────────────────────────────────────────────────

export type XWinesProfile = {
  wineId: number;
  /** The corpus's name for what we matched, so a reader can see what we read. */
  matchedName: string;
  matchedWinery: string | null;
  /** "linked" = an explicit canonical_wines link; "matched" = trigram, this run. */
  provenance: "linked" | "matched";
  /** Blended match score; null when the link was explicit rather than matched. */
  matchScore: number | null;
  type: string | null;
  elaborate: string | null;
  grapes: string[];
  pairings: string[];
  abv: number | null;
  body: TasteAxis | null;
  acidity: TasteAxis | null;
  regionName: string | null;
  country: string | null;
  website: string | null;
  vintages: number[];
  hasNonVintage: boolean;
  ratingAvg: number | null;
  ratingCount: number;
};

export type VintageRating = {
  vintage: number;
  ratingAvg: number;
  ratingCount: number;
};

// One literal: supabase-js infers the row type from the literal, and string
// concatenation degrades it to GenericStringError.
const CATALOG_COLUMNS =
  "wine_id, name, winery_name, type, elaborate, grapes, harmonize, abv, body, acidity, region_name, country, website, vintages, has_non_vintage, rating_avg, rating_count" as const;

// The PROJECTION, not the whole row: CATALOG_COLUMNS deliberately omits the
// join keys (country_code, region_id, winery_id) that nothing here reads, and
// typing against the full Row would quietly promise fields that were never
// selected.
type CatalogRow = Pick<
  Database["public"]["Tables"]["xwines_catalog"]["Row"],
  | "wine_id"
  | "name"
  | "winery_name"
  | "type"
  | "elaborate"
  | "grapes"
  | "harmonize"
  | "abv"
  | "body"
  | "acidity"
  | "region_name"
  | "country"
  | "website"
  | "vintages"
  | "has_non_vintage"
  | "rating_avg"
  | "rating_count"
>;

function toProfile(
  row: CatalogRow,
  provenance: XWinesProfile["provenance"],
  matchScore: number | null,
): XWinesProfile {
  return {
    wineId: row.wine_id,
    matchedName: row.name,
    matchedWinery: row.winery_name,
    provenance,
    matchScore,
    type: row.type,
    elaborate: row.elaborate,
    grapes: row.grapes ?? [],
    pairings: row.harmonize ?? [],
    abv: row.abv,
    body: bodyAxis(row.body),
    acidity: acidityAxis(row.acidity),
    regionName: row.region_name,
    country: row.country,
    website: row.website,
    vintages: row.vintages ?? [],
    hasNonVintage: row.has_non_vintage,
    ratingAvg: row.rating_avg,
    ratingCount: row.rating_count,
  };
}

async function fetchCatalogRow(
  supabase: SupabaseClient<Database>,
  wineId: number,
): Promise<CatalogRow | null> {
  const { data, error } = await supabase
    .from("xwines_catalog")
    .select(CATALOG_COLUMNS)
    .eq("wine_id", wineId)
    .maybeSingle();
  if (error) {
    console.error("xwines: catalog row fetch failed:", error);
    return null;
  }
  return data ?? null;
}

export type ResolveXWinesProfileInput = {
  supabase: SupabaseClient<Database>;
  /** From `wines.canonical_wine_id`; when set, its link is preferred. */
  canonicalWineId: string | null;
  producer: string | null;
  name: string;
};

/**
 * Resolve a wine to its corpus entry, or null when nothing clears the bar.
 *
 * Null is an ordinary, expected outcome — the corpus is consumer-review breadth
 * and a cellar skews to trade bottlings, so most wines will not be in it. A
 * caller must render "we don't have this" rather than an empty profile.
 */
export async function resolveXWinesProfile(
  input: ResolveXWinesProfileInput,
): Promise<XWinesProfile | null> {
  const { supabase, canonicalWineId, producer, name } = input;

  if (canonicalWineId !== null) {
    const { data: canonical, error: canonicalError } = await supabase
      .from("canonical_wines")
      .select("xwines_wine_id")
      .eq("id", canonicalWineId)
      .maybeSingle();
    if (canonicalError) {
      console.error("xwines: canonical link lookup failed:", canonicalError);
    }

    const linkedId = canonical?.xwines_wine_id ?? null;
    if (linkedId !== null) {
      const row = await fetchCatalogRow(supabase, linkedId);
      if (row) return toProfile(row, "linked", null);
    }
  }

  // No link. Fall back to a live match, under the strict rule documented above.
  if (producer === null || producer.trim() === "" || name.trim() === "") {
    return null;
  }

  const { data: matches, error: matchError } = await supabase.rpc("match_xwines", {
    p_producer: producer,
    p_name: name,
  });
  if (matchError) {
    // Enrichment is decorative — a failure must not take the page down — but it
    // must not be indistinguishable from "this wine isn't in the corpus" either,
    // or a broken grant looks exactly like a legitimate miss forever.
    console.error("xwines: match_xwines failed:", matchError);
    return null;
  }

  const best = matches?.[0];
  if (!best) return null;
  if (best.score < XWINES_SCORE_FLOOR) return null;
  if (best.producer_score < XWINES_PRODUCER_FLOOR) return null;

  const row = await fetchCatalogRow(supabase, best.wine_id);
  if (!row) return null;

  return toProfile(row, "matched", best.score);
}

/**
 * Per-vintage ratings for a corpus wine, best-rated first.
 *
 * A vintage with no ratings has no row — absence means "no ratings yet", which
 * a caller must say rather than render as a zero.
 */
export async function fetchVintageRatings(
  supabase: SupabaseClient<Database>,
  wineId: number,
  limit = 12,
): Promise<VintageRating[]> {
  const { data } = await supabase
    .from("xwines_vintage_ratings")
    .select("vintage, rating_avg, rating_count")
    .eq("wine_id", wineId)
    .order("rating_count", { ascending: false })
    .limit(limit);

  return (data ?? [])
    .map((row) => ({
      vintage: row.vintage,
      ratingAvg: row.rating_avg,
      ratingCount: row.rating_count,
    }))
    .sort((a, b) => b.vintage - a.vintage);
}
