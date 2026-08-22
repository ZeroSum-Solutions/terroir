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
    .select("id")
    .eq("job_type", INVOICE_EXTRACT_JOB_TYPE)
    .eq("idempotency_key", scanId)
    .single();

  if (fetchError || !existing) {
    throw fetchError ?? new Error("Idempotent enqueue conflict but no existing job found.");
  }

  return { jobId: existing.id, created: false };
}
