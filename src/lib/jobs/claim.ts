import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { ClaimedInvoiceExtractJob } from "@/lib/jobs/types";

type ClaimRow = {
  id: string;
  restaurant_id: string;
  created_by: string | null;
  subject_id: string | null;
  attempt_count: number;
  max_attempts: number;
  claimed_by: string | null;
};

/**
 * Atomically claim the single oldest runnable invoice_extract job.
 *
 * Backed by `claim_invoice_extract_job`, a `FOR UPDATE SKIP LOCKED` SQL
 * function — this is the only way to get that locking behavior through
 * Supabase (PostgREST's query builder has no SELECT FOR UPDATE). Safe to
 * call concurrently from multiple worker instances: at most one of them
 * claims any given row.
 */
export async function claimNextInvoiceExtractJob(
  supabase: SupabaseClient<Database>,
  workerId: string,
): Promise<ClaimedInvoiceExtractJob | null> {
  const { data, error } = await supabase.rpc("claim_invoice_extract_job", {
    p_worker_id: workerId,
  } as never);
  if (error) throw error;

  const rows = (data ?? []) as ClaimRow[];
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    createdBy: row.created_by,
    subjectId: row.subject_id,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    // Just set by the RPC to workerId; non-null by construction.
    claimedBy: row.claimed_by ?? workerId,
  };
}
