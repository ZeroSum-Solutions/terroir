import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BND-032 smoke — throwaway endpoint to verify the Sentry SDK actually
 * ships errors end-to-end.
 *
 * On each GET, throws a tagged Error. Next.js's async error handler +
 * our instrumentation.ts hooks should capture it and POST to Sentry's
 * `/envelope` endpoint.
 *
 * DELETE THIS ROUTE after verifying the event lands in
 * `zero-sum-nutrition/terroir` → Issues. Leaving it merged is a foot-
 * gun (anyone can trigger noise in the issue tracker).
 */
export async function GET(): Promise<NextResponse> {
  throw new Error(
    `Sentry smoke test — BND-032 verification (${new Date().toISOString()})`,
  );
}
