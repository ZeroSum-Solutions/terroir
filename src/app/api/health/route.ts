import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness + DB-readiness probe.
 *
 * Always returns HTTP 200 if the Node process is alive — Railway polls
 * this every ~30s, and coupling the status code to upstream health would
 * flap the container on a transient Supabase blip. The JSON payload
 * still reports DB reachability for ops + automated checks.
 */
export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  let db: "connected" | "error" | "unconfigured" = "unconfigured";
  let dbError: string | undefined;

  if (url && serviceKey) {
    try {
      // Probe PostgREST with a HEAD/limit-0 query against a public table.
      // Service-role key bypasses RLS so this is a clean DB-reachability
      // signal, not an auth signal. Tight timeout so a Supabase blip
      // doesn't slow the liveness probe.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(
        `${url}/rest/v1/lwin_catalog?select=lwin_id&limit=1`,
        {
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
          },
          signal: ctrl.signal,
          cache: "no-store",
        },
      );
      clearTimeout(timer);
      db = res.ok ? "connected" : "error";
      if (!res.ok) dbError = `HTTP ${res.status}`;
    } catch (err) {
      db = "error";
      dbError = err instanceof Error ? err.message : "unknown";
    }
  }

  return NextResponse.json(
    {
      status: "ok",
      db,
      ...(dbError ? { dbError } : {}),
      timestamp: new Date().toISOString(),
    },
    { status: 200 },
  );
}
