import { JobExecutionError } from "./errors.ts";
import type {
  BackgroundJob,
  JobHandler,
  JobHandlers,
  JobResult,
} from "./types.ts";

function handlerFor(handlers: JobHandlers, job: BackgroundJob): JobHandler {
  const handler = handlers[job.job_type as keyof JobHandlers];
  if (handler) return handler;
  throw new JobExecutionError(
    "unsupported_job_type",
    false,
    "No deployed handler accepts this background job type",
  );
}

function validateResult(result: JobResult): JobResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new JobExecutionError(
      "invalid_job_result",
      false,
      "Background job returned a non-serializable result",
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > 900_000) {
    throw new JobExecutionError(
      "invalid_job_result",
      false,
      "Background job result exceeded the safe size limit",
    );
  }
  return result;
}

export async function runJobHandler(
  handlers: JobHandlers,
  job: BackgroundJob,
  signal: AbortSignal,
  raceWithAbort: <T>(task: Promise<T>, signal: AbortSignal) => Promise<T>,
): Promise<JobResult> {
  return validateResult(
    await raceWithAbort(handlerFor(handlers, job)(job, signal), signal),
  );
}
