import { z } from "zod";

export const BACKGROUND_JOB_PROGRESS_SELECT = [
  "attempt_count",
  "created_at",
  "dead_lettered_at",
  "finished_at",
  "id",
  "job_type",
  "max_attempts",
  "restaurant_id",
  "run_after",
  "started_at",
  "status",
  "subject_id",
  "subject_table",
  "updated_at",
].join(", ");

export const BackgroundJobSummarySchema = z
  .object({
    attempt_count: z.number().int().nonnegative(),
    created_at: z.string().min(1),
    dead_lettered_at: z.string().min(1).nullable(),
    finished_at: z.string().min(1).nullable(),
    id: z.string().uuid(),
    job_type: z.enum(["invoice_ocr", "wine_enrichment", "wine_list_pdf"]),
    max_attempts: z.number().int().positive(),
    restaurant_id: z.string().uuid(),
    run_after: z.string().min(1),
    started_at: z.string().min(1).nullable(),
    status: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "retrying",
      "cancelled",
    ]),
    subject_id: z.string().uuid().nullable(),
    subject_table: z.string().nullable(),
    updated_at: z.string().min(1),
  })
  .strict();

export type BackgroundJobSummary = z.infer<
  typeof BackgroundJobSummarySchema
>;

export type BackgroundJobDisplayState =
  | "queued"
  | "running"
  | "retrying"
  | "failed"
  | "dead_letter"
  | "succeeded"
  | "cancelled";

export const BACKGROUND_JOB_ACTIVE_POLL_MS = 5_000;
export const BACKGROUND_JOB_IDLE_POLL_MS = 15_000;
export const BACKGROUND_JOB_MAX_POLL_WINDOW_MS = 5 * 60_000;

export function parseBackgroundJobSummaries(
  value: unknown,
): BackgroundJobSummary[] {
  return z.array(BackgroundJobSummarySchema).parse(value);
}

export function backgroundJobDisplayState(
  job: BackgroundJobSummary,
): BackgroundJobDisplayState {
  if (job.status === "failed" && job.dead_lettered_at !== null) {
    return "dead_letter";
  }
  return job.status;
}

export function isBackgroundJobActive(job: BackgroundJobSummary): boolean {
  return ["queued", "running", "retrying"].includes(job.status);
}

export function backgroundJobPollDelay(
  jobs: readonly BackgroundJobSummary[],
  elapsedMs: number,
): number | null {
  const remainingMs = BACKGROUND_JOB_MAX_POLL_WINDOW_MS - elapsedMs;
  if (remainingMs <= 0) return null;
  const interval = jobs.some(isBackgroundJobActive)
    ? BACKGROUND_JOB_ACTIVE_POLL_MS
    : BACKGROUND_JOB_IDLE_POLL_MS;
  return Math.min(interval, remainingMs);
}

export function backgroundJobLabel(job: BackgroundJobSummary): string {
  switch (job.job_type) {
    case "invoice_ocr":
      return "Invoice processing";
    case "wine_enrichment":
      return "Wine enrichment";
    case "wine_list_pdf":
      return "Wine-list PDF";
  }
}

export function backgroundJobHref(job: BackgroundJobSummary): string {
  if (job.job_type === "invoice_ocr") {
    return job.subject_id === null ? "/scan" : `/scan/${job.subject_id}`;
  }
  if (job.job_type === "wine_list_pdf") {
    return job.subject_id === null ? "/lists" : `/lists/${job.subject_id}`;
  }
  return "/cellar";
}

export function backgroundJobStatusCopy(job: BackgroundJobSummary): {
  detail: string;
  label: string;
} {
  const attempt = Math.max(1, job.attempt_count);
  switch (backgroundJobDisplayState(job)) {
    case "queued":
      return { label: "Queued", detail: "Waiting to start" };
    case "running":
      return {
        label: "Running",
        detail: `Attempt ${attempt} of ${job.max_attempts} is in progress`,
      };
    case "retrying":
      return {
        label: "Retrying",
        detail: `Attempt ${attempt} did not finish; another attempt is queued`,
      };
    case "failed":
      return {
        label: "Failed",
        detail: "This work could not finish",
      };
    case "dead_letter":
      return {
        label: "Dead-lettered",
        detail: `Stopped after ${job.attempt_count} attempt${job.attempt_count === 1 ? "" : "s"}`,
      };
    case "succeeded":
      return { label: "Succeeded", detail: "Work completed" };
    case "cancelled":
      return { label: "Cancelled", detail: "Work was cancelled" };
  }
}
