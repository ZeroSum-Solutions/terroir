import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  exchangeCodeForSession: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

const { GET } = await import("./route");

function request(path: string) {
  return new NextRequest(`https://untrusted-request.example${path}`, {
    headers: {
      host: "untrusted-request.example",
      "x-forwarded-host": "evil.example",
    },
  });
}

describe("GET /auth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://staging.terroir.example");
    mocks.createClient.mockResolvedValue({
      auth: { exchangeCodeForSession: mocks.exchangeCodeForSession },
    });
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
  });

  it("exchanges a code and returns to a safe path on the configured origin", async () => {
    const response = await GET(
      request("/auth/callback?code=valid&next=%2Fcellar%3Ftab%3Dreds"),
    );

    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("valid");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://staging.terroir.example/cellar?tab=reds",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("uses one generic redirect when the code is missing", async () => {
    const response = await GET(request("/auth/callback?next=%2Fcellar"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://staging.terroir.example/login?error=link",
    );
  });

  it("maps provider failures to the same generic redirect", async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({
      error: { message: "provider-secret" },
    });
    const response = await GET(
      request("/auth/callback?code=expired&next=%2Fcellar"),
    );
    const location = response.headers.get("location") ?? "";
    expect(location).toBe("https://staging.terroir.example/login?error=link");
    expect(location).not.toContain("provider-secret");
    expect(location).not.toContain("next");
  });

  it("opens the password form when recovery returns through the PKCE callback", async () => {
    const response = await GET(
      request("/auth/callback?code=valid&next=%2Fauth%2Freset-password"),
    );
    expect(response.headers.get("location")).toBe(
      "https://staging.terroir.example/auth/reset-password",
    );
  });

  it("rejects a protocol-relative destination after a valid exchange", async () => {
    const response = await GET(
      request("/auth/callback?code=valid&next=%2F%2Fevil.example"),
    );
    expect(response.headers.get("location")).toBe(
      "https://staging.terroir.example/",
    );
  });
});
