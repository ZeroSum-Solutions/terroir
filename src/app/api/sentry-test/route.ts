import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THROWAWAY — delete after verifying Sentry receives the event.
 *
 * Purpose: prove the production Sentry pipeline end-to-end by throwing
 * an uncaught error from a route. Sentry's `onRequestError` hook
 * (wired in instrumentation.ts) should catch it and report to the
 * `zero-sum-nutrition/terroir` project with a readable stack trace.
 *
 * After confirmation, this file is removed in a follow-up commit.
 */
export async function GET() {
  throw new Error(
    "Sentry smoke test — if you see this in Sentry Issues, the pipeline works.",
  );
  // unreachable; TypeScript placates
  return NextResponse.json({ ok: false });
}
