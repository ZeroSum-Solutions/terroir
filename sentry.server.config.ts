/**
 * BND-032 / INT-010 — Sentry Node.js server runtime init.
 *
 * Loaded by instrumentation.ts when NEXT_RUNTIME === "nodejs".
 * Captures unhandled errors from API routes, server components,
 * server actions, and background jobs. `includeLocalVariables`
 * attaches local variable values to stack frames so debugging
 * prod issues doesn't require a repro.
 */
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,

  // 100% in dev for easy debugging; 10% in prod to control cost.
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  sendDefaultPii: true,
  includeLocalVariables: true,
  enableLogs: true,
});
