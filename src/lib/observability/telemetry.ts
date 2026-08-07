import * as Sentry from "@sentry/nextjs";
import { getApiRequestContext } from "@/lib/api/request-context";

export type MetricName =
  | "auth_failures"
  | "scan_latency_ms"
  | "scan_errors"
  | "list_generation"
  | "reconciliation";

type SafeFieldValue = string | number | boolean | undefined;
type SafeFields = Record<string, SafeFieldValue>;

const SENSITIVE_KEY = /(?:authorization|cookie|email|password|secret|token|api[_-]?key|dsn|url|body|error|stack)/i;
const SAFE_ID_KEY = /(?:^|_)(?:request|restaurant|job|provider|scan|list)_id$/;

function redact(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return "[REDACTED]";
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  }
  return "[REDACTED]";
}

function withCorrelation(fields: SafeFields): SafeFields {
  const context = getApiRequestContext();
  return {
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "unknown",
    service: "terroir-web",
    request_id: context?.requestId,
    restaurant_id: context?.restaurantId,
    ...fields,
  };
}

/** Emits a machine-readable event while rejecting PII and secret-shaped keys. */
export function emitStructuredLog(eventName: string, fields: SafeFields = {}): void {
  const safeFields = Object.fromEntries(
    Object.entries(withCorrelation(fields)).map(([key, value]) => [key, redact(value, key)]),
  );
  console.info(JSON.stringify({ event: eventName, ...safeFields }));
}

/**
 * Record a count/distribution in Sentry when available and always leave a
 * structured, redacted event for Railway's log-derived metrics pipeline.
 */
export function recordMetric(name: MetricName, value = 1, fields: SafeFields = {}): void {
  emitStructuredLog("metric", { metric_name: name, metric_value: value, ...fields });
  try {
    const safeFields = withCorrelation(fields);
    const metrics = (Sentry as typeof Sentry & {
      metrics?: { count?: (name: string, value: number, options?: { tags?: Record<string, string> }) => void; distribution?: (name: string, value: number, options?: { tags?: Record<string, string> }) => void };
    }).metrics;
    const tags = Object.fromEntries(Object.entries(safeFields).filter(([key, value]) => value !== undefined && !SENSITIVE_KEY.test(key) && (SAFE_ID_KEY.test(key) || ["environment", "service", "operation", "outcome", "status"].includes(key))).map(([key, value]) => [key, String(value)]));
    if (name.endsWith("_ms")) metrics?.distribution?.(name, value, { tags });
    else metrics?.count?.(name, value, { tags });
  } catch {
    // Telemetry must never alter the caller's behavior.
  }
}
