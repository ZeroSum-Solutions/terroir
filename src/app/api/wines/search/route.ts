import { NextResponse, type NextRequest } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireMembership } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { parseQuery } from "@/lib/api/validation";
import { CELLAR_FILTERS } from "@/lib/cellar-facets/url-state";
import {
  DRINK_NOW_THRESHOLD_YEARS,
} from "@/lib/drink-window/status";

export const runtime = "nodejs";

const QuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  filter: z.enum(CELLAR_FILTERS).optional(),
  producer: z.string().trim().min(1).max(200).optional(),
  region: z.string().trim().min(1).max(200).optional(),
  country: z.string().trim().min(1).max(200).optional(),
  varietal: z.string().trim().min(1).max(200).optional(),
  vintage_min: z.coerce.number().int().min(1000).max(3000).optional(),
  vintage_max: z.coerce.number().int().min(1000).max(3000).optional(),
  format: z.coerce.number().int().positive().optional(),
});

// SCAN-06. Two numbers, both deliberate.
//
// FUZZY_WORD_SIMILARITY_THRESHOLD is load-bearing and is passed explicitly
// rather than left to the RPC's own default, let alone to pg_trgm's. Measured
// on the local corpus, the token "fredric" scores 0.545455 against
// "Jacques-Frédéric Mugnier ..." — a dropped letter plus two dropped accents,
// the hardest real case from the field notes. It clears 0.5 and FAILS
// pg_trgm's DEFAULT word_similarity_threshold of 0.6, so inheriting a default
// anywhere in this chain would silently preserve the bug being fixed.
//
// FUZZY_FALLBACK_MIN_RESULTS is "too few", not "none": a query that surfaces
// one or two exact substring hits has still failed the person typing it if the
// wine they meant is a near-miss away. Fuzzy rows are appended after the exact
// ones and never displace them.
const FUZZY_WORD_SIMILARITY_THRESHOLD = 0.5;
const FUZZY_FALLBACK_MIN_RESULTS = 5;

export async function GET(request: NextRequest) {
  const auth = await requireMembership();
  if (auth instanceof NextResponse) return auth;
  const { supabase, restaurantId } = auth;

  const parsed = await parseQuery(request.nextUrl.searchParams, QuerySchema);
  if (!parsed.ok) return parsed.response;
  const {
    q = "",
    filter = "all",
    producer,
    region,
    country,
    varietal,
    vintage_min: vintageMin,
    vintage_max: vintageMax,
    format,
  } = parsed.data;

  // open/low depend on open-bottle + inventory state, so those paths pull a
  // wider candidate set and finish the predicate in the route.
  const derivedFilter = filter === "open" || filter === "low";
  const limit = derivedFilter ? 1000 : 20;
  const currentYear = new Date().getFullYear();

  // Every non-free-text predicate, in one place, because the fuzzy fallback
  // below has to re-apply the identical set to its own candidate ids. The
  // facets are not "search"; a fuzzy name match that ignored the caller's
  // vintage or format filter would be a different bug from the one SCAN-06
  // fixes.
  const buildQuery = () => {
    let query = supabase
      .from("wines")
      .select("id, name, producer, vintage, varietal, region, colour, hero_image_url")
      .eq("restaurant_id", restaurantId)
      .order("producer")
      .limit(limit);

    // Mirror the /cellar list predicates exactly (cellar-list.tsx switch).
    if (filter === "out") {
      query = query.eq("is_eightysixed", true);
    } else if (filter === "drink-now") {
      query = query
        .eq("is_eightysixed", false)
        .lte("drink_window_end", currentYear + DRINK_NOW_THRESHOLD_YEARS);
    } else if (filter === "hold") {
      query = query
        .eq("is_eightysixed", false)
        .gt("drink_window_start", currentYear);
    } else if (filter === "low") {
      query = query.eq("is_eightysixed", false);
    }

    if (producer) query = query.ilike("producer", escapeLikePattern(producer));
    if (region) query = query.ilike("region", escapeLikePattern(region));
    if (country) query = query.ilike("country", escapeLikePattern(country));
    if (varietal) query = query.ilike("varietal", escapeLikePattern(varietal));
    if (vintageMin != null) query = query.gte("vintage", vintageMin);
    if (vintageMax != null) query = query.lte("vintage", vintageMax);
    if (format != null) query = query.eq("size_ml", format);
    return query;
  };

  let query = buildQuery();
  if (q) {
    // Search by producer or name (case-insensitive)
    const pattern = quotePostgrestPattern(q);
    query = query.or(`name.ilike.${pattern},producer.ilike.${pattern}`);
  }

  let { data: wines, error } = await query;

  // SCAN-06: the pass above is exact-substring over the WHOLE query, so
  // "Fredric savart" matches nothing — it can neither span producer + name nor
  // survive a dropped letter or a dropped accent. It stays the primary path
  // because it is fast and precise for the common case; the trigram RPC only
  // tops up a result set the exact pass left near-empty.
  if (!error && q && (wines?.length ?? 0) < FUZZY_FALLBACK_MIN_RESULTS) {
    const augmented = await appendFuzzyMatches(
      supabase,
      restaurantId,
      q,
      limit,
      wines ?? [],
      (ids) => buildQuery().in("id", ids),
    );
    if (augmented.ok) {
      wines = augmented.rows;
    } else {
      // Deploy-window safety (AGENTS.md non-negotiable #7): migrations do not
      // ride along with a merge, so this code can be live for hours before
      // 0144 is applied by hand, and search_wines_fuzzy will not exist yet.
      // The exact pass above already produced a correct — if narrower — answer,
      // and it is exactly the answer this route gave before SCAN-06. Throwing
      // it away to return 500 would turn an unavailable enhancement into a
      // broken search on every query with fewer than five substring hits.
      // Reported, not swallowed.
      console.error("wines fuzzy search fallback failed:", augmented.error);
      Sentry.captureException(augmented.error, {
        tags: { surface: "wines-search", phase: "fuzzy-fallback" },
        extra: { restaurantId, q },
      });
    }
  }

  if (!error && derivedFilter && wines && wines.length > 0) {
    const narrowed = await applyDerivedFilter(
      supabase,
      restaurantId,
      filter as "open" | "low",
      wines,
    );
    if (narrowed.ok) wines = narrowed.rows;
    else error = narrowed.error;
  }

  if (error) {
    console.error("wines search failed:", error);
    Sentry.captureException(error, {
      tags: { surface: "wines-search", phase: "query" },
      extra: { restaurantId, q },
    });
    return Errors.internal("Search failed.");
  }

  return NextResponse.json(wines ?? []);
}

type SearchWine = {
  id: string;
  name: string;
  producer: string;
  vintage: number | null;
  varietal: string | null;
  region: string | null;
  colour: string | null;
  hero_image_url: string | null;
};

type SupabaseClient = Awaited<
  ReturnType<typeof requireMembership>
> extends infer R
  ? R extends { supabase: infer C }
    ? C
    : never
  : never;

async function applyDerivedFilter(
  supabase: SupabaseClient,
  restaurantId: string,
  filter: "open" | "low",
  candidates: SearchWine[],
): Promise<{ ok: true; rows: SearchWine[] } | { ok: false; error: PostgrestError }> {
  const { data: openRows, error: openError } = await supabase.rpc(
    "list_open_bottle_items",
    { p_restaurant_id: restaurantId },
  );
  if (openError) return { ok: false, error: openError };
  const openByWine = new Map(
    (openRows ?? []).map((row) => [row.wine_id, row]),
  );

  if (filter === "open") {
    return {
      ok: true,
      rows: candidates
        .filter((wine) => {
          const open = openByWine.get(wine.id);
          return open?.open_remaining_ml != null && open.open_remaining_ml > 0;
        })
        .slice(0, 20),
    };
  }

  const { data: inventoryRows, error: inventoryError } = await supabase
    .from("inventory_items")
    .select("wine_id, quantity")
    .eq("restaurant_id", restaurantId)
    .in("wine_id", candidates.map((wine) => wine.id));
  if (inventoryError) return { ok: false, error: inventoryError };
  const sealedByWine = new Map<string, number>();
  for (const item of inventoryRows ?? []) {
    if (!item.wine_id) continue;
    sealedByWine.set(
      item.wine_id,
      (sealedByWine.get(item.wine_id) ?? 0) + item.quantity,
    );
  }

  return {
    ok: true,
    rows: candidates
      .filter((wine) => {
        const open = openByWine.get(wine.id);
        const sizeMl = open?.size_ml;
        if (!sizeMl) return false;
        const totalMl =
          (open?.open_remaining_ml ?? 0) +
          (sealedByWine.get(wine.id) ?? 0) * sizeMl;
        return totalMl < 2 * sizeMl;
      })
      .slice(0, 20),
  };
}

/**
 * Tops up an exact-substring result set with trigram matches from
 * `search_wines_fuzzy` (migration 0144).
 *
 * The RPC returns ids ranked by score, nothing else; the rows themselves come
 * back through the caller's own query builder, so every facet predicate the
 * exact pass applied is applied to these candidates too. Postgres will return
 * them in `producer` order, so the score ranking is restored here from the
 * RPC's ordering before the merged list is trimmed.
 *
 * Tenancy: `p_restaurant_id` is the session's own restaurant, resolved
 * server-side by requireMembership and never client-supplied. The RPC is
 * SECURITY INVOKER, so `wines` RLS is the enforcing layer underneath it.
 */
async function appendFuzzyMatches(
  supabase: SupabaseClient,
  restaurantId: string,
  q: string,
  limit: number,
  exact: SearchWine[],
  fetchByIds: (ids: string[]) => PromiseLike<{
    data: SearchWine[] | null;
    error: PostgrestError | null;
  }>,
): Promise<{ ok: true; rows: SearchWine[] } | { ok: false; error: PostgrestError }> {
  const { data: ranked, error } = await supabase.rpc("search_wines_fuzzy", {
    p_restaurant_id: restaurantId,
    p_query: q,
    p_threshold: FUZZY_WORD_SIMILARITY_THRESHOLD,
    p_limit: limit,
  });
  if (error) return { ok: false, error };

  const alreadyShown = new Set(exact.map((wine) => wine.id));
  const rankById = new Map<string, number>();
  for (const [index, row] of (ranked ?? []).entries()) {
    if (!alreadyShown.has(row.wine_id) && !rankById.has(row.wine_id)) {
      rankById.set(row.wine_id, index);
    }
  }
  if (rankById.size === 0) return { ok: true, rows: exact };

  const { data: rows, error: rowsError } = await fetchByIds([...rankById.keys()]);
  if (rowsError) return { ok: false, error: rowsError };

  const fuzzy = (rows ?? [])
    .filter((wine) => rankById.has(wine.id))
    .sort((a, b) => rankById.get(a.id)! - rankById.get(b.id)!);

  return { ok: true, rows: [...exact, ...fuzzy].slice(0, limit) };
}

function quotePostgrestPattern(value: string) {
  const escaped = escapeLikePattern(value).replaceAll('"', '\\"');
  return `"%${escaped}%"`;
}

function escapeLikePattern(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
