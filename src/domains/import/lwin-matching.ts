// G1-4 — bulk LWIN matching for CSV import preview.
//
// Read-only: match_lwin_bulk (0076) only ever SELECTs from lwin_catalog
// (via match_lwin, 0007). Calling it is safe from the preview endpoint's
// zero-database-writes requirement.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { LWIN_MATCH_BATCH_SIZE, LWIN_MATCH_THRESHOLD } from "./constants";

export type LwinMatchQuery = { idx: number; producer: string; name: string };

/**
 * Query variants for one row. Rows with a real producer get exactly the
 * one query they always got. Producer-less rows (single-"Wine Name"-column
 * exports) additionally try the leading 2 and 3 tokens of the name as the
 * producer leg: match_lwin scores 0.6×sim(producer) + 0.4×sim(name), so a
 * full wine name in the producer leg dilutes against the catalog's short
 * producer strings and drags obviously-correct candidates under apply's
 * 0.6 bar. Measured on the real 1,306-row partner export against the
 * production 211k-row catalog (2026-08-27 harness): best-of-variants lifts
 * matches at the 0.6 bar from 29.6% to 77.0%; the winning variant is
 * producer=first-2-tokens for ~80% of matches. The caller takes the best
 * score per row, and apply's confidence bar is unchanged.
 */
export function buildLwinQueryVariants(
  producer: string,
  name: string,
): Array<{ producer: string; name: string }> {
  if (producer) return [{ producer, name }];
  const variants = [{ producer: name, name }];
  const tokens = name.split(/\s+/).filter(Boolean);
  if (tokens.length >= 3) {
    variants.push({ producer: tokens.slice(0, 2).join(" "), name });
  }
  if (tokens.length >= 4) {
    variants.push({ producer: tokens.slice(0, 3).join(" "), name });
  }
  return variants;
}

export type LwinMatch = {
  lwinId: string;
  score: number;
};

/**
 * Resolve LWIN matches for a set of (producer, name) queries in bounded
 * RPC batches. Returns a map from the caller's idx to a match, or
 * undefined for an idx with no match above threshold — never guesses,
 * never picks a low-confidence match (bar: "no-silent-fuzzy-merge").
 */
export async function matchLwinBulk(
  supabase: SupabaseClient<Database>,
  queries: LwinMatchQuery[],
): Promise<Map<number, LwinMatch>> {
  const results = new Map<number, LwinMatch>();
  if (queries.length === 0) return results;

  for (let i = 0; i < queries.length; i += LWIN_MATCH_BATCH_SIZE) {
    const batch = queries.slice(i, i + LWIN_MATCH_BATCH_SIZE);
    const { data, error } = await supabase.rpc("match_lwin_bulk", {
      p_queries: batch,
      p_threshold: LWIN_MATCH_THRESHOLD,
    } as never);
    if (error) throw error;

    for (const row of (data ?? []) as Array<{ idx: number; lwin_id: string | null; score: number | null }>) {
      if (row.lwin_id) {
        results.set(row.idx, { lwinId: row.lwin_id, score: row.score ?? 0 });
      }
    }
  }

  return results;
}
