import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/**
 * GET /api/team/members tests.
 *
 * Focus: BND-013 acceptance criterion — the response body contains no field
 * whose name matches /token/i. A snapshot-style walk over the JSON asserts
 * this over the full shape, not just the top-level keys.
 */

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const { GET } = await import("./route");

type MembershipsPayload = {
  data: Array<{
    id: string;
    user_id: string;
    role: string;
    created_at: string;
  }>;
  error: unknown;
};
type InvitationsPayload = {
  data: Array<{
    id: string;
    role: string;
    email: string | null;
    expires_at: string;
    accepted_at: string | null;
    created_at: string;
  }>;
  error: unknown;
};

function walkForTokenKey(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => walkForTokenKey(v, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    const offenders: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (/token/i.test(k)) offenders.push(`${path}.${k}`);
      offenders.push(...walkForTokenKey(v, `${path}.${k}`));
    }
    return offenders;
  }
  return [];
}

describe("GET /api/team/members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function buildSupabase(opts: {
    memberships: MembershipsPayload;
    invitations: InvitationsPayload;
    invitationSelectCapture?: (cols: string) => void;
  }) {
    return {
      from: (table: string) => {
        if (table === "memberships") {
          return {
            select: () => ({
              eq: () => ({
                order: () => Promise.resolve(opts.memberships),
              }),
            }),
          };
        }
        if (table === "invitations") {
          return {
            select: (cols: string) => {
              opts.invitationSelectCapture?.(cols);
              return {
                eq: () => ({
                  is: () => ({
                    order: () => Promise.resolve(opts.invitations),
                  }),
                }),
              };
            },
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };
  }

  it("returns no field whose name matches /token/i anywhere in the response body", async () => {
    let capturedCols = "";
    const supabase = buildSupabase({
      memberships: {
        data: [
          {
            id: "m1",
            user_id: "u1",
            role: "owner",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        error: null,
      },
      invitations: {
        // NB: the DB returns whatever the select picked. Simulate a row
        // shape with `id, role, email, expires_at, accepted_at, created_at`.
        data: [
          {
            id: "i1",
            role: "staff",
            email: "new@example.com",
            expires_at: "2026-05-01T00:00:00Z",
            accepted_at: null,
            created_at: "2026-04-01T00:00:00Z",
          },
        ],
        error: null,
      },
      invitationSelectCapture: (cols) => {
        capturedCols = cols;
      },
    });

    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-1",
      user: { id: "u1" },
    });

    const res = await GET();
    expect(res).toBeInstanceOf(NextResponse);
    expect(res.status).toBe(200);

    // 1. Response body: no token-ish field, at any depth.
    const body = await res.json();
    const offenders = walkForTokenKey(body);
    expect(offenders).toEqual([]);

    // 2. The SQL column list the route asks Supabase for also must not
    //    include "token" — proves we're not just filtering after fetch.
    expect(capturedCols).not.toMatch(/token/i);
  });

  it("marks every returned pending invite with has_pending_invite: true", async () => {
    const supabase = buildSupabase({
      memberships: { data: [], error: null },
      invitations: {
        data: [
          {
            id: "i1",
            role: "staff",
            email: null,
            expires_at: "2026-05-01T00:00:00Z",
            accepted_at: null,
            created_at: "2026-04-01T00:00:00Z",
          },
          {
            id: "i2",
            role: "manager",
            email: "m@example.com",
            expires_at: "2026-05-02T00:00:00Z",
            accepted_at: null,
            created_at: "2026-04-02T00:00:00Z",
          },
        ],
        error: null,
      },
    });

    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-1",
      user: { id: "u1" },
    });

    const res = await GET();
    const body = (await res.json()) as {
      invitations: Array<{ id: string; has_pending_invite: boolean }>;
    };
    expect(body.invitations).toHaveLength(2);
    for (const inv of body.invitations) {
      expect(inv.has_pending_invite).toBe(true);
    }
  });

  it("redacts membership provider failures instead of returning an empty roster", async () => {
    const supabase = buildSupabase({
      memberships: {
        data: [],
        error: new Error("provider secret"),
      },
      invitations: { data: [], error: null },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-1",
      user: { id: "u1" },
    });

    const res = await GET();

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: "internal_error", message: "Internal server error." },
    });
    expect(JSON.stringify(body)).not.toContain("provider secret");
  });
});
