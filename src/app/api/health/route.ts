import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BND-035 — liveness probe for Railway's healthcheck poller.
 *
 * Deliberately does NOT touch Supabase or any other upstream. Railway
 * polls this every ~30s; if we coupled it to DB health, a Supabase
 * blip would flap the container and cascade into user-visible outages.
 * Keep it cheap — if the Node process can serve this, Railway keeps the
 * instance. Deeper readiness checks (DB reachable, Claude key valid)
 * belong in a separate `/api/ready` if ever needed.
 */
export async function GET() {
  return NextResponse.json(
    { status: "ok", timestamp: new Date().toISOString() },
    { status: 200 },
  );
}
