export type ScannerProviderFailureKind =
  | "rate_limited"
  | "timeout"
  | "bad_input"
  | "unavailable"
  | "unknown";

export type ScannerProviderFailure = {
  kind: ScannerProviderFailureKind;
  retryable: boolean;
  httpStatus: 400 | 429 | 500 | 502 | 504;
};

function recordValue(error: unknown, key: string): unknown {
  if (!error || typeof error !== "object") return undefined;
  return (error as Record<string, unknown>)[key];
}

function numericStatus(error: unknown): number | undefined {
  const status = recordValue(error, "status");
  if (typeof status === "number") return status;
  const statusCode = recordValue(error, "statusCode");
  if (typeof statusCode === "number") return statusCode;
  if (typeof statusCode === "string" && /^\d{3}$/.test(statusCode)) {
    return Number(statusCode);
  }
  return undefined;
}

/**
 * Collapse provider-specific exceptions into the release taxonomy. This helper
 * intentionally never reads or returns provider messages, response bodies,
 * request IDs, invoice text, or image metadata.
 */
export function classifyScannerProviderFailure(
  error: unknown,
): ScannerProviderFailure {
  const status = numericStatus(error);
  const code = String(recordValue(error, "code") ?? "").toUpperCase();
  const name = String(
    error instanceof Error ? error.name : (recordValue(error, "name") ?? ""),
  );

  if (status === 429 || code === "RATE_LIMITED") {
    return { kind: "rate_limited", retryable: true, httpStatus: 429 };
  }
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    code === "ABORT_ERR" ||
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED" ||
    status === 408
  ) {
    return { kind: "timeout", retryable: true, httpStatus: 504 };
  }
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return { kind: "bad_input", retryable: false, httpStatus: 400 };
  }
  if (
    (status !== undefined && status >= 500) ||
    ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code)
  ) {
    return { kind: "unavailable", retryable: true, httpStatus: 502 };
  }
  return { kind: "unknown", retryable: false, httpStatus: 500 };
}
