import { hostname } from "node:os";
import { z } from "zod";

const integer = (minimum: number, maximum: number, fallback: number) =>
  z.preprocess(
    (value) => (value == null || value === "" ? fallback : Number(value)),
    z.number().int().min(minimum).max(maximum),
  );

const workerEnvironmentSchema = z
  .object({
    NEXT_PUBLIC_SUPABASE_URL: z.string().trim().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1),
    PORT: integer(1, 65_535, 3001),
    WORKER_ID: z.string().trim().min(1).max(128).optional(),
    WORKER_CONCURRENCY: integer(1, 20, 4),
    WORKER_CLAIM_LIMIT: integer(1, 20, 4),
    WORKER_POLL_INTERVAL_MS: integer(100, 60_000, 1_000),
    WORKER_LEASE_SECONDS: integer(15, 3_600, 120),
    WORKER_HEARTBEAT_INTERVAL_MS: integer(1_000, 1_200_000, 30_000),
    WORKER_DATABASE_TIMEOUT_MS: integer(100, 60_000, 10_000),
    WORKER_DATABASE_ERROR_BACKOFF_MAX_MS: integer(100, 300_000, 30_000),
    WORKER_JOB_TIMEOUT_MS: integer(1_000, 3_600_000, 900_000),
    WORKER_SHUTDOWN_GRACE_MS: integer(1_000, 300_000, 25_000),
    WORKER_BACKOFF_BASE_SECONDS: integer(1, 3_600, 30),
    WORKER_QUEUE_HEALTH_INTERVAL_MS: integer(1_000, 300_000, 10_000),
    WORKER_HEALTH_STALE_AFTER_MS: integer(5_000, 600_000, 60_000),
    WORKER_QUEUE_AGE_ALERT_MS: integer(1_000, 86_400_000, 300_000),
    WORKER_DEAD_LETTER_ALERT_COUNT: integer(1, 1_000_000, 1),
    RAILWAY_ENVIRONMENT_NAME: z.string().trim().min(1).optional(),
    RAILWAY_GIT_COMMIT_SHA: z.string().trim().min(7).max(64).optional(),
    RAILWAY_REPLICA_ID: z.string().trim().min(1).max(64).optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.WORKER_CLAIM_LIMIT > value.WORKER_CONCURRENCY) {
      context.addIssue({
        code: "custom",
        path: ["WORKER_CLAIM_LIMIT"],
        message: "must not exceed WORKER_CONCURRENCY",
      });
    }
    if (value.WORKER_HEARTBEAT_INTERVAL_MS >= value.WORKER_LEASE_SECONDS * 500) {
      context.addIssue({
        code: "custom",
        path: ["WORKER_HEARTBEAT_INTERVAL_MS"],
        message: "must be less than half the lease duration",
      });
    }
    if (value.WORKER_DATABASE_TIMEOUT_MS >= value.WORKER_HEARTBEAT_INTERVAL_MS) {
      context.addIssue({
        code: "custom",
        path: ["WORKER_DATABASE_TIMEOUT_MS"],
        message: "must be less than WORKER_HEARTBEAT_INTERVAL_MS",
      });
    }
    if (value.WORKER_DATABASE_ERROR_BACKOFF_MAX_MS < value.WORKER_POLL_INTERVAL_MS) {
      context.addIssue({
        code: "custom",
        path: ["WORKER_DATABASE_ERROR_BACKOFF_MAX_MS"],
        message: "must be at least WORKER_POLL_INTERVAL_MS",
      });
    }
    if (value.WORKER_HEALTH_STALE_AFTER_MS <= value.WORKER_QUEUE_HEALTH_INTERVAL_MS) {
      context.addIssue({
        code: "custom",
        path: ["WORKER_HEALTH_STALE_AFTER_MS"],
        message: "must exceed WORKER_QUEUE_HEALTH_INTERVAL_MS",
      });
    }
  });

export type WorkerConfig = ReturnType<typeof parseWorkerConfig>;

type WorkerEnvironment = Record<string, string | undefined>;

function generatedWorkerId(env: WorkerEnvironment): string {
  const replica = env.RAILWAY_REPLICA_ID?.trim() || String(process.pid);
  return `${hostname()}-${replica}`.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128);
}

export function parseWorkerConfig(env: WorkerEnvironment = process.env) {
  const result = workerEnvironmentSchema.safeParse(env);
  if (!result.success) {
    const names = [
      ...new Set(
        result.error.issues.map((issue) => String(issue.path[0] ?? "WORKER_CONFIG")),
      ),
    ];
    throw new Error(`Invalid worker configuration: ${names.join(", ")}`);
  }

  return Object.freeze({
    supabaseUrl: result.data.NEXT_PUBLIC_SUPABASE_URL,
    serviceRoleKey: result.data.SUPABASE_SERVICE_ROLE_KEY,
    port: result.data.PORT,
    workerId: result.data.WORKER_ID ?? generatedWorkerId(env),
    concurrency: result.data.WORKER_CONCURRENCY,
    claimLimit: result.data.WORKER_CLAIM_LIMIT,
    pollIntervalMs: result.data.WORKER_POLL_INTERVAL_MS,
    leaseSeconds: result.data.WORKER_LEASE_SECONDS,
    heartbeatIntervalMs: result.data.WORKER_HEARTBEAT_INTERVAL_MS,
    databaseTimeoutMs: result.data.WORKER_DATABASE_TIMEOUT_MS,
    databaseErrorBackoffMaxMs:
      result.data.WORKER_DATABASE_ERROR_BACKOFF_MAX_MS,
    jobTimeoutMs: result.data.WORKER_JOB_TIMEOUT_MS,
    shutdownGraceMs: result.data.WORKER_SHUTDOWN_GRACE_MS,
    baseBackoffSeconds: result.data.WORKER_BACKOFF_BASE_SECONDS,
    queueHealthIntervalMs: result.data.WORKER_QUEUE_HEALTH_INTERVAL_MS,
    healthStaleAfterMs: result.data.WORKER_HEALTH_STALE_AFTER_MS,
    queueAgeAlertMs: result.data.WORKER_QUEUE_AGE_ALERT_MS,
    deadLetterAlertCount: result.data.WORKER_DEAD_LETTER_ALERT_COUNT,
    environment: result.data.RAILWAY_ENVIRONMENT_NAME ?? "unknown",
    release: result.data.RAILWAY_GIT_COMMIT_SHA ?? "unknown",
  });
}
