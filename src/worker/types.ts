export const JOB_TYPES = [
  "invoice_ocr",
  "wine_enrichment",
  "wine_list_pdf",
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export type BackgroundJob = {
  id: string;
  job_type: string;
  attempt_count: number;
  max_attempts: number;
  lease_token: string | null;
  metadata: unknown;
  restaurant_id: string;
  subject_id: string | null;
  subject_table: string | null;
  status: string;
};

export type JobResult = Record<string, unknown>;

export type JobHandler = (
  job: Readonly<BackgroundJob>,
  signal: AbortSignal,
) => Promise<JobResult>;

export type JobHandlers = Partial<Record<JobType, JobHandler>>;

export type QueueHealth = {
  queued: number;
  retrying: number;
  running: number;
  deadLettered: number;
  oldestQueuedAt: string | null;
};

export type JobFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

export interface JobStore {
  claim(input: {
    workerId: string;
    limit: number;
    leaseSeconds: number;
    baseBackoffSeconds: number;
  }): Promise<BackgroundJob[]>;
  heartbeat(job: BackgroundJob, workerId: string, leaseSeconds: number): Promise<void>;
  complete(job: BackgroundJob, workerId: string, result: JobResult): Promise<void>;
  fail(job: BackgroundJob, workerId: string, failure: JobFailure, baseBackoffSeconds: number): Promise<"failed" | "retrying">;
  queueHealth(): Promise<QueueHealth>;
}

export type WorkerEventFields = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface WorkerTelemetry {
  emit(event: string, fields?: WorkerEventFields): void;
}
