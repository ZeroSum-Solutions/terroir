/**
 * BND-032 / INT-010 — Sentry server registration hook.
 *
 * Next 16's `register()` runs once at server startup (before the first
 * request). We dispatch to per-runtime config files so the node and
 * edge inits can diverge as needed without an `if/else` ladder here.
 *
 * `onRequestError` forwards uncaught server-side errors to Sentry with
 * the full Next.js request context. Requires @sentry/nextjs >= 8.28.0;
 * we're on 10.x so it's native.
 */
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
