import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { ClaimedInvoiceExtractJob } from "@/lib/jobs/types";

/**
 * Renew the claim lease on a job still being worked, fenced to the exact
 * ownership this worker holds (id + restaurant_id + claimed_by +
 * status='processing' — the same fencing pattern as the completion writes
 * in complete.ts). Returns false when the fenced update affects no rows:
 * this worker has already been reclaimed by someone else.
 */
export async function renewClaim(
  supabase: SupabaseClient<Database>,
  job: ClaimedInvoiceExtractJob,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("background_jobs")
    .update({ claimed_at: new Date().toISOString() } as never)
    .eq("id", job.id)
    .eq("restaurant_id", job.restaurantId)
    .eq("claimed_by", job.claimedBy)
    .eq("status", "processing")
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Fencing check: verify, via a fresh read, that this worker still holds
 * the claim on `job` right now. Called immediately before starting the
 * extraction call (the expensive, billed, side-effecting work) — a
 * worker that has been reclaimed must not start a new attempt, even
 * though its own in-memory claim object still looks valid.
 */
export async function isStillClaimed(
  supabase: SupabaseClient<Database>,
  job: ClaimedInvoiceExtractJob,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("background_jobs")
    .select("id")
    .eq("id", job.id)
    .eq("restaurant_id", job.restaurantId)
    .eq("claimed_by", job.claimedBy)
    .eq("status", "processing")
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/**
 * Run `work`, renewing the claim lease every `intervalMs` while it's in
 * flight, so a worker that is still alive and making progress on a
 * slow-but-legitimate call is never spuriously reclaimed as stuck.
 *
 * This closes the common case, not every case: if a renewal ever finds
 * the lease already gone (reclaimed by someone else — e.g. clock skew, a
 * run of missed heartbeats), there is no way to cancel the in-flight call
 * — `processInvoiceScanOnce` is an external black box with no
 * cancellation hook, so the call keeps running to completion either way.
 * What guarantees correctness in that residual case is the *other* two
 * layers: the pre-call fencing check (`isStillClaimed`, checked once
 * immediately before this function is invoked — see
 * invoice-extract-handler.ts) stops a worker that has *already* lost the
 * lease from starting a *new* attempt, and the fenced completion writes
 * (complete.ts) stop a worker whose lease was lost *during* the call from
 * ever persisting that call's outcome as this job's result.
 */
export async function withClaimHeartbeat<T>(
  supabase: SupabaseClient<Database>,
  job: ClaimedInvoiceExtractJob,
  intervalMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    // Best-effort renewal. A failure here doesn't change what `work` is
    // doing — it can't be cancelled — so there's nothing more to do than
    // let the next tick (or the fenced completion write) sort it out.
    renewClaim(supabase, job).catch(() => {});
  }, intervalMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
