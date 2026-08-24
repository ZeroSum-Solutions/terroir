import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { EnqueueInvoiceExtractJobResult } from "@/lib/jobs/types";

export type EnqueueInvoiceExtractJobInput = {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  /** The invoice_scans row this job will process. Doubles as the idempotency key. */
  scanId: string;
};

type EnqueueRpcRow = { job_id: string; created: boolean };

/**
 * Enqueue an invoice_extract job, idempotently.
 *
 * C20 (db audit 2026-08-23): calls the SECURITY DEFINER
 * `enqueue_invoice_extract_job` RPC instead of inserting/updating
 * `background_jobs` directly — `authenticated` has no table-level
 * INSERT/UPDATE on that table at all (see
 * supabase/migrations/0083_background_jobs_enqueue_rpc.sql). The RPC
 * verifies the caller is a staff-or-above member of restaurantId, verifies
 * scanId is a real invoice_scans row that actually belongs to
 * restaurantId, and pins idempotency_key = scanId, created_by =
 * auth.uid(), status = 'queued', run_after = now(), and max_attempts to
 * the database's own constant default — none of those are caller-supplied
 * inputs anymore, closing the direct-insert path that previously let any
 * signed-in staff member forge them.
 *
 * The idempotency guarantee lives in the database, not application hope:
 * `background_jobs_idempotency_key_uniq` is a unique index on
 * (job_type, idempotency_key). A second enqueue call for the same scanId
 * (client retry, double form submit, a crashed request retried by the
 * caller) hits that constraint and the RPC returns the existing job
 * (reviving it first if it had gone `dead`) instead of creating a second
 * one — so the same scan can never have two invoice_extract jobs racing
 * to call Anthropic on it.
 */
export async function enqueueInvoiceExtractJob(
  input: EnqueueInvoiceExtractJobInput,
): Promise<EnqueueInvoiceExtractJobResult> {
  const { supabase, restaurantId, scanId } = input;

  const { data, error } = await supabase
    .rpc("enqueue_invoice_extract_job", {
      p_restaurant_id: restaurantId,
      p_scan_id: scanId,
    } as never)
    .single();

  if (error) throw error;

  const row = data as EnqueueRpcRow;
  return { jobId: row.job_id, created: row.created };
}
