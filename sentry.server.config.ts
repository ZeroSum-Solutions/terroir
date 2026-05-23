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

  // sendDefaultPii=false as the prototype default — Sentry's automatic
  // capture will NOT attach user IPs or request headers. Selective
  // context still flows via explicit `{extra, tags}` at each
  // captureException site. Flip to `true` if prod debugging needs the
  // extra context — worth revisiting the moment we have EU customers.
  sendDefaultPii: false,
  // Sentry's local-vars integration mutates stack frames into
  // {function, vars} objects, which breaks React 19 dev overlay's
  // `buildFakeCallStack` (it calls frame.join(...) expecting a tuple).
  // Keep it on in prod for prod debugging context; disable in dev so
  // the local overlay doesn't crash.
  includeLocalVariables: process.env.NODE_ENV !== "development",
  enableLogs: true,
});
