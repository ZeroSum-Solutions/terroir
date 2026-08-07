import { createHash, timingSafeEqual } from "node:crypto";
import https from "node:https";
import { NextResponse, type NextRequest } from "next/server";
import {
  getApiRequestContext,
  runWithApiRequestContext,
} from "@/lib/api/request-context";
import { inspectRuntimeConfiguration } from "@/lib/config/runtime";
import { emitStructuredLog } from "@/lib/observability/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

class ProbeTimeoutError extends Error {}

const ALERT_DRILL_HEADER = "x-terroir-observability-drill";
const RUNBOOK_URL =
  "https://github.com/wiggdevin/terroir/blob/main/docs/operations/observability.md";

function isAuthorizedAlertDrill(request: NextRequest | undefined): boolean {
  if (request?.nextUrl.searchParams.get("drill") !== "readiness") return false;
  const environment = process.env.RAILWAY_ENVIRONMENT_NAME?.trim().toLowerCase();
  const isNonProduction =
    (process.env.OBSERVABILITY_DRILL_ENABLED === "1" &&
      environment === "staging") ||
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test";
  if (!isNonProduction) return false;

  const expected = process.env.OBSERVABILITY_DRILL_TOKEN_SHA256?.trim();
  const supplied = request.headers.get(ALERT_DRILL_HEADER);
  if (
    !expected ||
    !/^[a-f0-9]{64}$/i.test(expected) ||
    !supplied ||
    supplied.length < 32 ||
    supplied.length > 256
  ) {
    return false;
  }

  const actual = createHash("sha256").update(supplied).digest("hex");
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

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
      reject(new ProbeTimeoutError());
    });
    req.on("error", reject);
    req.end();
  });
}

export async function GET(request?: NextRequest) {
  return runWithApiRequestContext(() => getHealth(request));
}

async function getHealth(request?: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const environment = process.env.RAILWAY_ENVIRONMENT_NAME?.trim() || "unknown";
  const release = process.env.RAILWAY_GIT_COMMIT_SHA?.trim()
    || process.env.TERROIR_RELEASE_SHA?.trim();

  let db: "connected" | "error" | "unconfigured" = "unconfigured";
  let dbReason:
    | "upstream_non_2xx"
    | "timeout"
    | "probe_failed"
    | "forced_failure"
    | undefined;

  const isAlertDrill = isAuthorizedAlertDrill(request);

  if (isAlertDrill) {
    db = "error";
    dbReason = "forced_failure";
  } else if (url && serviceKey) {
    try {
      const ok = await probeSupabase(url, serviceKey);
      db = ok ? "connected" : "error";
      if (!ok) dbReason = "upstream_non_2xx";
    } catch (err) {
      db = "error";
      dbReason = err instanceof ProbeTimeoutError ? "timeout" : "probe_failed";
    }
  }

  const configuration = inspectRuntimeConfiguration();
  const readiness = db === "connected" && configuration.core === "configured"
    ? "ready"
    : "degraded";
  const timestamp = new Date().toISOString();
  const requestId = getApiRequestContext()?.requestId;
  const alertDrill = isAlertDrill
    ? {
        environment,
        severity: "high",
        service: "terroir-web",
        eventName: "readiness_degraded",
        firstOccurrence: timestamp,
        lastOccurrence: timestamp,
        count: 1,
        requestId,
        runbook: RUNBOOK_URL,
      }
    : undefined;
  if (alertDrill) {
    emitStructuredLog("alert_drill_failure", {
      severity: alertDrill.severity,
      event_name: alertDrill.eventName,
      first_occurrence: alertDrill.firstOccurrence,
      last_occurrence: alertDrill.lastOccurrence,
      count: alertDrill.count,
      runbook: alertDrill.runbook,
    });
  }

  const body = {
    // `status` and HTTP 200 deliberately remain the Railway liveness contract.
    status: "ok",
    readiness,
    db,
    environment,
    ...(release ? { release } : {}),
    ...(dbReason ? { dbReason } : {}),
    dependencies: {
      web: "connected",
      database: db,
      storage: db === "connected" ? "unknown" : "degraded",
      providers: {
        invoice_scanning: configuration.integrations.invoice_scanning,
        wine_search: configuration.integrations.wine_search,
      },
      email: configuration.integrations.email,
      worker: configuration.integrations.worker,
      observability: configuration.integrations.sentry,
    },
    // Variable names only; values and user data never leave the process.
    ...(configuration.missingCore.length > 0 ? { missingConfiguration: configuration.missingCore } : {}),
    ...(configuration.configurationErrors.length > 0
      ? { invalidConfiguration: configuration.configurationErrors }
      : {}),
    ...(alertDrill ? { alertDrill } : {}),
    timestamp,
  };
  emitStructuredLog("health_check", {
    readiness,
    database: db,
    db_reason: dbReason,
    drill: isAlertDrill,
  });
  return NextResponse.json(
    body,
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
