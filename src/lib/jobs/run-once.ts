import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { claimNextInvoiceExtractJob } from "@/lib/jobs/claim";
import {
  markJobDeadImmediately,
  markJobRetryOrDead,
  markJobSucceeded,
} from "@/lib/jobs/complete";
import { runInvoiceExtractJob } from "@/lib/jobs/invoice-extract-handler";
import type { ProcessOneJobResult } from "@/lib/jobs/types";

/**
 * Claim, run, and complete a single invoice_extract job. Returns
 * `{ processed: false }` when the queue was empty — the caller (the
 * worker's poll loop) uses that to decide whether to sleep before
 * checking again.
 */
export async function processOneInvoiceExtractJob(
  supabase: SupabaseClient<Database>,
  workerId: string,
): Promise<ProcessOneJobResult> {
  const job = await claimNextInvoiceExtractJob(supabase, workerId);
  if (!job) return { processed: false };

  const outcome = await runInvoiceExtractJob({ supabase, job });

  if (outcome.kind === "succeeded") {
    await markJobSucceeded(supabase, job);
  } else if (outcome.kind === "retry") {
    await markJobRetryOrDead(supabase, job, outcome);
  } else {
    await markJobDeadImmediately(supabase, job, outcome);
  }

  return { processed: true, jobId: job.id, outcome: outcome.kind };
}
