/**
 * BND-032 / INT-010 — Sentry browser instrumentation.
 *
 * Runs on every page load. Uses NEXT_PUBLIC_SENTRY_DSN because the DSN
 * is embedded in the client bundle by design (it's a public identifier,
 * not a secret).
 *
 * Session Replay: 10% of sessions recorded ambiently + 100% of sessions
 * that hit an error. Errors become far easier to reproduce when you can
 * watch the user's last 60 seconds of clicks leading into them.
 */
import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./src/lib/observability/sentry-scrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment:
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,

  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  // Session Replay — record sessions so we can see what users did
  // right before an error. 10% ambient + 100% on error is SKILL.md's
  // recommended balance for a small-scale app. Tune DOWN toward
  // ~0.01 ambient if the Sentry replay quota starts biting; tune UP
  // only if sampled sessions aren't catching the errors you need to
  // debug (unlikely — errorSampleRate is already 100%).
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  // See sentry.server.config.ts for the sendDefaultPii=false rationale.
  sendDefaultPii: false,
  beforeSend: scrubSentryEvent,
  enableLogs: true,

  integrations: [Sentry.replayIntegration()],
});

// App Router navigation instrumentation — connects client transitions
// to the server-side trace so a click-through spans the whole stack.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
