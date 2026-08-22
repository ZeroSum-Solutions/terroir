import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { DEFAULT_MAX_ATTEMPTS, INVOICE_EXTRACT_JOB_TYPE } from "@/lib/jobs/constants";
import type { EnqueueInvoiceExtractJobResult } from "@/lib/jobs/types";

const UNIQUE_VIOLATION = "23505";

export type EnqueueInvoiceExtractJobInput = {
  supabase: SupabaseClient<Database>;
  restaurantId: string;
  /** The invoice_scans row this job will process. Doubles as the idempotency key. */
  scanId: string;
  createdBy?: string | null;
  maxAttempts?: number;
};

/**
 * Enqueue an invoice_extract job, idempotently.
 *
 * The idempotency guarantee lives in the database, not application hope:
 * `background_jobs_idempotency_key_uniq` is a unique index on
 * (job_type, idempotency_key). A second enqueue call for the same scanId
 * (client retry, double form submit, a crashed request retried by the
 * caller) hits that constraint and this function returns the existing
 * job instead of creating a second one — so the same scan can never have
 * two invoice_extract jobs racing to call Anthropic on it.
 */
export async function enqueueInvoiceExtractJob(
  input: EnqueueInvoiceExtractJobInput,
): Promise<EnqueueInvoiceExtractJobResult> {
  const {
    supabase,
    restaurantId,
    scanId,
    createdBy = null,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = input;

  const { data, error } = await supabase
    .from("background_jobs")
    .insert({
      restaurant_id: restaurantId,
      created_by: createdBy,
      job_type: INVOICE_EXTRACT_JOB_TYPE,
      status: "queued",
      subject_table: "invoice_scans",
      subject_id: scanId,
      idempotency_key: scanId,
      max_attempts: maxAttempts,
    } as never)
    .select("id")
    .single();

  if (!error && data) {
    return { jobId: (data as { id: string }).id, created: true };
  }

  if (!error || (error as { code?: string }).code !== UNIQUE_VIOLATION) {
    throw error ?? new Error("background_jobs insert returned no row and no error.");
  }

  const { data: existing, error: fetchError } = await supabase
    .from("background_jobs")
    .select("id, status")
    .eq("job_type", INVOICE_EXTRACT_JOB_TYPE)
    .eq("idempotency_key", scanId)
    .single();

  if (fetchError || !existing) {
    throw fetchError ?? new Error("Idempotent enqueue conflict but no existing job found.");
  }

  // A `dead` row (exhausted its retries) is otherwise a permanent dead end:
  // `claim_invoice_extract_job` only ever claims status='queued', so
  // without this, every future enqueue for this scanId would keep
  // returning the same dead job id and the scan could never be extracted
  // again. Revive it back to queued — fenced on the row still being
  // 'dead' so a concurrent revival (or a stuck-sweep/claim landing on it
  // between our read and this write) can't be clobbered. This is still
  // "not created": the caller gets back the same job identity, same as
  // any other idempotent-conflict return.
  if ((existing as { status: string }).status === "dead") {
    const { data: revived, error: reviveError } = await supabase
      .from("background_jobs")
      .update({
        status: "queued",
        attempt_count: 0,
        error_code: null,
        error_message: null,
        claimed_by: null,
        claimed_at: null,
        run_after: new Date().toISOString(),
      } as never)
      .eq("id", existing.id)
      .eq("status", "dead")
      .select("id");

    if (reviveError) throw reviveError;
    // 0 rows matched: raced with another revival/claim between our read
    // and this write. Either way the job still exists — return it as-is.
    if (revived && revived.length > 0) {
      return { jobId: existing.id, created: false };
    }
  }

  return { jobId: existing.id, created: false };
}
