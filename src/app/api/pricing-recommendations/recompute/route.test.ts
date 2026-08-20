import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

const mockCreateClient = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

const mockRunRecompute = vi.fn();
vi.mock("@/lib/pricing-recommendations/recompute", () => ({
  runPricingRecommendationsRecompute: (...args: unknown[]) =>
    mockRunRecompute(...args),
}));

const { POST } = await import("./route");

describe("POST /api/pricing-recommendations/recompute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  });

  it.each([401, 403])("returns the %s response from requireRole", async (status) => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Denied" }, { status }),
    );

    const response = await POST();

    expect(response.status).toBe(status);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("returns 500 when service-role configuration is missing", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    mockRequireRole.mockResolvedValue(authResult());

    const response = await POST();

    expect(response.status).toBe(500);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("runs with a non-persistent service-role client", async () => {
    const admin = { kind: "admin" };
    mockRequireRole.mockResolvedValue(authResult());
    mockCreateClient.mockReturnValue(admin);
    mockRunRecompute.mockResolvedValue({
      recommended: 1,
      classes: { feature_btg: 1 },
    });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(mockRequireRole).toHaveBeenCalledWith(["owner", "manager"]);
    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "service-role-key",
      { auth: { persistSession: false } },
    );
    expect(mockRunRecompute).toHaveBeenCalledWith(
      admin,
      "restaurant-1",
      "user-1",
    );
  });

  it("returns a redacted 500 when the job fails", async () => {
    mockRequireRole.mockResolvedValue(authResult());
    mockCreateClient.mockReturnValue({ kind: "admin" });
    mockRunRecompute.mockRejectedValue(new Error("secret database detail"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST();
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("secret database detail");
  });
});

function authResult() {
  return {
    supabase: { kind: "authenticated" },
    restaurantId: "restaurant-1",
    user: { id: "user-1" },
    role: "manager",
  };
}
