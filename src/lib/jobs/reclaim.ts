import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * Sweep invoice_extract jobs claimed longer than `stuckAfterSeconds` ago
 * (worker crashed or was killed mid-attempt) and requeue them with
 * attempt_count incremented, or mark them `dead` once max_attempts is
 * exhausted. Backed by `reclaim_stuck_invoice_extract_jobs`. Returns the
 * number of jobs reclaimed.
 */
export async function reclaimStuckInvoiceExtractJobs(
  supabase: SupabaseClient<Database>,
  stuckAfterSeconds: number,
): Promise<number> {
  const { data, error } = await supabase.rpc(
    "reclaim_stuck_invoice_extract_jobs",
    { p_stuck_after_seconds: stuckAfterSeconds } as never,
  );
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}
