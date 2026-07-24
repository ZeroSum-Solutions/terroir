import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetAuthContext = vi.fn();

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));
vi.mock("./team-actions", () => ({
  TeamActions: () => null,
}));

const { default: TeamPage } = await import("./page");

function queryResult(data: unknown[]) {
  return {
    select: () => ({
      eq: () => ({
        is: () => ({
          order: async () => ({ data, error: null }),
        }),
        order: async () => ({ data, error: null }),
      }),
    }),
  };
}

describe("TeamPage invitation-token boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not query or serialize pending invitation tokens for non-owners", async () => {
    const from = vi.fn((table: string) => {
      if (table === "memberships") return queryResult([]);
      throw new Error(`non-owner queried unexpected table: ${table}`);
    });
    mockGetAuthContext.mockResolvedValue({
      supabase: { from },
      restaurantId: "11111111-1111-4111-8111-111111111111",
      restaurantName: "Test Restaurant",
      userRole: "staff",
      user: { id: "22222222-2222-4222-8222-222222222222" },
    });

    await TeamPage();

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("memberships");
    expect(from).not.toHaveBeenCalledWith("invitations");
  });

  it("retains the owner-only pending invitation workflow", async () => {
    const from = vi.fn((table: string) => {
      if (table === "memberships" || table === "invitations") {
        return queryResult([]);
      }
      throw new Error(`unexpected table: ${table}`);
    });
    mockGetAuthContext.mockResolvedValue({
      supabase: { from },
      restaurantId: "11111111-1111-4111-8111-111111111111",
      restaurantName: "Test Restaurant",
      userRole: "owner",
      user: { id: "22222222-2222-4222-8222-222222222222" },
    });

    await TeamPage();

    expect(from).toHaveBeenCalledWith("memberships");
    expect(from).toHaveBeenCalledWith("invitations");
  });
});
