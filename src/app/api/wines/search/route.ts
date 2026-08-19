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
  let query = supabase
    .from("wines")
    .select("id, name, producer, vintage, varietal, region")
    .eq("restaurant_id", restaurantId)
    .order("producer")
    .limit(derivedFilter ? 1000 : 20);

  // Mirror the /cellar list predicates exactly (cellar-list.tsx switch).
  const currentYear = new Date().getFullYear();
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

  if (q) {
    // Search by producer or name (case-insensitive)
    const pattern = quotePostgrestPattern(q);
    query = query.or(`name.ilike.${pattern},producer.ilike.${pattern}`);
  }
  if (producer) query = query.ilike("producer", escapeLikePattern(producer));
  if (region) query = query.ilike("region", escapeLikePattern(region));
  if (country) query = query.ilike("country", escapeLikePattern(country));
  if (varietal) query = query.ilike("varietal", escapeLikePattern(varietal));
  if (vintageMin != null) query = query.gte("vintage", vintageMin);
  if (vintageMax != null) query = query.lte("vintage", vintageMax);
  if (format != null) query = query.eq("size_ml", format);

  let { data: wines, error } = await query;

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
