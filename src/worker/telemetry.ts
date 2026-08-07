import type { WorkerEventFields, WorkerTelemetry } from "./types.ts";

const SAFE_FIELD_NAMES = new Set([
  "active_jobs",
  "attempt_count",
  "capacity",
  "dead_lettered",
  "duration_ms",
  "environment",
  "error_code",
  "job_id",
  "job_type",
  "metric_name",
  "metric_value",
  "oldest_queue_age_ms",
  "outcome",
  "queue_depth",
  "release",
  "retrying",
  "service",
  "signal",
  "status",
  "worker_id",
]);
const SAFE_VALUE = /^[A-Za-z0-9_.:/-]{1,160}$/;

function safeFields(fields: WorkerEventFields): WorkerEventFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (!SAFE_FIELD_NAMES.has(key)) return [key, "[REDACTED]"];
      if (value == null || typeof value === "number" || typeof value === "boolean") {
        return [key, value];
      }
      return [key, SAFE_VALUE.test(value) ? value : "[REDACTED]"];
    }),
  );
}

export function createWorkerTelemetry(input: {
  workerId: string;
  environment: string;
  release: string;
  write?: (line: string) => void;
}): WorkerTelemetry {
  const write = input.write ?? console.info;
  return {
    emit(event, fields = {}) {
      write(
        JSON.stringify({
          event,
          ...safeFields({
            ...fields,
            environment: input.environment,
            release: input.release,
            service: "terroir-worker",
            worker_id: input.workerId,
          }),
        }),
      );
    },
  };
}
