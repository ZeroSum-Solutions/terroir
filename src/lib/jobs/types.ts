// G1-6 — shared types for the invoice_extract job runner.

/** A job row immediately after `claim_invoice_extract_job` claims it. */
export type ClaimedInvoiceExtractJob = {
  id: string;
  restaurantId: string;
  createdBy: string | null;
  subjectId: string | null;
  attemptCount: number;
  maxAttempts: number;
  claimedBy: string;
};

/** What running the claimed job's work produced. */
export type JobOutcome =
  | { kind: "succeeded"; skippedExtraction: boolean }
  | { kind: "retry"; code: string; message: string }
  | { kind: "dead"; code: string; message: string };

export type EnqueueInvoiceExtractJobResult = {
  jobId: string;
  /** false when an existing job for this idempotency key was returned instead of a new one. */
  created: boolean;
};

export type ProcessOneJobResult =
  | { processed: false }
  | { processed: true; jobId: string; outcome: JobOutcome["kind"] };
