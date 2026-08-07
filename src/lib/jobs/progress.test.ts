import { describe, expect, it } from "vitest";
import {
  BACKGROUND_JOB_ACTIVE_POLL_MS,
  BACKGROUND_JOB_IDLE_POLL_MS,
  BACKGROUND_JOB_MAX_POLL_WINDOW_MS,
  backgroundJobDisplayState,
  backgroundJobHref,
  backgroundJobPollDelay,
  backgroundJobStatusCopy,
  parseBackgroundJobSummaries,
  type BackgroundJobSummary,
} from "./progress";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";
const SUBJECT_ID = "33333333-3333-4333-8333-333333333333";

function job(
  overrides: Partial<BackgroundJobSummary> = {},
): BackgroundJobSummary {
  return {
    attempt_count: 0,
    created_at: "2026-08-07T12:00:00.000Z",
    dead_lettered_at: null,
    finished_at: null,
    id: JOB_ID,
    job_type: "invoice_ocr",
    max_attempts: 3,
    restaurant_id: RESTAURANT_ID,
    run_after: "2026-08-07T12:00:00.000Z",
    started_at: null,
    status: "queued",
    subject_id: SUBJECT_ID,
    subject_table: "invoice_scans",
    updated_at: "2026-08-07T12:00:00.000Z",
    ...overrides,
  };
}

describe("background job progress model", () => {
  it("maps every durable lifecycle state without conflating failure and dead letter", () => {
    expect(backgroundJobStatusCopy(job()).label).toBe("Queued");
    expect(backgroundJobStatusCopy(job({ status: "running", attempt_count: 1 })).label)
      .toBe("Running");
    expect(backgroundJobStatusCopy(job({ status: "retrying", attempt_count: 1 })).label)
      .toBe("Retrying");
    expect(backgroundJobDisplayState(job({ status: "failed" }))).toBe("failed");
    expect(backgroundJobStatusCopy(job({ status: "failed" })).label).toBe("Failed");
    const deadLetter = job({
      status: "failed",
      attempt_count: 3,
      dead_lettered_at: "2026-08-07T12:05:00.000Z",
      finished_at: "2026-08-07T12:05:00.000Z",
    });
    expect(backgroundJobDisplayState(deadLetter)).toBe("dead_letter");
    expect(backgroundJobStatusCopy(deadLetter)).toEqual({
      label: "Dead-lettered",
      detail: "Stopped after 3 attempts",
    });
    expect(backgroundJobStatusCopy(job({ status: "succeeded" })).label)
      .toBe("Succeeded");
    expect(backgroundJobStatusCopy(job({ status: "cancelled" })).label)
      .toBe("Cancelled");
  });

  it("links only to the owning long-running surface", () => {
    expect(backgroundJobHref(job())).toBe(`/scan/${SUBJECT_ID}`);
    expect(backgroundJobHref(job({ job_type: "wine_enrichment" }))).toBe(
      "/cellar",
    );
    expect(backgroundJobHref(job({ job_type: "wine_list_pdf" }))).toBe(
      `/lists/${SUBJECT_ID}`,
    );
  });

  it("bounds active and discovery polling to five minutes", () => {
    expect(backgroundJobPollDelay([job()], 0)).toBe(
      BACKGROUND_JOB_ACTIVE_POLL_MS,
    );
    expect(backgroundJobPollDelay([job({ status: "succeeded" })], 0)).toBe(
      BACKGROUND_JOB_IDLE_POLL_MS,
    );
    expect(
      backgroundJobPollDelay([job()], BACKGROUND_JOB_MAX_POLL_WINDOW_MS - 1),
    ).toBe(1);
    expect(
      backgroundJobPollDelay([job()], BACKGROUND_JOB_MAX_POLL_WINDOW_MS),
    ).toBeNull();
  });

  it("rejects unrecognized provider rows at the client boundary", () => {
    expect(() =>
      parseBackgroundJobSummaries([{ ...job(), status: "processing" }]),
    ).toThrow();
    expect(() =>
      parseBackgroundJobSummaries([{ ...job(), restaurant_id: "other" }]),
    ).toThrow();
  });
});
