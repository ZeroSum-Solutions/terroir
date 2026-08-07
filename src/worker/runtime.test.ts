import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWorkerConfig } from "./config.ts";
import { WorkerRuntime } from "./runtime.ts";
import type {
  BackgroundJob,
  JobFailure,
  JobResult,
  JobStore,
  QueueHealth,
  WorkerEventFields,
} from "./types.ts";

const job = (overrides: Partial<BackgroundJob> = {}): BackgroundJob => ({
  id: "11111111-1111-1111-1111-111111111111",
  job_type: "wine_list_pdf",
  attempt_count: 1,
  max_attempts: 3,
  lease_token: "22222222-2222-2222-2222-222222222222",
  metadata: {},
  restaurant_id: "33333333-3333-3333-3333-333333333333",
  subject_id: null,
  subject_table: null,
  status: "running",
  ...overrides,
});

const config = (overrides: Record<string, string> = {}) =>
  parseWorkerConfig({
    NEXT_PUBLIC_SUPABASE_URL: "https://staging-project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "staging-service-role-key",
    WORKER_ID: "test-worker",
    WORKER_CONCURRENCY: "2",
    WORKER_CLAIM_LIMIT: "2",
    WORKER_HEARTBEAT_INTERVAL_MS: "1000",
    WORKER_DATABASE_TIMEOUT_MS: "500",
    WORKER_LEASE_SECONDS: "15",
    WORKER_JOB_TIMEOUT_MS: "5000",
    WORKER_SHUTDOWN_GRACE_MS: "1000",
    WORKER_QUEUE_HEALTH_INTERVAL_MS: "1000",
    WORKER_HEALTH_STALE_AFTER_MS: "5000",
    ...overrides,
  });

class FakeStore implements JobStore {
  claims: BackgroundJob[][] = [];
  heartbeats: string[] = [];
  completions: Array<{ id: string; result: JobResult }> = [];
  failures: Array<{ id: string; failure: JobFailure }> = [];
  health: QueueHealth = {
    queued: 0,
    retrying: 0,
    running: 0,
    deadLettered: 0,
    oldestQueuedAt: null,
  };
  heartbeatError = false;
  completeError = false;

  async claim(input: { limit: number }): Promise<BackgroundJob[]> {
    return (this.claims.shift() ?? []).slice(0, input.limit);
  }
  async heartbeat(current: BackgroundJob): Promise<void> {
    this.heartbeats.push(current.id);
    if (this.heartbeatError) throw new Error("lease expired");
  }
  async complete(current: BackgroundJob, _workerId: string, result: JobResult) {
    if (this.completeError) throw new Error("response lost");
    this.completions.push({ id: current.id, result });
  }
  async fail(current: BackgroundJob, _workerId: string, failure: JobFailure) {
    this.failures.push({ id: current.id, failure });
    return failure.retryable && current.attempt_count < current.max_attempts
      ? "retrying" as const
      : "failed" as const;
  }
  async queueHealth(): Promise<QueueHealth> {
    return this.health;
  }
}

function telemetry() {
  const events: Array<{ event: string } & WorkerEventFields> = [];
  return {
    events,
    sink: {
      emit(event: string, fields: WorkerEventFields = {}) {
        events.push({ event, ...fields });
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("worker runtime", () => {
  it("observes health without claiming until a business handler is registered", async () => {
    const store = new FakeStore();
    store.claims.push([job()]);
    const runtime = new WorkerRuntime(config(), store, {}, telemetry().sink);

    expect(await runtime.pollOnce()).toBe(0);
    await runtime.refreshQueueHealth();
    expect(store.claims).toHaveLength(1);
    expect(runtime.snapshot()).toMatchObject({
      acceptingJobs: false,
      registeredHandlers: 0,
      status: "ready",
    });
  });

  it("claims within capacity and completes through the active lease", async () => {
    const store = new FakeStore();
    store.claims.push([job(), job({ id: "44444444-4444-4444-4444-444444444444" })]);
    const observedConcurrency: number[] = [];
    let active = 0;
    const runtime = new WorkerRuntime(
      config(),
      store,
      {
        wine_list_pdf: async (current) => {
          active += 1;
          observedConcurrency.push(active);
          await Promise.resolve();
          active -= 1;
          return { job_id: current.id };
        },
      },
      telemetry().sink,
    );

    expect(await runtime.pollOnce()).toBe(2);
    expect(await runtime.waitForIdle()).toBe(true);
    expect(store.completions).toHaveLength(2);
    expect(Math.max(...observedConcurrency)).toBeLessThanOrEqual(2);
    expect(runtime.snapshot()).toMatchObject({ activeJobs: 0, status: "ready" });
  });

  it("heartbeats long work and abandons completion after lease loss", async () => {
    vi.useFakeTimers();
    const store = new FakeStore();
    store.claims.push([job()]);
    store.heartbeatError = true;
    const runtime = new WorkerRuntime(
      config(),
      store,
      { wine_list_pdf: () => new Promise(() => {}) },
      telemetry().sink,
    );

    await runtime.pollOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await runtime.waitForIdle(1)).toBe(true);
    expect(store.heartbeats).toEqual([job().id]);
    expect(store.completions).toEqual([]);
    expect(store.failures).toEqual([]);
  });

  it("leaves an ambiguous completion for lease recovery instead of contradicting it", async () => {
    const store = new FakeStore();
    store.completeError = true;
    store.claims.push([job()]);
    const output = telemetry();
    const runtime = new WorkerRuntime(
      config(),
      store,
      { wine_list_pdf: async () => ({ artifact: "created" }) },
      output.sink,
    );

    await runtime.pollOnce();
    expect(await runtime.waitForIdle()).toBe(true);
    expect(store.failures).toEqual([]);
    expect(output.events).toContainEqual(
      expect.objectContaining({
        event: "job_completion_unknown",
        outcome: "unknown",
      }),
    );
  });

  it("retries timeouts and dead-letters unsupported jobs", async () => {
    vi.useFakeTimers();
    const store = new FakeStore();
    store.claims.push([job()]);
    const runtime = new WorkerRuntime(
      config(),
      store,
      { wine_list_pdf: () => new Promise(() => {}) },
      telemetry().sink,
    );

    await runtime.pollOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await runtime.waitForIdle(1)).toBe(true);
    expect(store.failures[0].failure).toMatchObject({
      code: "job_timeout",
      retryable: true,
    });

    const poisonStore = new FakeStore();
    poisonStore.claims.push([job({ job_type: "unknown_job" })]);
    const poisonRuntime = new WorkerRuntime(
      config(),
      poisonStore,
      { wine_list_pdf: async () => ({ unused: true }) },
      telemetry().sink,
    );
    await poisonRuntime.pollOnce();
    expect(await poisonRuntime.waitForIdle()).toBe(true);
    expect(poisonStore.failures[0].failure).toMatchObject({
      code: "unsupported_job_type",
      retryable: false,
    });
  });

  it("drains, then aborts overdue work into a retryable shutdown", async () => {
    vi.useFakeTimers();
    const store = new FakeStore();
    store.claims.push([job()]);
    const runtime = new WorkerRuntime(
      config(),
      store,
      { wine_list_pdf: () => new Promise(() => {}) },
      telemetry().sink,
    );
    await runtime.pollOnce();
    const stopping = runtime.stop("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();
    await stopping;

    expect(store.failures[0].failure).toMatchObject({
      code: "worker_shutdown",
      retryable: true,
    });
    expect(runtime.snapshot().status).toBe("draining");
    expect(await runtime.pollOnce()).toBe(0);
  });

  it("emits aggregate action-required telemetry without queue payloads", async () => {
    const store = new FakeStore();
    store.health = {
      queued: 3,
      retrying: 2,
      running: 1,
      deadLettered: 1,
      oldestQueuedAt: new Date(Date.now() - 301_000).toISOString(),
    };
    const output = telemetry();
    const runtime = new WorkerRuntime(config(), store, {}, output.sink);
    await runtime.refreshQueueHealth();

    expect(output.events).toContainEqual(
      expect.objectContaining({
        event: "worker_alert",
        dead_lettered: 1,
        queue_depth: 5,
        status: "action_required",
      }),
    );
    expect(runtime.snapshot().queue).toEqual(store.health);
  });

  it("fails readiness closed after database success becomes stale", async () => {
    let now = 1_000;
    const store = new FakeStore();
    const runtime = new WorkerRuntime(
      config(),
      store,
      { wine_list_pdf: async () => ({ unused: true }) },
      telemetry().sink,
      () => now,
    );
    await runtime.pollOnce();
    expect(runtime.snapshot().status).toBe("ready");
    now += 5_001;
    expect(runtime.snapshot().status).toBe("unhealthy");
  });
});
