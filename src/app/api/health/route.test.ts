// @vitest-environment node
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHttpsRequest = vi.fn();
vi.mock("node:https", () => ({
  default: {
    request: (...args: unknown[]) => mockHttpsRequest(...args),
  },
}));

const { GET } = await import("./route");

type ProbeMode =
  | { kind: "response"; status: number }
  | { kind: "error"; error: Error & { code?: string } }
  | { kind: "timeout" };

function mockProbe(mode: ProbeMode) {
  mockHttpsRequest.mockImplementation(
    (
      _options: unknown,
      onResponse: (response: {
        statusCode: number;
        resume: () => void;
      }) => void,
    ) => {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const request = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers.set(event, handler);
          return request;
        }),
        destroy: vi.fn(),
        end: vi.fn(() => {
          if (mode.kind === "response") {
            onResponse({ statusCode: mode.status, resume: vi.fn() });
          } else if (mode.kind === "error") {
            handlers.get("error")?.(mode.error);
          } else {
            handlers.get("timeout")?.();
          }
        }),
      };
      return request;
    },
  );
}

async function expectHealth(
  expected: {
    db: "connected" | "error" | "unconfigured";
    dbReason?: string;
    environment?: string;
    release?: string;
  },
) {
  const response = await GET();
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body).toMatchObject({
    status: "ok",
    db: expected.db,
    ...(expected.dbReason ? { dbReason: expected.dbReason } : {}),
    environment: expected.environment ?? "unknown",
    ...(expected.release ? { release: expected.release } : {}),
    readiness: "degraded",
    dependencies: {
      web: "connected",
      database: expected.db,
      providers: { invoice_scanning: "degraded", wine_search: "degraded" },
      email: "not_configured",
      worker: "not_configured",
    },
  });
  expect(body.timestamp).toBe("2026-07-24T10:00:00.000Z");
  expect(body).not.toHaveProperty("error");
  expect(body).not.toHaveProperty("dbError");
}

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T10:00:00.000Z"));
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "");
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", "");
    vi.stubEnv("OBSERVABILITY_DRILL_ENABLED", "");
    vi.stubEnv("OBSERVABILITY_DRILL_TOKEN_SHA256", "");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("reports unconfigured without making a network request", async () => {
    await expectHealth({ db: "unconfigured" });
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it("reports a successful probe as connected", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret");
    mockProbe({ kind: "response", status: 204 });

    await expectHealth({ db: "connected" });
  });

  it("reports only the deploy identity needed by the staging gate", async () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "staging");
    vi.stubEnv("OBSERVABILITY_DRILL_ENABLED", "1");
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", "abc1234");

    await expectHealth({
      db: "unconfigured",
      environment: "staging",
      release: "abc1234",
    });
  });

  it("uses a stable reason for upstream non-2xx responses", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret");
    mockProbe({ kind: "response", status: 503 });

    await expectHealth({ db: "error", dbReason: "upstream_non_2xx" });
  });

  it("uses a stable reason for a timeout", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret");
    mockProbe({ kind: "timeout" });

    await expectHealth({ db: "error", dbReason: "timeout" });
  });

  it.each([
    Object.assign(new Error("dns leaked-host.example"), { code: "ENOTFOUND" }),
    Object.assign(new Error("tls service-role-secret"), {
      code: "CERT_HAS_EXPIRED",
    }),
  ])("redacts network failures (%s)", async (error) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret");
    mockProbe({ kind: "error", error });

    const response = await GET();
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      status: "ok",
      db: "error",
      dbReason: "probe_failed",
      environment: "unknown",
      timestamp: "2026-07-24T10:00:00.000Z",
      readiness: "degraded",
    });
    expect(text).not.toContain(error.message);
    expect(text).not.toContain(error.code ?? "");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("redacts an invalid configured URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "not a URL");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-secret");

    await expectHealth({ db: "error", dbReason: "probe_failed" });
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it("emits a complete redacted alert envelope for an authorized non-production drill", async () => {
    const token = "local-observability-drill-token-2026";
    vi.stubEnv(
      "OBSERVABILITY_DRILL_TOKEN_SHA256",
      createHash("sha256").update(token).digest("hex"),
    );
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "staging");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await GET(
      new NextRequest("https://terroir-web-staging.example.test/api/health?drill=readiness", {
        headers: { "x-terroir-observability-drill": token },
      }),
    );
    const body = await response.json();

    expect(body).toMatchObject({
      readiness: "degraded",
      db: "error",
      dbReason: "forced_failure",
      alertDrill: {
        environment: "staging",
        severity: "high",
        service: "terroir-web",
        eventName: "readiness_degraded",
        firstOccurrence: "2026-07-24T10:00:00.000Z",
        lastOccurrence: "2026-07-24T10:00:00.000Z",
        count: 1,
        requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
        runbook: expect.stringContaining("docs/operations/observability.md"),
      },
    });
    expect(mockHttpsRequest).not.toHaveBeenCalled();
    const event = info.mock.calls
      .map(([value]) => String(value))
      .find((value) => value.includes('"event":"alert_drill_failure"'));
    expect(event).toContain('"event_name":"readiness_degraded"');
    expect(event).toContain('"count":1');
    expect(event).not.toContain(token);
  });

  it("never enables the alert drill in production", async () => {
    const token = "production-must-refuse-this-token-2026";
    vi.stubEnv(
      "OBSERVABILITY_DRILL_TOKEN_SHA256",
      createHash("sha256").update(token).digest("hex"),
    );
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "production");
    vi.stubEnv("OBSERVABILITY_DRILL_ENABLED", "1");

    const response = await GET(
      new NextRequest("https://terroir.example.test/api/health?drill=readiness", {
        headers: { "x-terroir-observability-drill": token },
      }),
    );
    expect(await response.json()).not.toHaveProperty("alertDrill");
  });
});
