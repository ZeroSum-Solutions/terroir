import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

// Mock the supabase server client
const mockGetUser = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockLimit = vi.fn();
const mockSingle = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: () => ({
      select: (...args: unknown[]) => {
        mockSelect(...args);
        return {
          eq: (...eqArgs: unknown[]) => {
            mockEq(...eqArgs);
            return {
              limit: (...lArgs: unknown[]) => {
                mockLimit(...lArgs);
                return { single: mockSingle };
              },
            };
          },
        };
      },
    }),
  })),
}));

// Import AFTER mocks
const { requireAuth, requireMembership, requireOwner } = await import(
  "./auth"
);

describe("requireAuth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when no user", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const result = await requireAuth();
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it("returns auth result with user when authenticated", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "u1", email: "test@test.com" } },
    });
    const result = await requireAuth();
    expect(result).not.toBeInstanceOf(NextResponse);
    expect((result as { user: { id: string } }).user.id).toBe("u1");
  });
});

describe("requireMembership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 403 when user has no membership", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "u1" } },
    });
    mockSingle.mockResolvedValue({ data: null });
    const result = await requireMembership();
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns membership with role when valid", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "u1" } },
    });
    mockSingle.mockResolvedValue({
      data: { restaurant_id: "r1", role: "manager" },
    });
    const result = await requireMembership();
    expect(result).not.toBeInstanceOf(NextResponse);
    const membership = result as { restaurantId: string; role: string };
    expect(membership.restaurantId).toBe("r1");
    expect(membership.role).toBe("manager");
  });
});

describe("requireOwner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 403 for non-owner role", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "u1" } },
    });
    mockSingle.mockResolvedValue({
      data: { restaurant_id: "r1", role: "staff" },
    });
    const result = await requireOwner();
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns membership for owner", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: "u1" } },
    });
    mockSingle.mockResolvedValue({
      data: { restaurant_id: "r1", role: "owner" },
    });
    const result = await requireOwner();
    expect(result).not.toBeInstanceOf(NextResponse);
    expect((result as { role: string }).role).toBe("owner");
  });
});
