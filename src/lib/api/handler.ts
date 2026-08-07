import * as Sentry from "@sentry/nextjs";
import { Errors } from "./errors";
import {
  applyApiRequestHeaders,
  runWithApiRequestContext,
} from "./request-context";
import { recordMetric } from "@/lib/observability/telemetry";

type ObservedOperation = "scan" | "list_generation" | "reconciliation";

export async function withApiHandler(
  operation: () => Response | Promise<Response>,
  observability?: { operation: ObservedOperation },
): Promise<Response> {
  return runWithApiRequestContext(async () => {
    const startedAt = performance.now();
    try {
      const response = applyApiRequestHeaders(await operation());
      recordOutcome(observability?.operation, response.status, performance.now() - startedAt);
      return response;
    } catch (error) {
      try {
        Sentry.captureException(error);
      } catch {
        // Error reporting must never replace the redacted client response.
      }
      const response = applyApiRequestHeaders(Errors.internal());
      recordOutcome(observability?.operation, response.status, performance.now() - startedAt);
      return response;
    }
  });
}

function recordOutcome(operation: ObservedOperation | undefined, status: number, durationMs: number): void {
  if (!operation) return;
  const outcome = status >= 400 ? "error" : "success";
  if (operation === "scan") {
    recordMetric("scan_latency_ms", Math.round(durationMs), { operation, outcome, status });
    if (outcome === "error") recordMetric("scan_errors", 1, { operation, status });
    return;
  }
  const metric = operation === "list_generation"
      ? "list_generation"
      : "reconciliation";
  recordMetric(metric, 1, { operation, outcome, status });
}
