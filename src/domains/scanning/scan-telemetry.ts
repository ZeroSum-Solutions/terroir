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

/**
 * Runs `fn` inside a Sentry span named `scan.<stage>`. Falls back to
 * running `fn` unwrapped if `Sentry.startSpan` is unusable — either
 * missing (some test files mock `@sentry/nextjs` down to just
 * `captureException`; reading an absent export on that mock throws
 * rather than returning `undefined`) or throwing when invoked. The
 * `fnStarted` guard ensures `fn` is only ever called once: if Sentry's
 * own span scaffolding fails *before* invoking the callback, falling
 * back to a fresh `fn()` call is safe; once the callback has started,
 * any error is `fn`'s own and is rethrown unchanged, never retried
 * (retrying here could double-run a non-idempotent stage like an
 * Anthropic call).
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

  let fnStarted = false;
  try {
    return await startSpan({ name: `scan.${stage}`, op: "scan", attributes }, () => {
      fnStarted = true;
      return fn();
    });
  } catch (error) {
    if (fnStarted) throw error;
    // Sentry's own span scaffolding failed before running fn — instrumentation
    // can never fail a scan (M1-1 acceptance #2), so run the stage unwrapped.
    return fn();
  }
}
