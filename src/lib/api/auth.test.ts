import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { AuthSessionMissingError } from "@supabase/supabase-js";

// Mock the supabase server client. The membership query now uses
// .select().eq().order().order() → thenable, so the builder returns a
// promise-like at the end of the chain.
const mockGetUser = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockOrderFinal = vi.fn();
const mockRpc = vi.fn();

type MembershipsPayload = {
  data: Array<{ restaurant_id: string; role: string }> | null;
  error?: unknown;
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: () => ({
      select: (...args: unknown[]) => {
        mockSelect(...args);
        return {
          eq: (...eqArgs: unknown[]) => {
            mockEq(...eqArgs);
            // order() resolves via mockOrderFinal; the chain shape is built
            // fresh on every requireMembership call to keep tests isolated.
            return mockOrderFinal();
          },
        };
      },
    }),
  })),
}));

// next/headers cookies() mock — active-restaurant.readActiveRestaurantFromCookie calls this.
const mockCookieGet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => mockCookieGet(name),
  })),
}));

// Import AFTER mocks
const {
  requireAuth,
  requireCapability,
  requireMembership,
  requireOwner,
  requireRole,
} = await import("./auth");
const { signActiveRestaurantCookie } = await import("./active-restaurant");

beforeEach(() => {
  mockRpc.mockResolvedValue({
    data: [
      {
        allowed: true,
        limit_count: 120,
        remaining: 119,
        retry_after_seconds: 0,
        reset_at: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
    error: null,
  });
});

function withMemberships(memberships: Array<{ restaurant_id: string; role: string }>) {
  mockOrderFinal.mockImplementation(() => {
    const payload: MembershipsPayload = { data: memberships };
    // Shape matches supabase's PostgrestFilterBuilder:
    //   .eq(...).order(...).order(...) → thenable
    return {
      order: () => ({
        order: () => Promise.resolve(payload),
      }),
    };
  });
}

function withMembershipError(error: unknown) {
  mockOrderFinal.mockImplementation(() => ({
    order: () => ({
      order: () =>
        Promise.resolve({
          data: null,
          error,
        } satisfies MembershipsPayload),
    }),
  }));
}

describe("requireAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookieGet.mockReturnValue(undefined);
  });

  it("returns 401 when no user", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const result = await requireAuth();
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 401 for Supabase's ordinary missing-session error", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: new AuthSessionMissingError(),
    });

    const result = await requireAuth();

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it("throws authentication provider failures instead of reporting a false 401", async () => {
    const providerError = { message: "authentication provider unavailable" };
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: providerError,
    });

    await expect(requireAuth()).rejects.toBe(providerError);
  });

  it("returns auth result with user when authenticated", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "u1", email: "test@test.com" } },
    });
    const result = await requireAuth();
    expect(result).not.toBeInstanceOf(NextResponse);
    expect((result as { user: { id: string } }).user.id).toBe("u1");
    expect(mockRpc).toHaveBeenCalledWith("consume_api_rate_limit", {
      p_risk_class: "standard",
    });
  });

  it("returns 429 with standard quota headers when the persisted bucket is exhausted", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "u1", email: "test@test.com" } },
    });
    mockRpc.mockResolvedValue({
      data: [
        {
          allowed: false,
          limit_count: 10,
          remaining: 0,
          retry_after_seconds: 42,
          reset_at: new Date(Date.now() + 42_000).toISOString(),
        },
      ],
      error: null,
    });

    const result = await requireAuth({ rateLimit: "sensitive" });

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(429);
    expect((result as NextResponse).headers.get("Retry-After")).toBe("42");
    expect((result as NextResponse).headers.get("RateLimit-Limit")).toBe("10");
    expect((result as NextResponse).headers.get("RateLimit-Remaining")).toBe(
      "0",
    );
    expect((result as NextResponse).headers.get("Cache-Control")).toBe(
      "private, no-store",
    );
  });

  it("throws rate-limit datastore failures instead of running unmetered", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "u1", email: "test@test.com" } },
    });
    const providerError = { code: "08006", message: "limiter unavailable" };
    mockRpc.mockResolvedValue({ data: null, error: providerError });

    await expect(requireAuth()).rejects.toBe(providerError);
  });
});

describe("requireMembership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookieGet.mockReturnValue(undefined);
  });

  it("returns 403 when user has no memberships", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    withMemberships([]);
    const result = await requireMembership();
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
    expect(mockRpc).toHaveBeenCalledWith("consume_api_rate_limit", {
      p_risk_class: "standard",
    });
  });

  it("throws membership provider failures instead of reporting a false 403", async () => {
    const providerError = { message: "membership provider unavailable" };
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    withMembershipError(providerError);

    await expect(requireMembership()).rejects.toBe(providerError);
  });

  it("returns the sole membership when the user belongs to one restaurant", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    withMemberships([{ restaurant_id: "r1", role: "manager" }]);
    const result = await requireMembership();
    expect(result).not.toBeInstanceOf(NextResponse);
    expect((result as { restaurantId: string }).restaurantId).toBe("r1");
  });

  it("falls back to most-recently-joined when no cookie is present (multi-restaurant user)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    // The supabase query is ordered created_at DESC, id DESC — the mock
    // returns already in that order.
    withMemberships([
      { restaurant_id: "r-newest", role: "manager" },
      { restaurant_id: "r-older", role: "owner" },
    ]);
    const result = await requireMembership();
    expect((result as { restaurantId: string }).restaurantId).toBe("r-newest");
  });

  it("honours the active_restaurant_id cookie when it points to a real membership", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    withMemberships([
      { restaurant_id: "r-newest", role: "manager" },
      { restaurant_id: "r-older", role: "owner" },
    ]);
    mockCookieGet.mockReturnValue({
      value: signActiveRestaurantCookie("r-older"),
    });
    const result = await requireMembership();
    expect((result as { restaurantId: string }).restaurantId).toBe("r-older");
    expect((result as { role: string }).role).toBe("owner");
  });

  it("ignores a cookie for a restaurant the user no longer belongs to", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    withMemberships([
      { restaurant_id: "r-newest", role: "manager" },
      { restaurant_id: "r-older", role: "owner" },
    ]);
    mockCookieGet.mockReturnValue({
      value: signActiveRestaurantCookie("r-removed"),
    });
    const result = await requireMembership();
    // Falls back to the first ordered membership, never r-removed.
    expect((result as { restaurantId: string }).restaurantId).toBe("r-newest");
  });

  it("ignores a cookie whose signature does not verify", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    withMemberships([
      { restaurant_id: "r-newest", role: "manager" },
      { restaurant_id: "r-older", role: "owner" },
    ]);
    // A hand-crafted cookie with a wrong MAC.
    mockCookieGet.mockReturnValue({ value: "r-older.not-a-real-signature" });
    const result = await requireMembership();
    expect((result as { restaurantId: string }).restaurantId).toBe("r-newest");
  });
});

describe("requireOwner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookieGet.mockReturnValue(undefined);
  });

  it("returns 403 for non-owner role", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    withMemberships([{ restaurant_id: "r1", role: "staff" }]);
    const result = await requireOwner();
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
    expect(mockRpc).toHaveBeenCalledWith("consume_api_rate_limit", {
      p_risk_class: "mutation",
    });
  });

  it("returns membership for owner", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    withMemberships([{ restaurant_id: "r1", role: "owner" }]);
    const result = await requireOwner();
    expect(result).not.toBeInstanceOf(NextResponse);
    expect((result as { role: string }).role).toBe("owner");
  });
});

describe("requireRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookieGet.mockReturnValue(undefined);
  });

  it("returns 401 when no user (propagates from requireMembership → requireAuth)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const result = await requireRole(["owner", "manager"]);
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it("returns 403 when the caller's role is not in the allowed list (staff vs owner/manager)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    withMemberships([{ restaurant_id: "r1", role: "staff" }]);
    const result = await requireRole(["owner", "manager"]);
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
    expect(mockRpc).toHaveBeenCalledWith("consume_api_rate_limit", {
      p_risk_class: "mutation",
    });
  });

  it("returns the membership when role is in the allowed list (manager)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    withMemberships([{ restaurant_id: "r1", role: "manager" }]);
    const result = await requireRole(["owner", "manager"]);
    expect(result).not.toBeInstanceOf(NextResponse);
    expect((result as { role: string }).role).toBe("manager");
    expect((result as { restaurantId: string }).restaurantId).toBe("r1");
  });

  it("returns the membership when role is in the allowed list (owner)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    withMemberships([{ restaurant_id: "r1", role: "owner" }]);
    const result = await requireRole(["owner", "manager"]);
    expect(result).not.toBeInstanceOf(NextResponse);
    expect((result as { role: string }).role).toBe("owner");
  });
});

describe("requireCapability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookieGet.mockReturnValue(undefined);
  });

  it("returns 401 before capability evaluation when there is no user", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const result = await requireCapability("wine:manage");

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it("returns 403 when the active role lacks the capability", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    withMemberships([{ restaurant_id: "r1", role: "staff" }]);

    const result = await requireCapability("wine:manage");

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
    expect(mockRpc).toHaveBeenCalledWith("consume_api_rate_limit", {
      p_risk_class: "mutation",
    });
  });

  it("returns the active membership when the role has the capability", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    withMemberships([{ restaurant_id: "r1", role: "manager" }]);

    const result = await requireCapability("wine:manage");

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toMatchObject({
      restaurantId: "r1",
      role: "manager",
    });
  });
});
