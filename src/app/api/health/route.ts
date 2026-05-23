import { NextResponse } from "next/server";
import https from "node:https";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness + DB-readiness probe.
 *
 * Always returns HTTP 200 if the Node process is alive — Railway polls
 * this every ~30s, and coupling the status code to upstream health would
 * flap the container on a transient Supabase blip. The JSON payload
 * still reports DB reachability for ops + automated checks.
 *
 * Uses node:https directly (not globalThis.fetch) to bypass proxy env
 * vars. Node's undici-backed fetch reads HTTP_PROXY/HTTPS_PROXY at
 * resolution time and caches the ProxyAgent globally — clearing
 * process.env per-request is a race condition. The native https module
 * never uses a proxy unless explicitly configured via an Agent, so this
 * path is immune to proxy leakage from sandboxed environments.
 */

/**
 * Single-shot DB probe via node:https. Returns true if the PostgREST
 * endpoint responds 2xx within the timeout, false for non-2xx, and
 * throws on network/timeout errors.
 */
function probeSupabase(url: string, serviceKey: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const u = new URL(url + "/rest/v1/lwin_catalog?select=lwin_id&limit=1");
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "HEAD",
        headers: {
          apikey: serviceKey,
          Authorization: "Bearer " + serviceKey,
        },
        timeout: 3000,
        // No agent → direct TLS connection, no proxy.
      },
      (res) => {
        res.resume(); // consume response body
        resolve(res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  let db: "connected" | "error" | "unconfigured" = "unconfigured";
  let dbError: string | undefined;

  if (url && serviceKey) {
    try {
      const ok = await probeSupabase(url, serviceKey);
      db = ok ? "connected" : "error";
      if (!ok) dbError = "non-2xx response";
    } catch (err) {
      db = "error";
      if (err instanceof Error) {
        dbError = err.message;
        // Surface the error code (e.g. ENOTFOUND, ECONNREFUSED, ETIMEDOUT)
        // so ops can distinguish "Supabase down" from "DNS broken".
        const code = (err as NodeJS.ErrnoException).code;
        if (code) dbError = code + ": " + dbError;
      } else {
        dbError = "unknown";
      }
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
