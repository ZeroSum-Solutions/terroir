import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const TOKEN_HASH =
  "fcc10d33162838e7b9e468c681194474d040cd9844c9e8c69f11e0e1aa0d8010";
const FUTURE_EXPIRY = "2026-07-23T12:05:00.000Z";
const mockVerifyOtp = vi.fn();
const mockCreateClient = vi.fn(async () => ({
  auth: { verifyOtp: mockVerifyOtp },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));

const { GET } = await import("./route");

function makeRequest(token = "temporary-secret"): NextRequest {
  return makeRequestWithQuery(`token=${encodeURIComponent(token)}`);
}

function makeRequestWithQuery(query = ""): NextRequest {
  return new NextRequest(
    `https://terroir.example/api/dev-login${query ? `?${query}` : ""}`,
    {
      headers: {
        host: "terroir.example",
        "x-forwarded-host": "terroir.example",
        "x-forwarded-proto": "https",
      },
    },
  );
}

function expectSafetyHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

function configureBaseEnvironment(nodeEnv: "production" | "test") {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
  vi.stubEnv("DEV_BYPASS_EMAIL", "");
  vi.stubEnv("TEMP_AUTH_BYPASS_EMAIL", "");
  vi.stubEnv("TEMP_AUTH_BYPASS_TOKEN", "");
  vi.stubEnv("TEMP_AUTH_BYPASS_TOKEN_SHA256", "");
  vi.stubEnv("TEMP_AUTH_BYPASS_EXPIRES_AT", "");
}

function configureProductionCapability() {
  vi.stubEnv("TEMP_AUTH_BYPASS_EMAIL", "scoped@example.com");
  vi.stubEnv("TEMP_AUTH_BYPASS_TOKEN_SHA256", TOKEN_HASH);
  vi.stubEnv("TEMP_AUTH_BYPASS_EXPIRES_AT", FUTURE_EXPIRY);
}

function mockSuccessfulSupabaseLogin() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ hashed_token: "supabase-magic-link-proof" }),
    ),
  );
  mockVerifyOtp.mockResolvedValue({ error: null });
}

describe("GET /api/dev-login", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    configureBaseEnvironment("production");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses a valid short-lived production capability for the scoped email", async () => {
    configureProductionCapability();
    mockSuccessfulSupabaseLogin();

    const response = await GET(makeRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://terroir.example/");
    expect(response.headers.get("location")).not.toContain("token");
    expectSafetyHeaders(response);
    expect(fetch).toHaveBeenCalledWith(
      "https://project.supabase.co/auth/v1/admin/generate_link",
      expect.objectContaining({
        body: JSON.stringify({
          type: "magiclink",
          email: "scoped@example.com",
        }),
      }),
    );
    expect(mockVerifyOtp).toHaveBeenCalledWith({
      token_hash: "supabase-magic-link-proof",
      type: "magiclink",
    });
  });

  it.each([
    {
      name: "missing query token",
      configure: configureProductionCapability,
      request: () => makeRequestWithQuery(),
    },
    {
      name: "empty query token",
      configure: configureProductionCapability,
      request: () => makeRequestWithQuery("token="),
    },
    {
      name: "duplicate query token",
      configure: configureProductionCapability,
      request: () => makeRequestWithQuery("token=a&token=b"),
    },
    {
      name: "oversized query token",
      configure: configureProductionCapability,
      request: () => makeRequest("x".repeat(513)),
    },
    {
      name: "wrong raw token",
      configure: configureProductionCapability,
      request: () => makeRequest("wrong-token"),
    },
    {
      name: "missing hash",
      configure: () => {
        vi.stubEnv("TEMP_AUTH_BYPASS_EMAIL", "scoped@example.com");
        vi.stubEnv("TEMP_AUTH_BYPASS_EXPIRES_AT", FUTURE_EXPIRY);
      },
      request: makeRequest,
    },
    {
      name: "invalid hash",
      configure: () => {
        configureProductionCapability();
        vi.stubEnv("TEMP_AUTH_BYPASS_TOKEN_SHA256", "not-a-sha-256-hash");
      },
      request: makeRequest,
    },
    {
      name: "missing expiry",
      configure: () => {
        vi.stubEnv("TEMP_AUTH_BYPASS_EMAIL", "scoped@example.com");
        vi.stubEnv("TEMP_AUTH_BYPASS_TOKEN_SHA256", TOKEN_HASH);
      },
      request: makeRequest,
    },
    {
      name: "invalid expiry",
      configure: () => {
        configureProductionCapability();
        vi.stubEnv("TEMP_AUTH_BYPASS_EXPIRES_AT", "not-an-iso-timestamp");
      },
      request: makeRequest,
    },
    {
      name: "expired capability",
      configure: () => {
        configureProductionCapability();
        vi.stubEnv(
          "TEMP_AUTH_BYPASS_EXPIRES_AT",
          "2026-07-23T11:59:59.999Z",
        );
      },
      request: makeRequest,
    },
  ])("hard-404s $name without disclosing the reason", async ({ configure, request }) => {
    configure();
    const requestFetch = vi.fn();
    vi.stubGlobal("fetch", requestFetch);

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expectSafetyHeaders(response);
    expect(requestFetch).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("does not fall back to the legacy raw-token environment variable", async () => {
    vi.stubEnv("TEMP_AUTH_BYPASS_EMAIL", "scoped@example.com");
    vi.stubEnv("TEMP_AUTH_BYPASS_TOKEN", "temporary-secret");
    vi.stubEnv("TEMP_AUTH_BYPASS_EXPIRES_AT", FUTURE_EXPIRY);
    const requestFetch = vi.fn();
    vi.stubGlobal("fetch", requestFetch);

    const response = await GET(makeRequest());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expectSafetyHeaders(response);
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("keeps the development-only email bypass independent of production capability config", async () => {
    configureBaseEnvironment("test");
    vi.stubEnv("DEV_BYPASS_EMAIL", "developer@example.com");
    mockSuccessfulSupabaseLogin();

    const response = await GET(makeRequestWithQuery());

    expect(response.status).toBe(303);
    expectSafetyHeaders(response);
    expect(fetch).toHaveBeenCalledWith(
      "https://project.supabase.co/auth/v1/admin/generate_link",
      expect.objectContaining({
        body: JSON.stringify({
          type: "magiclink",
          email: "developer@example.com",
        }),
      }),
    );
  });

  it("never uses the development email in production", async () => {
    vi.stubEnv("DEV_BYPASS_EMAIL", "developer@example.com");
    vi.stubEnv("TEMP_AUTH_BYPASS_TOKEN_SHA256", TOKEN_HASH);
    vi.stubEnv("TEMP_AUTH_BYPASS_EXPIRES_AT", FUTURE_EXPIRY);
    const requestFetch = vi.fn();
    vi.stubGlobal("fetch", requestFetch);

    const response = await GET(makeRequest());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expectSafetyHeaders(response);
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("redacts a secret-bearing provider non-2xx response", async () => {
    configureProductionCapability();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("service-role=secret-provider-detail", { status: 500 }),
      ),
    );

    const response = await GET(makeRequest());
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "bad_gateway",
        message: "Temporary login unavailable.",
      },
    });
    expect(text).not.toContain("secret-provider-detail");
    expectSafetyHeaders(response);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("redacts a rejected provider request", async () => {
    configureProductionCapability();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("dns secret-provider-detail");
      }),
    );

    const response = await GET(makeRequest());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        code: "bad_gateway",
        message: "Temporary login unavailable.",
      },
    });
    expectSafetyHeaders(response);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "non-JSON",
      response: () => new Response("not-json"),
    },
    {
      name: "missing hashed_token",
      response: () => Response.json({}),
    },
    {
      name: "empty hashed_token",
      response: () => Response.json({ hashed_token: "" }),
    },
    {
      name: "oversized hashed_token",
      response: () => Response.json({ hashed_token: "x".repeat(4097) }),
    },
  ])("redacts $name provider payloads without verifying", async ({ response }) => {
    configureProductionCapability();
    vi.stubGlobal("fetch", vi.fn(async () => response()));

    const result = await GET(makeRequest());

    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({
      error: {
        code: "bad_gateway",
        message: "Temporary login unavailable.",
      },
    });
    expectSafetyHeaders(result);
    expect(mockVerifyOtp).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "returned verification error",
      verify: () =>
        mockVerifyOtp.mockResolvedValue({
          error: { message: "secret verification detail" },
        }),
    },
    {
      name: "thrown verification error",
      verify: () =>
        mockVerifyOtp.mockRejectedValue(
          new Error("secret thrown verification detail"),
        ),
    },
  ])("redacts a $name", async ({ verify }) => {
    configureProductionCapability();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ hashed_token: "valid-proof" })),
    );
    verify();

    const response = await GET(makeRequest());
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "bad_gateway",
        message: "Temporary login unavailable.",
      },
    });
    expect(text).not.toContain("secret");
    expectSafetyHeaders(response);
  });
});
