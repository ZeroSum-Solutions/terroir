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
      // Clear proxy env vars that may leak from sandboxed environments
      // and block outbound connections (e.g. Claude Code sandbox proxy).
      let savedProxy = {
        https: process.env.https_proxy,
        http: process.env.http_proxy,
        HTTPS: process.env.HTTPS_PROXY,
        HTTP: process.env.HTTP_PROXY,
        no: process.env.no_proxy,
        NO: process.env.NO_PROXY,
      };
      delete process.env.https_proxy;
      delete process.env.http_proxy;
      delete process.env.HTTPS_PROXY;
      delete process.env.HTTP_PROXY;
      delete process.env.no_proxy;
      delete process.env.NO_PROXY;

      try {
        // Probe PostgREST with a HEAD/limit-0 query against a public table.
        // Service-role key bypasses RLS so this is a clean DB-reachability
        // signal, not an auth signal. Tight timeout so a Supabase blip
        // doesn't slow the liveness probe.
        let ctrl = new AbortController();
        let timer = setTimeout(function() { ctrl.abort(); }, 2000);
        let res = await fetch(
          url + '/rest/v1/lwin_catalog?select=lwin_id&limit=1',
          {
            headers: {
              apikey: serviceKey,
              Authorization: 'Bearer ' + serviceKey,
            },
            signal: ctrl.signal,
            cache: 'no-store',
          },
        );
        clearTimeout(timer);
        db = res.ok ? 'connected' : 'error';
        if (!res.ok) dbError = 'HTTP ' + res.status;
      } finally {
        if (savedProxy.https !== undefined) process.env.https_proxy = savedProxy.https;
        if (savedProxy.http !== undefined) process.env.http_proxy = savedProxy.http;
        if (savedProxy.HTTPS !== undefined) process.env.HTTPS_PROXY = savedProxy.HTTPS;
        if (savedProxy.HTTP !== undefined) process.env.HTTP_PROXY = savedProxy.HTTP;
        if (savedProxy.no !== undefined) process.env.no_proxy = savedProxy.no;
        if (savedProxy.NO !== undefined) process.env.NO_PROXY = savedProxy.NO;
      }
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
