import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { computeBackoffMs } from "@/lib/jobs/backoff";
import type { ClaimedInvoiceExtractJob } from "@/lib/jobs/types";

/**
 * Write a completion update, fenced to the exact ownership this worker
 * claimed: id + restaurant_id + claimed_by + status='processing'. If the
 * stuck-job reclaim sweep has since reassigned this job to another worker
 * (this worker was just slow, not actually dead), claimed_by/status will
 * no longer match and the update is a no-op — a zombie worker can never
 * clobber a job it no longer owns. Returns whether the write took effect.
 */
async function updateFenced(
  supabase: SupabaseClient<Database>,
  job: ClaimedInvoiceExtractJob,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("background_jobs")
    .update(patch as never)
    .eq("id", job.id)
    .eq("restaurant_id", job.restaurantId)
    .eq("claimed_by", job.claimedBy)
    .eq("status", "processing")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function markJobSucceeded(
  supabase: SupabaseClient<Database>,
  job: ClaimedInvoiceExtractJob,
): Promise<boolean> {
  return updateFenced(supabase, job, {
    status: "succeeded",
    finished_at: new Date().toISOString(),
    error_code: null,
    error_message: null,
  });
}

/**
 * Retryable failure: increment attempt_count, then either requeue with
 * exponential backoff or — once max_attempts is exhausted — transition to
 * the terminal `dead` state.
 */
export async function markJobRetryOrDead(
  supabase: SupabaseClient<Database>,
  job: ClaimedInvoiceExtractJob,
  failure: { code: string; message: string },
): Promise<boolean> {
  const nextAttempt = job.attemptCount + 1;
  const dead = nextAttempt >= job.maxAttempts;

  const patch: Record<string, unknown> = {
    attempt_count: nextAttempt,
    claimed_at: null,
    claimed_by: null,
    error_code: failure.code,
    error_message: failure.message,
  };
  if (dead) {
    patch.status = "dead";
    patch.finished_at = new Date().toISOString();
  } else {
    patch.status = "queued";
    patch.run_after = new Date(Date.now() + computeBackoffMs(nextAttempt)).toISOString();
  }

  return updateFenced(supabase, job, patch);
}

/**
 * Non-retryable failure (bad/mistenanted data, unsupported input): go
 * straight to `dead` without spending remaining attempts on a retry that
 * cannot succeed.
 */
export async function markJobDeadImmediately(
  supabase: SupabaseClient<Database>,
  job: ClaimedInvoiceExtractJob,
  failure: { code: string; message: string },
): Promise<boolean> {
  return updateFenced(supabase, job, {
    status: "dead",
    attempt_count: job.maxAttempts,
    finished_at: new Date().toISOString(),
    claimed_at: null,
    claimed_by: null,
    error_code: failure.code,
    error_message: failure.message,
  });
}
