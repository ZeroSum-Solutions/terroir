import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));

const { GET } = await import("./route");

function request(path: string) {
  return new NextRequest(`https://untrusted-request.example${path}`);
}

describe("GET /auth/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://staging.terroir.example");
    mocks.createClient.mockResolvedValue({ auth: { verifyOtp: mocks.verifyOtp } });
    mocks.verifyOtp.mockResolvedValue({ error: null });
  });

  it("exchanges only a recovery token and opens the reset page", async () => {
    const response = await GET(request("/auth/confirm?token_hash=recovery-proof&type=recovery"));

    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      type: "recovery",
      token_hash: "recovery-proof",
    });
    expect(response.headers.get("location")).toBe(
      "https://staging.terroir.example/auth/reset-password",
    );
  });

  it.each([
    "/auth/confirm",
    "/auth/confirm?token_hash=proof&type=magiclink",
    `/auth/confirm?token_hash=${"x".repeat(4097)}&type=recovery`,
  ])("does not exchange invalid recovery input", async (path) => {
    const response = await GET(request(path));

    expect(response.headers.get("location")).toBe(
      "https://staging.terroir.example/login?error=link",
    );
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });

  it("maps an expired or reused provider token to the generic recovery redirect", async () => {
    mocks.verifyOtp.mockResolvedValue({ error: { message: "expired token secret" } });

    const response = await GET(request("/auth/confirm?token_hash=expired&type=recovery"));

    expect(response.headers.get("location")).toBe(
      "https://staging.terroir.example/login?error=link",
    );
  });
});
