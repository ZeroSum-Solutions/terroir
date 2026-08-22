// G1-6 — background job runner constants.
//
// Scoped to a single job type on purpose (see plan bar: "not a generic
// platform"). If a second job type ever rides this table, these constants
// should become per-job-type, not be generalized speculatively now.

/** The only job type this runner claims and executes. */
export const INVOICE_EXTRACT_JOB_TYPE = "invoice_extract" as const;

/** Storage bucket holding the uploaded invoice images. */
export const INVOICE_IMAGE_BUCKET = "invoice-images";

/** Attempts allowed before a job is marked `dead` (terminal). */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** Exponential backoff base and cap for retryable failures. */
export const BASE_BACKOFF_MS = 30_000;
export const MAX_BACKOFF_MS = 15 * 60_000;

/** A "processing" job claimed longer than this is considered stuck. */
export const STUCK_AFTER_SECONDS = 5 * 60;

/**
 * While a claimed job is actively being worked (the extraction call, which
 * has no bounded timeout and can legitimately run for a while), the claim
 * lease is renewed this often so a worker that is slow but alive is never
 * spuriously reclaimed as stuck. A third of the stuck threshold tolerates
 * up to one missed/delayed heartbeat before the reclaim sweep could fire.
 */
export const HEARTBEAT_INTERVAL_MS = (STUCK_AFTER_SECONDS * 1_000) / 3;

/** Worker loop tuning. */
export const POLL_INTERVAL_MS = 5_000;
export const RECLAIM_SWEEP_INTERVAL_MS = 60_000;

/**
 * `processInvoiceScanOnce` requires a userId, but every job-runner call
 * passes `preCreatedScanId`, which skips the only code path that reads it
 * (creating a fresh invoice_scans row). This placeholder documents that
 * the value is inert on the job-runner path rather than reusing an
 * unrelated id (e.g. restaurantId) that could be misread as a real user.
 */
export const SYSTEM_USER_PLACEHOLDER = "background-worker";
