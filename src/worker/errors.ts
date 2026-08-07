import type { JobFailure } from "./types.ts";

const SAFE_CODE = /^[a-z][a-z0-9_]{0,127}$/;

export class JobExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly safeMessage: string;

  constructor(
    code: string,
    retryable: boolean,
    safeMessage: string,
  ) {
    super(safeMessage);
    this.name = "JobExecutionError";
    this.code = code;
    this.retryable = retryable;
    this.safeMessage = safeMessage;
  }
}

export class LeaseLostError extends Error {
  constructor() {
    super("Background job lease is no longer active");
    this.name = "LeaseLostError";
  }
}

export function normalizeFailure(error: unknown): JobFailure {
  if (error instanceof JobExecutionError) {
    return {
      code: SAFE_CODE.test(error.code) ? error.code : "job_failed",
      message: error.safeMessage.slice(0, 2_000),
      retryable: error.retryable,
    };
  }
  return {
    code: "job_failed",
    message: "Background job failed without a safe public error",
    retryable: true,
  };
}
