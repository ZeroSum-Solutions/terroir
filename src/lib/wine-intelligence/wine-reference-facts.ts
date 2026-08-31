import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { XWinesProfile } from "./xwines-profile";

/**
 * Where a wine's region, country and varietal come from when the row itself
 * does not say.
 *
 * Measured on production, 2026-08-31: of 1,385 wines, 1,277 have a blank
 * `region` and 1,290 a blank `country`. The detail page read those columns
 * directly, so for 92% of the cellar it rendered nothing — while two reference
 * tables that DO know sat already loaded and already linked.
 *
 * ── THE ORDER, AND WHY ─────────────────────────────────────────────────────
 *
 *   1. the wine's own column   Whatever the restaurant typed or imported is
 *                              theirs and is never overridden. A reference
 *                              table disagreeing with the bottle in the cellar
 *                              loses; they are holding it and we are not.
 *
 *   2. lwin_catalog            Reached by `wines.lwin_id`, which the importer
 *                              stamps at LWIN_APPLY_MIN_SCORE (0.6) — an
 *                              identity decision already made, recorded, and
 *                              reviewable, not a guess made at render time.
 *                              1,032 of the 1,385 carry one, and LWIN fills
 *                              region and country for 985 (71.1%).
 *
 *   3. the X-Wines profile     A live trigram match, and the loosest link of
 *                              the three. It reaches 32.9%, so it is a
 *                              fallback to a fallback rather than the answer.
 *
 * Nothing here is written back to `wines`. These are the tenant's rows; a
 * reference table is entitled to fill a blank on screen, not to edit their
 * record. That also keeps the answer current — re-seed LWIN and the page
 * improves without a backfill anyone has to remember to run.
 */

export type WineReferenceRow = {
  producer: string | null;
  region: string | null;
  country: string | null;
  varietal: string | null;
};

export type ResolvedWineFacts = {
  region: string | null;
  country: string | null;
  varietal: string | null;
  /** Which of the three answered, per field, so a surface can attribute it. */
  source: Record<"region" | "country" | "varietal", "wine" | "lwin" | "corpus" | null>;
};

/** The LWIN row for a wine, or null when it has no id or the read fails.
 *
 * A reference lookup must never take the page down with it: the wine, its
 * inventory and its corpus profile are all still worth rendering without a
 * region. The failure is reported and the page degrades to what it had before.
 */
export async function fetchLwinReference(
  supabase: SupabaseClient<Database>,
  // `undefined` as well as `null`: a caller that did not select the column at
  // all reaches here with undefined, and a reference lookup is exactly the
  // wrong place to throw a TypeError up through a page's render.
  lwinId: string | null | undefined,
): Promise<WineReferenceRow | null> {
  if (!lwinId || lwinId.trim() === "") return null;
  const { data, error } = await supabase
    .from("lwin_catalog")
    .select("producer, region, country, varietal")
    .eq("lwin_id", lwinId)
    .maybeSingle();
  if (error) {
    console.error("lwin: reference lookup failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wine-detail", phase: "lwin-reference" },
      extra: { lwinId },
    });
    return null;
  }
  return data ?? null;
}

const filled = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};

export function resolveWineFacts(input: {
  wine: { region: string | null; country: string | null; varietal: string | null };
  lwin: WineReferenceRow | null;
  profile: XWinesProfile | null;
}): ResolvedWineFacts {
  const { wine, lwin, profile } = input;
  const pick = (
    own: string | null,
    fromLwin: string | null | undefined,
    fromCorpus: string | null | undefined,
  ): [string | null, "wine" | "lwin" | "corpus" | null] => {
    const mine = filled(own);
    if (mine !== null) return [mine, "wine"];
    const l = filled(fromLwin);
    if (l !== null) return [l, "lwin"];
    const c = filled(fromCorpus);
    if (c !== null) return [c, "corpus"];
    return [null, null];
  };

  const [region, regionSource] = pick(wine.region, lwin?.region, profile?.regionName);
  const [country, countrySource] = pick(wine.country, lwin?.country, profile?.country);
  // The corpus stores grapes as a list and has no single "varietal" field, so
  // it contributes here only when it names exactly one — two grapes is a blend,
  // and picking either would be inventing a fact the corpus did not state.
  // `?.` on grapes as well as on profile: the type promises an array, but this
  // is the last hop before a page renders and a corpus row that arrives without
  // one must degrade to "no varietal", not to a blank page.
  const soleGrape = profile?.grapes?.length === 1 ? profile.grapes[0] : null;
  const [varietal, varietalSource] = pick(wine.varietal, lwin?.varietal, soleGrape);

  return {
    region,
    country,
    varietal,
    source: { region: regionSource, country: countrySource, varietal: varietalSource },
  };
}
