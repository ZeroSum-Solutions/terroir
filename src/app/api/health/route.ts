import { NextResponse } from "next/server";
import http from "node:http";
import https from "node:https";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class ProbeTimeoutError extends Error {}

/**
 * Liveness + DB-readiness probe.
 *
 * Always returns HTTP 200 if the Node process is alive — Railway polls
 * this every ~30s, and coupling the status code to upstream health would
 * flap the container on a transient Supabase blip. The JSON payload
 * still reports DB reachability for ops + automated checks.
 *
 * Uses node:http/node:https directly (not globalThis.fetch) to bypass proxy
 * env vars. Node's undici-backed fetch reads HTTP_PROXY/HTTPS_PROXY at
 * resolution time and caches the ProxyAgent globally — clearing
 * process.env per-request is a race condition. The native modules
 * never use a proxy unless explicitly configured via an Agent, so this
 * path is immune to proxy leakage from sandboxed environments.
 */

/**
 * Single-shot DB probe via node:http(s). Returns true if the PostgREST
 * endpoint responds 2xx within the timeout, false for non-2xx, and
 * throws on network/timeout errors.
 *
 * The transport follows the configured URL's scheme. Probing an
 * `http://127.0.0.1:<port>` local stack over `https` throws, so every
 * correctly-configured local server reported `probe_failed` — which made a
 * server pointed at production look healthier than one pointed at the local
 * stack, and hid exactly the misconfiguration this endpoint should expose.
 */
function probeSupabase(url: string, serviceKey: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const u = new URL(url + "/rest/v1/lwin_catalog?select=lwin_id&limit=1");
    const transport = u.protocol === "http:" ? http : https;
    const req = transport.request(
      {
        hostname: u.hostname,
        // A non-default port lives only in the URL — without it the request
        // goes to 443/80 and the local stack is unreachable.
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: "HEAD",
        headers: {
          apikey: serviceKey,
          Authorization: "Bearer " + serviceKey,
        },
        timeout: 3000,
        // No agent → direct connection, no proxy.
      },
      (res) => {
        res.resume(); // consume response body
        resolve(res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new ProbeTimeoutError());
    });
    req.on("error", reject);
    req.end();
  });
}

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Railway sets this automatically for GitHub-triggered deploys. Lets the
  // staging smoke gate confirm which commit is actually being served,
  // rather than assuming a deploy landed just because the process is up.
  const release = process.env.RAILWAY_GIT_COMMIT_SHA;

  let db: "connected" | "error" | "unconfigured" = "unconfigured";
  let dbReason:
    | "upstream_non_2xx"
    | "timeout"
    | "probe_failed"
    | undefined;

  if (url && serviceKey) {
    try {
      const ok = await probeSupabase(url, serviceKey);
      db = ok ? "connected" : "error";
      if (!ok) dbReason = "upstream_non_2xx";
    } catch (err) {
      db = "error";
      dbReason = err instanceof ProbeTimeoutError ? "timeout" : "probe_failed";
    }
  }

  return NextResponse.json(
    {
      status: "ok",
      db,
      ...(dbReason ? { dbReason } : {}),
      ...(release ? { release } : {}),
      timestamp: new Date().toISOString(),
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
