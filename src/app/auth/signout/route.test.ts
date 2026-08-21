import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

const { POST } = await import("./route");

describe("POST /auth/signout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://terroir.example");
    mocks.createClient.mockResolvedValue({ auth: { signOut: mocks.signOut } });
    mocks.signOut.mockResolvedValue({ error: null });
  });

  it("invalidates every session and redirects to the configured origin", async () => {
    const response = await POST(
      new NextRequest("https://evil.example/auth/signout", { method: "POST" }),
    );
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://terroir.example/login");
  });
});
