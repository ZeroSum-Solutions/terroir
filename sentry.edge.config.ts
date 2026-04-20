/**
 * BND-032 / INT-010 — Sentry Edge runtime init.
 *
 * Loaded by instrumentation.ts when NEXT_RUNTIME === "edge".
 * The edge runtime is V8-isolate-based — no Node APIs — so options
 * like `includeLocalVariables` aren't available here.
 */
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
  sendDefaultPii: true,
  enableLogs: true,
});
