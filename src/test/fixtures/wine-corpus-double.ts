import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * The PostgREST + RPC double for `resolveWineCorpusProfile`, and the catalog
 * row and match rows its suites assert against.
 *
 * Extracted when a second suite needed it. Two copies of a double this
 * particular is how the two copies drift: the `.in()`-means-prefix-lookup
 * convention below is load-bearing for every assertion that a recovery did or
 * did not happen, and it has to mean the same thing in both files.
 */
export const CATALOG_ROW = {
  wine_id: 119230,
  name: "Vosne-Romanee",
  winery_name: "Benjamin Leroux",
  type: "Red",
  elaborate: "Varietal/100%",
  grapes: ["Pinot Noir"],
  harmonize: ["Beef", "Poultry"],
  abv: 13.0,
  body: "Medium-bodied",
  acidity: "High",
  region_name: "Vosne-Romanée",
  country: "France",
  website: null,
  vintages: [2019, 2018],
  has_non_vintage: false,
  rating_avg: 4.1,
  rating_count: 120,
  image_url: "http://127.0.0.1:57321/storage/v1/object/public/wine-images/xwines/119230.jpeg",
  image_kind: "label",
  image_source: "xwines",
  image_credit: null,
};

export type MatchRow = {
  wine_id: number;
  score: number;
  producer_score: number;
  name_score: number;
};

export type Call = { table: string; values?: unknown; args?: unknown };

/**
 * PostgREST + RPC double covering the three tables this module touches. Plain
 * thenables, per xwines-profile.test.ts's note about `await` short-circuiting
 * native promises.
 */
export function fakeSupabase(options: {
  /** What the producer-prefix lookup finds in `winery_name`. */
  prefixHit?: string | null;
  /** What match_xwines returns, in order. */
  match?: MatchRow[];
  catalog?: Record<string, unknown> | null;
  canonical?: { xwines_wine_id: number | null } | null;
  fail?: "prefix" | "match" | "catalog";
}) {
  const calls: Call[] = [];
  const error = { message: "boom" };
  const supabase = {
    from: (table: string) => {
      const call: Call = { table };
      // The prefix lookup is the only `.in()` on xwines_catalog; a `.eq()` on
      // the same table is the image tier reading one row back.
      let isPrefixLookup = false;
      const settle = () => {
        calls.push(call);
        if (table === "canonical_wines") {
          return thenable({ data: options.canonical ?? null, error: null });
        }
        if (isPrefixLookup) {
          if (options.fail === "prefix") return thenable({ data: null, error });
          const winery = options.prefixHit ?? null;
          return thenable({
            data: winery === null ? null : { winery_name: winery },
            error: null,
          });
        }
        if (options.fail === "catalog") return thenable({ data: null, error });
        return thenable({ data: options.catalog ?? null, error: null });
      };
      const self = {
        select: () => self,
        eq: () => self,
        in: (column: string, values: unknown) => {
          isPrefixLookup = true;
          call.values = values;
          return self;
        },
        order: () => self,
        limit: () => self,
        maybeSingle: settle,
      };
      return self;
    },
    rpc: (fn: string, args: unknown) => {
      calls.push({ table: `rpc:${fn}`, args });
      if (options.fail === "match") return thenable({ data: null, error });
      return thenable({ data: options.match ?? [], error: null });
    },
  } as unknown as SupabaseClient<Database>;
  return { supabase, calls };
}

export function thenable(payload: unknown) {
  return { then: (resolve: (value: unknown) => unknown) => resolve(payload) };
}

const blank = { canonicalWineId: null, producer: "", name: "Benjamin Leroux Vosne-Romanée" };

export const strictHit: MatchRow = {
  wine_id: 119230,
  score: 0.95,
  producer_score: 1,
  name_score: 0.95,
};

/** Right winery, cuvée nowhere near — clears the producer floor and nothing else. */
export const producerOnlyHit: MatchRow = {
  wine_id: 119230,
  score: 0.75,
  producer_score: 1,
  name_score: 0.35,
};
