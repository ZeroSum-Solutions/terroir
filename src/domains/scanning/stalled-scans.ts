/**
 * Settle invoice scans that will never finish.
 *
 * POST /api/scan inserts the ledger row as "processing" before extraction
 * and updates it afterwards (invoice-scan-service.ts). If the process dies
 * in between — a deploy, a crash, a killed request — nothing ever updates
 * the row, and the scans page shows it spinning forever. Production's demo
 * tenant carried one such row from the day it was created.
 *
 * A synchronous scan is bounded: the model client times out at 100 s with
 * two retries, so nothing legitimate is still "processing" a quarter of an
 * hour after it was created. Rows older than that are marked failed with
 * the `stalled` reason (scan-status-reason.ts renders it), tenant-scoped,
 * fenced on the status so a row that completed meanwhile is untouched.
 */
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export const STALLED_AFTER_MS = 15 * 60 * 1000;
export const STALLED_REASON = "stalled";

export async function expireStalledScans(opts: {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  now?: Date;
}): Promise<number> {
  const { supabase, restaurantId, now = new Date() } = opts;
  const cutoff = new Date(now.getTime() - STALLED_AFTER_MS).toISOString();
  const { data, error } = await supabase
    .from("invoice_scans")
    .update({ status: "failed", status_reason: STALLED_REASON })
    .eq("restaurant_id", restaurantId)
    .eq("status", "processing")
    .lt("created_at", cutoff)
    .select("id");
  if (error) {
    // Never block the page on housekeeping; report and list what is there.
    Sentry.captureException(error, { tags: { surface: "scans", phase: "expire-stalled" } });
    return 0;
  }
  return data?.length ?? 0;
}
