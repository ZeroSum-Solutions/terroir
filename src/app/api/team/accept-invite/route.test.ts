import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRateLimitForTests } from "@/lib/api/rate-limit";

/**
 * /api/team/accept-invite tests.
 *
 * Focus: BND-013 — an authed user hitting this endpoint more than 10 times
 * per hour from the same IP gets a 429, and the response carries a
 * Retry-After header. The rate-limit fires BEFORE the DB lookup so a
 * brute-forcer can't exhaust the bucket by sending valid tokens either.
 */

const mockGetUser = vi.fn();
const mockFromInvitations = vi.fn();
const mockFromMemberships = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: () => mockGetUser() },
    from: () => {
      throw new Error("authenticated client must not perform invite acceptance writes");
    },
  }),
}));

vi.mock("@/lib/supabase/service-role", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "invitations") return mockFromInvitations();
      if (table === "memberships") return mockFromMemberships();
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

const { POST } = await import("./route");

function makeJsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/team/accept-invite", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

describe("POST /api/team/accept-invite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();

    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });

    // Default: invite not found, so every pre-rate-limit test returns 404
    // via the DB path.
    mockFromInvitations.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: null, error: { code: "PGRST116" } }),
        }),
      }),
    });
    mockFromMemberships.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: () => ({
              single: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      }),
    });
  });

  it("returns 429 with a Retry-After header on the 11th attempt from one IP+user in an hour", async () => {
    const headers = { "x-forwarded-for": "1.2.3.4" };

    // 10 attempts: all should reach the DB (→ 404), not be rate-limited.
    for (let i = 0; i < 10; i++) {
      const res = await POST(makeJsonRequest({ token: "bad" }, headers));
      expect(res.status).not.toBe(429);
    }

    // 11th: rate-limited.
    const blocked = await POST(makeJsonRequest({ token: "bad" }, headers));
    expect(blocked.status).toBe(429);
    const retryAfter = blocked.headers.get("Retry-After");
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("does not rate-limit unauthenticated callers past the 401", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    // Hammer 20 times — every one should be 401, never 429, because the
    // rate-limit bucket is only consumed for authed callers.
    for (let i = 0; i < 20; i++) {
      const res = await POST(
        makeJsonRequest({ token: "x" }, { "x-forwarded-for": "9.9.9.9" }),
      );
      expect(res.status).toBe(401);
    }
  });

  it("keeps separate buckets per user (one abuser doesn't block another user on the same IP)", async () => {
    const headers = { "x-forwarded-for": "5.5.5.5" };

    // User A burns through their 10.
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-A" } } });
    for (let i = 0; i < 10; i++) {
      await POST(makeJsonRequest({ token: "bad" }, headers));
    }
    const aBlocked = await POST(makeJsonRequest({ token: "bad" }, headers));
    expect(aBlocked.status).toBe(429);

    // User B on the same IP still has a full budget.
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-B" } } });
    const bFirst = await POST(makeJsonRequest({ token: "bad" }, headers));
    expect(bFirst.status).not.toBe(429);
  });
});

/**
 * BND-011: invitation email-binding tests.
 *
 * The invitation row carries the email it was sent to. The consumer
 * MUST compare invitation.email against auth.user.email and return the
 * SAME opaque 404 used for token-not-found on mismatch — so a
 * brute-forcer can't distinguish "valid token wrong user" from "no
 * such token".
 */
describe("POST /api/team/accept-invite — email binding", () => {
  const membershipInsert = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();

    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-1", email: "alice@example.com" } },
    });

    mockFromInvitations.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              id: "inv-1",
              restaurant_id: "rest-1",
              role: "staff",
              email: "bob@example.com", // different user
              expires_at: new Date(Date.now() + 86_400_000).toISOString(),
              accepted_at: null,
            },
            error: null,
          }),
        }),
      }),
      // also stub .update() in case we ever reach it (we shouldn't on mismatch)
      update: () => ({ eq: async () => ({ error: null }) }),
    });

    mockFromMemberships.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: () => ({
              single: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      }),
      insert: membershipInsert.mockResolvedValue({ error: null }),
    });
  });

  it("returns 404 on email mismatch (opaque, matches token-not-found)", async () => {
    const res = await POST(
      makeJsonRequest({ token: "valid-token" }, { "x-forwarded-for": "1.1.1.1" }),
    );
    expect(res.status).toBe(404);
    expect(membershipInsert).not.toHaveBeenCalled();
  });

  it("returns 404 when invitation.email is null (defensive — should not happen post-migration)", async () => {
    mockFromInvitations.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              id: "inv-2",
              restaurant_id: "rest-1",
              role: "staff",
              email: null,
              expires_at: new Date(Date.now() + 86_400_000).toISOString(),
              accepted_at: null,
            },
            error: null,
          }),
        }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    });

    const res = await POST(
      makeJsonRequest({ token: "valid-token" }, { "x-forwarded-for": "2.2.2.2" }),
    );
    expect(res.status).toBe(404);
    expect(membershipInsert).not.toHaveBeenCalled();
  });

  it("matches case-insensitively after normalization", async () => {
    mockFromInvitations.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              id: "inv-3",
              restaurant_id: "rest-1",
              role: "manager",
              email: "Alice@Example.com",
              expires_at: new Date(Date.now() + 86_400_000).toISOString(),
              accepted_at: null,
            },
            error: null,
          }),
        }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    });

    const res = await POST(
      makeJsonRequest({ token: "valid-token" }, { "x-forwarded-for": "3.3.3.3" }),
    );
    expect(res.status).toBe(200);
    expect(membershipInsert).toHaveBeenCalled();
  });

  it("treats an already-accepted invitation as success for its existing member", async () => {
    mockFromInvitations.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              id: "inv-accepted",
              restaurant_id: "rest-1",
              role: "staff",
              email: "alice@example.com",
              expires_at: new Date(Date.now() + 86_400_000).toISOString(),
              accepted_at: new Date().toISOString(),
            },
            error: null,
          }),
        }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    });
    mockFromMemberships.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: () => ({
              single: async () => ({ data: { id: "membership-1" }, error: null }),
            }),
          }),
        }),
      }),
      insert: membershipInsert,
    });

    const res = await POST(makeJsonRequest({ token: "accepted-token" }));

    expect(res.status).toBe(200);
    expect(membershipInsert).not.toHaveBeenCalled();
  });

  it("treats a concurrent duplicate membership insert as an idempotent success", async () => {
    mockFromInvitations.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              id: "inv-race",
              restaurant_id: "rest-1",
              role: "staff",
              email: "alice@example.com",
              expires_at: new Date(Date.now() + 86_400_000).toISOString(),
              accepted_at: null,
            },
            error: null,
          }),
        }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    });
    membershipInsert.mockResolvedValueOnce({ error: { code: "23505" } });

    const res = await POST(makeJsonRequest({ token: "race-token" }));

    expect(res.status).toBe(200);
  });
});
