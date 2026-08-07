import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  exchangeCodeForSession: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

const { GET } = await import("./route");

function request(path: string) {
  return new NextRequest(`https://untrusted-request.example${path}`, {
    headers: { host: "untrusted-request.example", "x-forwarded-host": "evil.example" },
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

  it("exchanges a code and returns to a safe requested path on the configured origin", async () => {
    const response = await GET(request("/auth/callback?code=valid&next=%2Fcellar%3Ftab%3Dreds"));

    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith("valid");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://staging.terroir.example/cellar?tab=reds",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["missing code", "/auth/callback?next=%2Fcellar"],
    ["provider failure", "/auth/callback?code=expired&next=%2Fcellar"],
    ["provider error text", "/auth/callback?error_description=provider-secret&next=%2Fcellar"],
  ])("uses one generic recovery redirect for %s", async (name, path) => {
    if (name === "provider failure") {
      mocks.exchangeCodeForSession.mockResolvedValue({ error: { message: "provider-secret" } });
    }

    const response = await GET(request(path));
    const location = response.headers.get("location") ?? "";

    expect(response.status).toBe(303);
    expect(location).toBe("https://staging.terroir.example/login?error=link");
    expect(location).not.toContain("next");
    expect(location).not.toContain("provider-secret");
  });

  it("rejects protocol-relative destinations after a valid exchange", async () => {
    const response = await GET(request("/auth/callback?code=valid&next=%2F%2Fevil.example"));

    expect(response.headers.get("location")).toBe("https://staging.terroir.example/");
  });
});
