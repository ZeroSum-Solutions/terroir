/**
 * M1-1: per-stage latency instrumentation for the scan pipeline.
 *
 * Wraps a scan pipeline stage (per-page OCR, merge, extraction incl. the
 * G1-12 arithmetic retry, persist) in a Sentry span so a single scan's
 * per-stage timing is visible end-to-end without changing pipeline
 * control flow. `withScanSpan` is a thin, defensive wrapper: if
 * `Sentry.startSpan` is unavailable (e.g. a test that mocks `@sentry/nextjs`
 * down to just `captureException`), it falls back to running the wrapped
 * stage unwrapped — instrumentation can never block or fail a scan.
 *
 * No PII/financial data ever passes through here: attributes are limited
 * to stage names, counts, byte sizes, and model/profile identifiers —
 * never OCR text, wine names, or invoice amounts.
 */
import * as Sentry from "@sentry/nextjs";

export type ScanSpanAttributes = Record<string, string | number | boolean>;

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Runs `fn` inside a Sentry span named `scan.<stage>`. Falls back to
 * running `fn` unwrapped if `Sentry.startSpan` is unusable — either
 * missing (some test files mock `@sentry/nextjs` down to just
 * `captureException`; reading an absent export on that mock throws
 * rather than returning `undefined`) or throwing when invoked.
 *
 * Once `fn` has started, its own outcome — success or its own rejection —
 * is captured explicitly and is *always* what this function returns or
 * throws, even if Sentry's span machinery itself throws afterward (e.g.
 * `span.end()` failing during a Sentry outage or transport error). That
 * failure is instrumentation noise, not a scan failure, so it's logged
 * defensively and swallowed rather than replacing a stage's real result.
 * `fn` is still only ever invoked once: if the span scaffolding fails
 * *before* `fn` starts, falling back to a fresh `fn()` call is safe.
 */
export async function withScanSpan<T>(
  stage: string,
  attributes: ScanSpanAttributes,
  fn: () => Promise<T>,
): Promise<T> {
  let startSpan: typeof Sentry.startSpan | undefined;
  try {
    startSpan = Sentry.startSpan;
  } catch {
    startSpan = undefined;
  }
  if (typeof startSpan !== "function") return fn();

  let outcome: Outcome<T> | undefined;
  try {
    await startSpan({ name: `scan.${stage}`, op: "scan", attributes }, async () => {
      try {
        const value = await fn();
        outcome = { ok: true, value };
        return value;
      } catch (error) {
        outcome = { ok: false, error };
        throw error;
      }
    });
  } catch (error) {
    if (!outcome) {
      // Sentry's own span scaffolding failed before fn ever ran — run the
      // stage unwrapped so instrumentation can never fail a scan.
      return fn();
    }
    // fn already ran to completion (success or its own rejection) before
    // this error surfaced, so it's Sentry's own post-callback bookkeeping
    // (e.g. span.end() during an outage) — never fn's. Note it and fall
    // through to replay fn's real outcome below instead of propagating it.
    try {
      console.error(
        `[scan-telemetry] Sentry span bookkeeping failed for scan.${stage} after the stage completed:`,
        error,
      );
    } catch {
      // Logging the noise must never throw either.
    }
  }

  if (outcome!.ok) return outcome!.value;
  throw outcome!.error;
}
