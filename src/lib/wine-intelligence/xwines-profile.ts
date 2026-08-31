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
// ── THE NAME FLOOR (measured 2026-08-29 against the local 100,646-row corpus)
//
// The producer floor and the blended floor together do not constrain the cuvée
// at all. With producer similarity 1.0 the producer term alone contributes
// 0.6, so ANY cuvée clearing the RPC's own prefilter (p_threshold * 0.7 = 0.21)
// blends to >= 0.684 and is accepted. The right winery's WRONG bottling was
// therefore admitted by construction — and a wrong bottling is not a near-miss,
// it is different grapes, a different body, a different acidity and different
// food pairings, all displayed as fact.
//
// Measured, not chosen by taste. Test set: every winery in xwines_catalog with
// at least two distinct wine names (14,852 wineries), the six lowest wine_ids
// each, all ordered pairs — 199,076 same-producer/different-cuvée pairs. Each
// pair asks the question that matters: our bottle is cuvée A (absent from the
// corpus), the corpus offers sibling B, how similar do their names score?
//
//   pairs reaching the RPC's 0.21 cuvée prefilter   71,420  (35.9%)
//   — i.e. servable TODAY: every one of them blends over 0.65 at producer 1.0,
//     so neither existing floor rejects a single one.
//
//   name similarity across those 71,420:
//     p50 0.381   p75 0.511   p90 0.640   p95 0.714   p99 0.821
//
//   share of them a name floor rejects:
//     0.60 -> 86.0%   0.63 -> 89.3%   0.64 -> 90.1%   0.65 -> 90.8%   0.70 -> 94.2%
//
// 0.64 is the LOWEST floor rejecting at least 90% of them, and that is the
// whole derivation — the criterion was fixed before the grid was read.
//
// What it does NOT guarantee: 7,084 of those pairs (9.9%) still clear it.
// Siblings separated by one qualifier — "Reserva" against "Reserva Especial" —
// score above 0.64 and remain admissible. This floor removes the bulk of the
// wrong-cuvée class; it does not close it. Nor is it evidence about how a
// RESTAURANT writes a name: it was measured on corpus-vs-corpus naming, and a
// cellar that abbreviates heavily will lose real matches to it. One already
// known: "E. Guigal" / "Cotes-du-Rhone" scores 0.360 against the corpus's
// accented "Côtes-du-Rhône Rosé" and is now rejected. That is the right
// outcome — the Rosé was the top-1 the old rule served for a red — but it is a
// loss, and the honest description of this floor is that it trades recall for
// not lying.
//
// These are FITTED engineering defaults on one negative set, not sealed
// acceptance evidence. Re-derive them against a real partner cellar when one
// exists — that measurement is the one that matters, and it is still blocked
// on the partner CSV (see docs/plans/2026-08-25-spike-04-corpus-join-rates.md).

import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/** Blended-score floor. Highest false positive on the seed cellar was 0.552. */
export const XWINES_SCORE_FLOOR = 0.65;
/** Independent producer-similarity floor. Rejects Borsao-for-Muga at 0.444. */
export const XWINES_PRODUCER_FLOOR = 0.8;
/**
 * Independent cuvée-similarity floor. Lowest value rejecting >= 90% of the
 * corpus's own 71,420 servable same-producer/different-cuvée pairs.
 */
export const XWINES_NAME_FLOOR = 0.64;

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

// ── Imagery ────────────────────────────────────────────────────────────────
//
// 0138 gave the corpus four image columns and, with them, a rule this module
// has to carry rather than flatten: the picture is not always of this wine.
// There is no open collection of 100,646 wine labels, so what the corpus holds
// is three different strengths of claim, and `kind` is the only thing that
// tells them apart. A caller that renders the URL without reading the kind
// will present a stranger's Chianti as this bottle's label.

/** The corpus's own vocabulary, mirrored from 0138's check constraint. */
const IMAGE_KINDS = ["label", "producer", "representative"] as const;

export type XWinesImageKind = (typeof IMAGE_KINDS)[number];

export type XWinesImage = {
  url: string;
  /**
   * "label" — this wine's own label. "producer" — a real bottle from this
   * producer, a different cuvée. "representative" — a real bottle of the same
   * type and country from an UNRELATED producer, which says nothing about this
   * wine. Only "label" may be shown without saying what it is.
   */
  kind: XWinesImageKind;
  /** 'xwines' | 'openfoodfacts' | 'wikimedia-commons'. */
  source: string;
  /** The attribution line the source asked for; null where it states none. */
  credit: string | null;
};

function isImageKind(value: string): value is XWinesImageKind {
  return (IMAGE_KINDS as readonly string[]).includes(value);
}

/**
 * The image, or nothing.
 *
 * An unrecognised kind returns null rather than defaulting to one. Defaulting
 * down to "representative" would hide a real label; defaulting up to "label"
 * would assert one. 0138's check constraint means this can only fire if the
 * vocabulary grew without this file, and dropping the picture is the correct
 * behaviour for a claim this code cannot read.
 */
export function toImage(row: {
  image_url: string | null;
  image_kind: string | null;
  image_source: string | null;
  image_credit: string | null;
}): XWinesImage | null {
  if (row.image_url === null || row.image_kind === null || row.image_source === null) return null;
  if (!isImageKind(row.image_kind)) return null;
  return {
    url: row.image_url,
    kind: row.image_kind,
    source: row.image_source,
    credit: row.image_credit,
  };
}

// ── Profile ────────────────────────────────────────────────────────────────

export type XWinesProfile = {
  wineId: number;
  /** The corpus's name for what we matched, so a reader can see what we read. */
  matchedName: string;
  matchedWinery: string | null;
  /** "linked" = canonical link; "matched" = trigram; "producer-matched" = image only. */
  provenance: "linked" | "matched" | "producer-matched";
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
  /** A real photograph, when the corpus has one. Read `kind` before showing it. */
  image: XWinesImage | null;
};

export type VintageRating = {
  vintage: number;
  ratingAvg: number;
  ratingCount: number;
};

/**
 * The outcome of a corpus read, with "we could not ask" kept separate from
 * "we asked and there is nothing".
 *
 * Both of those used to arrive as null, so a broken grant, a dropped
 * connection or a revoked policy rendered as the ordinary, reassuring "no
 * reference entry matched" — a claim about the wine made out of a claim about
 * the database. A caller must be able to tell a reader which one happened.
 */
export type CorpusRead<T> =
  | { status: "ok"; value: T }
  | { status: "unavailable" };

/** Every corpus failure is reported the same way before it is handed back. */
function reportCorpusFailure(phase: string, error: unknown, extra: Record<string, unknown>) {
  console.error(`xwines: ${phase} failed:`, error);
  Sentry.captureException(error, {
    tags: { surface: "wine-detail", phase },
    extra,
  });
}

// One literal: supabase-js infers the row type from the literal, and string
// concatenation degrades it to GenericStringError.
const CATALOG_COLUMNS =
  "wine_id, name, winery_name, type, elaborate, grapes, harmonize, abv, body, acidity, region_name, country, website, vintages, has_non_vintage, rating_avg, rating_count, image_url, image_kind, image_source, image_credit" as const;

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
  | "image_url"
  | "image_kind"
  | "image_source"
  | "image_credit"
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
    image: toImage(row),
  };
}

async function fetchCatalogRow(
  supabase: SupabaseClient<Database>,
  wineId: number,
): Promise<CorpusRead<CatalogRow | null>> {
  const { data, error } = await supabase
    .from("xwines_catalog")
    .select(CATALOG_COLUMNS)
    .eq("wine_id", wineId)
    .maybeSingle();
  if (error) {
    reportCorpusFailure("catalog-row-fetch", error, { wineId });
    return { status: "unavailable" };
  }
  return { status: "ok", value: data ?? null };
}

export type ResolveXWinesProfileInput = {
  supabase: SupabaseClient<Database>;
  /** From `wines.canonical_wine_id`; when set, its link is preferred. */
  canonicalWineId: string | null;
  producer: string | null;
  name: string;
};

/**
 * Resolve a wine to its corpus entry.
 *
 * `{ status: "ok", value: null }` is an ordinary, expected outcome — the corpus
 * is consumer-review breadth and a cellar skews to trade bottlings, so most
 * wines will not be in it. `{ status: "unavailable" }` means the corpus could
 * not be read at all, which is a different sentence for a caller to write.
 * Enrichment is decorative, so neither one throws.
 */
export async function resolveXWinesProfile(
  input: ResolveXWinesProfileInput,
): Promise<CorpusRead<XWinesProfile | null>> {
  const { supabase, canonicalWineId, producer, name } = input;

  if (canonicalWineId !== null) {
    const { data: canonical, error: canonicalError } = await supabase
      .from("canonical_wines")
      .select("xwines_wine_id")
      .eq("id", canonicalWineId)
      .maybeSingle();
    // Falling through to the matcher here would answer a question the link had
    // already answered better, and the reader could not tell the two apart.
    if (canonicalError) {
      reportCorpusFailure("canonical-link-lookup", canonicalError, { canonicalWineId });
      return { status: "unavailable" };
    }

    const linkedId = canonical?.xwines_wine_id ?? null;
    if (linkedId !== null) {
      const row = await fetchCatalogRow(supabase, linkedId);
      if (row.status === "unavailable") return row;
      if (row.value) return { status: "ok", value: toProfile(row.value, "linked", null) };
    }
  }

  // No link: live match, strict rule above. Blank producer -> wine-corpus-profile.ts.
  if (producer === null || producer.trim() === "" || name.trim() === "") {
    return { status: "ok", value: null };
  }

  const { data: matches, error: matchError } = await supabase.rpc("match_xwines", {
    p_producer: producer,
    p_name: name,
  });
  if (matchError) {
    reportCorpusFailure("match-xwines", matchError, { producer, name });
    return { status: "unavailable" };
  }

  // The RPC's own bar (cuvée >= threshold * 0.7) is looser than this module's,
  // so it returns several candidates and the first one clearing EVERY floor
  // wins. Taking only its top row would let a rejected leader hide an
  // acceptable runner-up that was never looked at (0134).
  const accepted = (matches ?? []).find(
    (candidate) =>
      candidate.score >= XWINES_SCORE_FLOOR &&
      candidate.producer_score >= XWINES_PRODUCER_FLOOR &&
      candidate.name_score >= XWINES_NAME_FLOOR,
  );
  if (!accepted) return { status: "ok", value: null };

  const row = await fetchCatalogRow(supabase, accepted.wine_id);
  if (row.status === "unavailable") return row;
  if (!row.value) return { status: "ok", value: null };

  return { status: "ok", value: toProfile(row.value, "matched", accepted.score) };
}

/**
 * Per-vintage ratings for a corpus wine, newest vintage first.
 *
 * A vintage with no ratings has no row — absence means "no ratings yet", which
 * a caller must say rather than render as a zero.
 *
 * The window is the `limit` MOST-REVIEWED vintages, because a table of forty
 * years is not a comparison. But `ownVintage` is pinned into it regardless of
 * where it places: a wine with more rated vintages than fit could otherwise
 * drop the reader's own bottle out of a table whose entire purpose is to
 * locate it, and its absence would read as "your vintage has no ratings".
 */
export async function fetchVintageRatings(
  supabase: SupabaseClient<Database>,
  wineId: number,
  ownVintage: number | null = null,
  limit = 12,
): Promise<CorpusRead<VintageRating[]>> {
  const { data, error } = await supabase
    .from("xwines_vintage_ratings")
    .select("vintage, rating_avg, rating_count")
    .eq("wine_id", wineId)
    .order("rating_count", { ascending: false })
    .limit(limit);
  if (error) {
    reportCorpusFailure("vintage-ratings-fetch", error, { wineId });
    return { status: "unavailable" };
  }

  const ratings = (data ?? []).map((row) => ({
    vintage: row.vintage,
    ratingAvg: row.rating_avg,
    ratingCount: row.rating_count,
  }));

  // One extra round trip, and only when the most-reviewed window actually
  // missed the bottle in hand.
  if (ownVintage !== null && !ratings.some((row) => row.vintage === ownVintage)) {
    const { data: own, error: ownError } = await supabase
      .from("xwines_vintage_ratings")
      .select("vintage, rating_avg, rating_count")
      .eq("wine_id", wineId)
      .eq("vintage", ownVintage)
      .maybeSingle();
    if (ownError) {
      reportCorpusFailure("vintage-ratings-own-fetch", ownError, { wineId, ownVintage });
      return { status: "unavailable" };
    }
    if (own) {
      ratings.push({
        vintage: own.vintage,
        ratingAvg: own.rating_avg,
        ratingCount: own.rating_count,
      });
    }
  }

  return {
    status: "ok",
    value: ratings.sort((a, b) => b.vintage - a.vintage),
  };
}
