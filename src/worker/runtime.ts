import { JobExecutionError, LeaseLostError, normalizeFailure } from "./errors.ts";
import { runJobHandler } from "./run-job-handler.ts";
import type { WorkerConfig } from "./config.ts";
import type {
  BackgroundJob,
  JobHandlers,
  JobResult,
  JobStore,
  QueueHealth,
  WorkerTelemetry,
} from "./types.ts";

type ActiveJob = { abort: AbortController; promise: Promise<void> };

export type WorkerSnapshot = {
  status: "starting" | "ready" | "draining" | "unhealthy";
  activeJobs: number;
  capacity: number;
  acceptingJobs: boolean;
  registeredHandlers: number;
  lastDatabaseSuccessAt: string | null;
  lastDatabaseFailureAt: string | null;
  queue: QueueHealth | null;
};

const delay = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

function withTimeout<T>(task: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Worker database operation timed out")),
      milliseconds,
    );
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function raceWithAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error("Operation aborted"));
    signal.addEventListener("abort", aborted, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

export class WorkerRuntime {
  private readonly active = new Map<string, ActiveJob>();
  private readonly loopAbort = new AbortController();
  private readonly config: WorkerConfig;
  private readonly store: JobStore;
  private readonly handlers: JobHandlers;
  private readonly telemetry: WorkerTelemetry;
  private readonly now: () => number;
  private readonly handlerCount: number;
  private isStopping = false;
  private lastDatabaseSuccessAt: number | null = null;
  private lastDatabaseFailureAt: number | null = null;
  private consecutiveDatabaseFailures = 0;
  private queue: QueueHealth | null = null;

  constructor(
    config: WorkerConfig,
    store: JobStore,
    handlers: JobHandlers,
    telemetry: WorkerTelemetry,
    now: () => number = Date.now,
  ) {
    this.config = config;
    this.store = store;
    this.handlers = handlers;
    this.telemetry = telemetry;
    this.now = now;
    this.handlerCount = Object.keys(handlers).length;
  }

  snapshot(): WorkerSnapshot {
    const age = this.lastDatabaseSuccessAt == null
      ? Number.POSITIVE_INFINITY
      : this.now() - this.lastDatabaseSuccessAt;
    const status = this.isStopping
      ? "draining"
      : this.lastDatabaseSuccessAt != null && age > this.config.healthStaleAfterMs
        ? "unhealthy"
        : this.lastDatabaseSuccessAt == null
          ? "starting"
          : "ready";
    return {
      status,
      activeJobs: this.active.size,
      capacity: Math.max(0, this.config.concurrency - this.active.size),
      acceptingJobs: !this.isStopping && this.handlerCount > 0,
      registeredHandlers: this.handlerCount,
      lastDatabaseSuccessAt: this.toIso(this.lastDatabaseSuccessAt),
      lastDatabaseFailureAt: this.toIso(this.lastDatabaseFailureAt),
      queue: this.queue,
    };
  }

  async pollOnce(): Promise<number> {
    const capacity = this.config.concurrency - this.active.size;
    if (this.isStopping || this.handlerCount === 0 || capacity <= 0) return 0;
    try {
      const jobs = await withTimeout(
        this.store.claim({
          workerId: this.config.workerId,
          limit: Math.min(capacity, this.config.claimLimit),
          leaseSeconds: this.config.leaseSeconds,
          baseBackoffSeconds: this.config.baseBackoffSeconds,
        }),
        this.config.databaseTimeoutMs,
      );
      this.lastDatabaseSuccessAt = this.now();
      this.consecutiveDatabaseFailures = 0;
      for (const job of jobs.slice(0, capacity)) this.startJob(job);
      if (jobs.length > 0) {
        this.metric("jobs_claimed", jobs.length, { outcome: "claimed" });
      }
      return jobs.length;
    } catch {
      this.databaseFailure("claim_failed");
      return 0;
    }
  }

  async refreshQueueHealth(): Promise<void> {
    try {
      this.queue = await withTimeout(
        this.store.queueHealth(),
        this.config.databaseTimeoutMs,
      );
      this.lastDatabaseSuccessAt = this.now();
      this.consecutiveDatabaseFailures = 0;
      const queueDepth = this.queue.queued + this.queue.retrying;
      const oldestAge = this.queue.oldestQueuedAt
        ? Math.max(0, this.now() - Date.parse(this.queue.oldestQueuedAt))
        : 0;
      this.metric("queue_depth", queueDepth);
      this.metric("dead_letter_count", this.queue.deadLettered);
      if (
        oldestAge >= this.config.queueAgeAlertMs ||
        this.queue.deadLettered >= this.config.deadLetterAlertCount
      ) {
        this.telemetry.emit("worker_alert", {
          dead_lettered: this.queue.deadLettered,
          oldest_queue_age_ms: oldestAge,
          queue_depth: queueDepth,
          status: "action_required",
        });
      }
    } catch {
      this.databaseFailure("queue_health_failed");
    }
  }

  async run(): Promise<void> {
    this.telemetry.emit("worker_started", { status: "starting" });
    let lastHealthRefresh = 0;
    while (!this.isStopping) {
      await this.pollOnce();
      if (this.now() - lastHealthRefresh >= this.config.queueHealthIntervalMs) {
        await this.refreshQueueHealth();
        lastHealthRefresh = this.now();
      }
      await delay(this.nextPollDelay(), this.loopAbort.signal);
    }
  }

  async stop(signal = "shutdown"): Promise<void> {
    if (this.isStopping) return;
    this.isStopping = true;
    this.loopAbort.abort();
    this.telemetry.emit("worker_draining", {
      active_jobs: this.active.size,
      signal,
      status: "draining",
    });
    if (await this.waitForIdle(this.config.shutdownGraceMs)) return;
    for (const { abort } of this.active.values()) {
      abort.abort(
        new JobExecutionError(
          "worker_shutdown",
          true,
          "Worker shut down before the background job completed",
        ),
      );
    }
    await this.waitForIdle(Math.min(5_000, this.config.shutdownGraceMs));
  }

  async waitForIdle(timeoutMs = 10_000): Promise<boolean> {
    if (this.active.size === 0) return true;
    const settled = Promise.allSettled(
      [...this.active.values()].map(({ promise }) => promise),
    ).then(() => true);
    return Promise.race([settled, delay(timeoutMs).then(() => false)]);
  }

  private startJob(job: BackgroundJob): void {
    if (this.active.has(job.id)) {
      this.telemetry.emit("job_duplicate_claim", {
        error_code: "duplicate_active_claim",
        job_id: job.id,
        job_type: job.job_type,
        outcome: "ignored",
      });
      return;
    }
    const abort = new AbortController();
    const promise = this.execute(job, abort).finally(() => this.active.delete(job.id));
    this.active.set(job.id, { abort, promise });
  }

  private async execute(job: BackgroundJob, abort: AbortController): Promise<void> {
    const startedAt = this.now();
    const timeout = setTimeout(
      () =>
        abort.abort(
          new JobExecutionError(
            "job_timeout",
            true,
            "Background job exceeded its execution timeout",
          ),
        ),
      this.config.jobTimeoutMs,
    );
    const stopHeartbeat = this.startHeartbeat(job, abort);
    let result: JobResult;
    try {
      result = await runJobHandler(
        this.handlers,
        job,
        abort.signal,
        raceWithAbort,
      );
    } catch (error) {
      stopHeartbeat();
      if (error instanceof LeaseLostError) {
        this.metric("jobs_lease_lost", 1, this.jobFields(job, startedAt, "lease_lost"));
        return;
      }
      await this.recordFailure(job, error, startedAt);
      clearTimeout(timeout);
      return;
    }
    stopHeartbeat();
    clearTimeout(timeout);
    try {
      await withTimeout(
        this.store.complete(job, this.config.workerId, result),
        this.config.databaseTimeoutMs,
      );
      this.metric("jobs_succeeded", 1, this.jobFields(job, startedAt, "succeeded"));
    } catch {
      this.telemetry.emit("job_completion_unknown", {
        error_code: "completion_unknown",
        job_id: job.id,
        job_type: job.job_type,
        outcome: "unknown",
      });
    }
  }

  private startHeartbeat(job: BackgroundJob, abort: AbortController): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const heartbeat = async () => {
      try {
        await withTimeout(
          this.store.heartbeat(job, this.config.workerId, this.config.leaseSeconds),
          this.config.databaseTimeoutMs,
        );
        if (!stopped) timer = setTimeout(heartbeat, this.config.heartbeatIntervalMs);
      } catch {
        abort.abort(new LeaseLostError());
      }
    };
    timer = setTimeout(heartbeat, this.config.heartbeatIntervalMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  private async recordFailure(
    job: BackgroundJob,
    error: unknown,
    startedAt: number,
  ): Promise<void> {
    const failure = normalizeFailure(error);
    try {
      const status = await withTimeout(
        this.store.fail(
          job,
          this.config.workerId,
          failure,
          this.config.baseBackoffSeconds,
        ),
        this.config.databaseTimeoutMs,
      );
      this.metric(
        status === "retrying" ? "jobs_retried" : "jobs_failed",
        1,
        { ...this.jobFields(job, startedAt, status), error_code: failure.code },
      );
    } catch {
      this.telemetry.emit("job_failure_record_unknown", {
        error_code: failure.code,
        job_id: job.id,
        job_type: job.job_type,
        outcome: "unknown",
      });
    }
  }

  private databaseFailure(errorCode: string): void {
    this.lastDatabaseFailureAt = this.now();
    this.consecutiveDatabaseFailures += 1;
    if (
      this.consecutiveDatabaseFailures === 1 ||
      (this.consecutiveDatabaseFailures & (this.consecutiveDatabaseFailures - 1)) === 0
    ) {
      this.telemetry.emit("worker_database_error", {
        error_code: errorCode,
        metric_value: this.consecutiveDatabaseFailures,
        outcome: "failed",
      });
    }
  }

  private nextPollDelay(): number {
    const exponent = Math.min(10, Math.max(0, this.consecutiveDatabaseFailures - 1));
    return Math.min(
      this.config.databaseErrorBackoffMaxMs,
      this.config.pollIntervalMs * 2 ** exponent,
    );
  }

  private jobFields(job: BackgroundJob, startedAt: number, outcome: string) {
    return {
      attempt_count: job.attempt_count,
      duration_ms: Math.max(0, this.now() - startedAt),
      job_id: job.id,
      job_type: job.job_type,
      outcome,
    };
  }

  private metric(name: string, value: number, fields = {}): void {
    this.telemetry.emit("metric", {
      ...fields,
      metric_name: name,
      metric_value: value,
    });
  }

  private toIso(value: number | null): string | null {
    return value == null ? null : new Date(value).toISOString();
  }
}
