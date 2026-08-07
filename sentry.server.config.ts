/**
 * BND-032 / INT-010 — Sentry Node.js server runtime init.
 *
 * Loaded by instrumentation.ts when NEXT_RUNTIME === "nodejs".
 * Captures unhandled errors from API routes, server components,
 * server actions, and background jobs. Frame-local capture stays disabled:
 * locals can contain credentials, request bodies, and raw invoice content.
 */
import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./src/lib/observability/sentry-scrub";
import { resolveSampleRate } from "./src/lib/observability/sample-rate";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,

  // 100% in dev for easy debugging; 10% in prod to control cost.
  tracesSampleRate: resolveSampleRate(
    process.env.SENTRY_TRACES_SAMPLE,
    process.env.NODE_ENV === "development" ? 1.0 : 0.1,
  ),

  // sendDefaultPii=false as the prototype default — Sentry's automatic
  // capture will NOT attach user IPs or request headers. Selective
  // context still flows via explicit `{extra, tags}` at each
  // captureException site. Flip to `true` if prod debugging needs the
  // extra context — worth revisiting the moment we have EU customers.
  sendDefaultPii: false,
  // Local variables can contain request data, credentials, and invoice text.
  includeLocalVariables: false,
  beforeSend: scrubSentryEvent,
  enableLogs: true,
});
