// The corpus read for ONE wine, including the wines whose producer is missing.
//
// This wraps `resolveXWinesProfile` rather than editing it. That file's
// acceptance rule is measured, argued and audited in its own header, and the
// change this module needs is not a change to the rule — it is a change to
// what the rule is given. So the rule is left byte-for-byte alone and called
// twice: once with what the row says, once with the producer recovered out of
// the row's own `name` (producer-from-name.ts, and the incident behind it).
//
// ── TWO ACCEPTANCE LEVELS, AND WHY THEY DIFFER ─────────────────────────────
//
// xwines-profile.ts is tuned for one job: never attach the wrong taste. A
// wrong match there tells a sommelier this bottle is high-acid and pairs with
// shellfish when it is neither — "a miss shows nothing; a false positive
// lies". Its three floors stay exactly as measured.
//
// A picture is not that. corpus-image.ts already carries an honest vocabulary
// for an imperfect one: CORPUS_IMAGE_NOTE captions a non-exact match as "A
// bottle from this producer — not this cuvée" or "Representative bottle — not
// this wine's label", and degrades the alt text so a screen reader is not told
// a producer the picture does not show. A caption that says what the picture
// IS can carry a weaker claim without lying; a body/acidity readout cannot,
// because there is no way to render "medium-bodied, probably a different
// bottling" as anything but a fact.
//
// Hence two named levels, and only the image ever uses the lower one:
//
//   PROFILE_ACCEPT  producer >= 0.80 AND blended >= 0.65 AND cuvée >= 0.64
//                   (xwines-profile.ts's rule, unchanged, unwidened)
//                   -> taste, acidity, grapes, pairings, rating, AND image
//
//   IMAGE_ACCEPT    the producer prefix is >= 2 words AND matched a corpus
//                   winery EXACTLY AND the RPC agrees at >= 0.80
//                   -> image ONLY, kind composed down to at most "producer",
//                      no taste field of any kind
//
// A wine that clears only IMAGE_ACCEPT gets a picture captioned as a bottle
// from its producer or as a representative bottle, and gets nothing else. It
// is never captioned as this wine's label: `weakerImageKind` composes the
// corpus row's own claim with ours, so a real label photograph reached at
// producer confidence is presented as "a bottle from this producer", which is
// what it is.
//
// ── MEASURED, 2026-08-30 ───────────────────────────────────────────────────
//
// Negative set: the 250 invented-producer wines from
// scripts/seed-local-supabase.mjs's generator, folded into the imported shape
// (producer blanked, name = '<producer> <cuvée>'). Every match is wrong by
// construction. See producer-from-name.ts for why the set has to be
// reconstructed rather than queried.
//
//   PROFILE_ACCEPT, 1-word prefixes allowed     0 of 250    (max cuvée
//                                               similarity reached 0.392,
//                                               against a 0.64 floor)
//   IMAGE_ACCEPT,   1-word prefixes allowed     5 of 250    ('Canto Verde …'
//                                               -> Canto, 'Fable & Stone …'
//                                               -> Fable)  REJECTED DESIGN
//   IMAGE_ACCEPT,   2-word floor                0 of 250
//
// So the strict tier can afford one-word recovery — its cuvée floor rejects
// every one of the 38 wrong producers that recovery admits — and the image
// tier, which has no cuvée floor, cannot. That is the whole derivation of the
// two different word floors.
//
// Positive reach, on the 1,277 blank-producer wines of this checkout's `My
// Restaurant` tenant, all of which previously reached NOTHING:
//
//   PROFILE_ACCEPT   271   full profile + image
//   IMAGE_ACCEPT    +157   image only
//   ---------------------
//   total            428   of 1,277 (33.5%)
//
// Sampled by hand across both tiers, the recovered winery was the wine's
// actual producer in every case looked at: Oddero/Barolo Rocche di Castiglione
// at 1.000, Château Léoville Las Cases, Bruno Giacosa, Louis Roederer,
// Benjamin Leroux, Bérêche & Fils.
//
// What the numbers do NOT say is that 428 wines now show their own label. They
// do not. X-Wines holds 1,429 label photographs against 90,675 representative
// ones, and that ratio carries through: of the 428, six are captioned as this
// wine's or its producer's bottle in the strict tier and 17 in the image tier;
// the other 405 are captioned "Representative bottle — not this wine's label",
// which is true and is what the reader is told. The honest summary is that
// these wines went from an initials placeholder to a real, correctly-labelled
// photograph of a bottle — mostly not theirs.
//
// The remaining 849 stay blank, and that is the designed outcome: their
// producer is not in X-Wines, or is spelled differently from it. An unrepaired
// row is the right answer when the only available answer would be wrong.

import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { weakerImageKind } from "./corpus-image";
import {
  PRODUCER_PREFIX_SAFE_WORDS,
  recoverProducerFromName,
} from "./producer-from-name";
import {
  resolveXWinesProfile,
  toImage,
  XWINES_PRODUCER_FLOOR,
  type CorpusRead,
  type XWinesProfile,
} from "./xwines-profile";

export type ResolveWineCorpusProfileInput = {
  supabase: SupabaseClient<Database>;
  /** From `wines.canonical_wine_id`; when set, its link is preferred. */
  canonicalWineId: string | null;
  producer: string | null;
  name: string;
};

// The image tier reads the image columns and the two identity columns, and
// deliberately NOTHING else. Selecting body, acidity, grapes or harmonize here
// would put taste data one property access away from a caller at a confidence
// that was never good enough for it; not selecting them means the tier cannot
// leak what it is not entitled to claim.
const IMAGE_COLUMNS =
  "wine_id, name, winery_name, image_url, image_kind, image_source, image_credit" as const;

function reportFailure(phase: string, error: unknown, extra: Record<string, unknown>) {
  console.error(`xwines: ${phase} failed:`, error);
  Sentry.captureException(error, { tags: { surface: "wine-detail", phase }, extra });
}

/**
 * The corpus entry for a wine, trying every path that can honestly reach one.
 *
 * 1. Whatever `resolveXWinesProfile` makes of the row as stored — an explicit
 *    identity link, or a strict trigram match on a producer the row has.
 * 2. When the row has NO producer, the same strict rule re-run against the
 *    producer recovered from `name`.
 * 3. Failing that, an image alone, at producer confidence, captioned as such.
 *
 * Step 1 costs nothing extra for a blank-producer row: `resolveXWinesProfile`
 * returns at its own blank-producer guard without issuing a query.
 */
export async function resolveWineCorpusProfile(
  input: ResolveWineCorpusProfileInput,
): Promise<CorpusRead<XWinesProfile | null>> {
  const { supabase, canonicalWineId, producer, name } = input;

  const asStored = await resolveXWinesProfile({
    supabase,
    canonicalWineId,
    producer,
    name,
  });
  if (asStored.status === "unavailable") return asStored;
  if (asStored.value !== null) return asStored;

  // Only a row with no producer of its own has anything left to try. A row
  // that HAS one and did not match has been answered.
  if (producer !== null && producer.trim() !== "") return asStored;

  const recovered = await recoverProducerFromName(supabase, name);
  if (recovered.status === "unavailable") return recovered;
  if (recovered.value === null) return { status: "ok", value: null };

  const { producer: winery, cuvee, words } = recovered.value;

  // PROFILE_ACCEPT — the audited rule, unchanged, now with a producer to
  // floor. canonicalWineId is passed as null because step 1 already followed
  // it; re-following it here would repeat a query to get the same answer.
  const strict = await resolveXWinesProfile({
    supabase,
    canonicalWineId: null,
    producer: winery,
    name: cuvee,
  });
  if (strict.status === "unavailable") return strict;
  if (strict.value !== null) return strict;

  // IMAGE_ACCEPT — a picture, and only a picture.
  if (words < PRODUCER_PREFIX_SAFE_WORDS) return { status: "ok", value: null };
  return imageOnlyProfile(supabase, winery, cuvee);
}

/**
 * A picture from a producer we identified but a cuvée we did not.
 *
 * The producer floor is asserted twice over: the prefix matched a corpus
 * winery name EXACTLY, and the RPC is still asked to agree at
 * XWINES_PRODUCER_FLOOR. The second check is not redundant — it is what keeps
 * this tier tied to the same constant the strict tier uses, so lowering that
 * floor cannot quietly loosen only this path.
 *
 * The cuvée is not floored at all. Whichever of the producer's bottlings the
 * RPC ranks closest is the one shown, and the caption says it is not this one.
 */
async function imageOnlyProfile(
  supabase: SupabaseClient<Database>,
  winery: string,
  cuvee: string,
): Promise<CorpusRead<XWinesProfile | null>> {
  const { data: matches, error: matchError } = await supabase.rpc("match_xwines", {
    p_producer: winery,
    p_name: cuvee,
  });
  if (matchError) {
    reportFailure("match-xwines-image", matchError, { winery, cuvee });
    return { status: "unavailable" };
  }

  const accepted = (matches ?? []).find(
    (candidate) => candidate.producer_score >= XWINES_PRODUCER_FLOOR,
  );
  if (!accepted) return { status: "ok", value: null };

  const { data: row, error: rowError } = await supabase
    .from("xwines_catalog")
    .select(IMAGE_COLUMNS)
    .eq("wine_id", accepted.wine_id)
    .maybeSingle();
  if (rowError) {
    reportFailure("image-row-fetch", rowError, { wineId: accepted.wine_id });
    return { status: "unavailable" };
  }
  if (!row) return { status: "ok", value: null };

  const image = toImage(row);
  // No picture on the row means this tier has nothing to offer: it exists only
  // to carry an image, and every other field it could fill is one it is not
  // confident enough to fill.
  if (image === null) return { status: "ok", value: null };

  return {
    status: "ok",
    value: {
      wineId: row.wine_id,
      matchedName: row.name,
      matchedWinery: row.winery_name,
      provenance: "producer-matched",
      matchScore: accepted.score,
      image: { ...image, kind: weakerImageKind(image.kind, "producer") },
      // Everything below is what this tier declines to claim. A
      // producer-level match is not evidence about a cuvée's body, acidity,
      // grapes, pairings, alcohol, region or rating, so none of them are read
      // from the row at all (see IMAGE_COLUMNS) and none are returned.
      type: null,
      elaborate: null,
      grapes: [],
      pairings: [],
      abv: null,
      body: null,
      acidity: null,
      regionName: null,
      country: null,
      website: null,
      vintages: [],
      hasNonVintage: false,
      ratingAvg: null,
      ratingCount: 0,
    },
  };
}
