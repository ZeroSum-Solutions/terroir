/**
 * BND-032 / INT-010 — Sentry Edge runtime init.
 *
 * Loaded by instrumentation.ts when NEXT_RUNTIME === "edge".
 * The edge runtime is V8-isolate-based — no Node APIs — so options
 * like `includeLocalVariables` aren't available here.
 */
import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./src/lib/observability/sentry-scrub";
import { resolveSampleRate } from "./src/lib/observability/sample-rate";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  tracesSampleRate: resolveSampleRate(
    process.env.SENTRY_TRACES_SAMPLE,
    process.env.NODE_ENV === "development" ? 1.0 : 0.1,
  ),
  // See sentry.server.config.ts for the sendDefaultPii=false rationale.
  sendDefaultPii: false,
  beforeSend: scrubSentryEvent,
  enableLogs: true,
});
