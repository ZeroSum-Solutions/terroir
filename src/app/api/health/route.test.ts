// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHttpsRequest = vi.fn();
vi.mock("node:https", () => ({
  default: {
    request: (...args: unknown[]) => mockHttpsRequest(...args),
  },
}));

const mockHttpRequest = vi.fn();
vi.mock("node:http", () => ({
  default: {
    request: (...args: unknown[]) => mockHttpRequest(...args),
  },
}));

const { GET } = await import("./route");

type ProbeMode =
  | { kind: "response"; status: number }
  | { kind: "error"; error: Error & { code?: string } }
  | { kind: "timeout" };

function mockProbe(mode: ProbeMode, transport = mockHttpsRequest) {
  transport.mockImplementation(
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
  expected: { db: "connected" | "error" | "unconfigured"; dbReason?: string },
) {
  const response = await GET();
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(body).toEqual({
    status: "ok",
    db: expected.db,
    ...(expected.dbReason ? { dbReason: expected.dbReason } : {}),
    timestamp: "2026-07-24T10:00:00.000Z",
  });
  expect(body).not.toHaveProperty("error");
  expect(body).not.toHaveProperty("dbError");
}

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T10:00:00.000Z"));
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", "");
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

  it("probes a local http stack over node:http, on its own port", async () => {
    // An https-only probe threw on every `http://127.0.0.1:<port>` URL, so a
    // correctly-configured local server could never report healthy — the one
    // configuration this endpoint most needs to tell apart from production.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:57321");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "local-service-role");
    mockProbe({ kind: "response", status: 200 }, mockHttpRequest);

    await expectHealth({ db: "connected" });
    expect(mockHttpsRequest).not.toHaveBeenCalled();
    expect(mockHttpRequest).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "127.0.0.1", port: "57321" }),
      expect.any(Function),
    );
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
    expect(JSON.parse(text)).toEqual({
      status: "ok",
      db: "error",
      dbReason: "probe_failed",
      timestamp: "2026-07-24T10:00:00.000Z",
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

  it("reports the deployed commit SHA when Railway provides it", async () => {
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", "a".repeat(40));

    const response = await GET();
    const body = await response.json();

    expect(body.release).toBe("a".repeat(40));
  });

  it("omits release when Railway has not set a commit SHA", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body).not.toHaveProperty("release");
  });
});
