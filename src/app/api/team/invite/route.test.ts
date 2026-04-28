import { beforeEach, describe, expect, it, vi } from "vitest";
import { type NextRequest } from "next/server";

const mockRequireOwner = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireOwner: (...args: unknown[]) => mockRequireOwner(...args),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

const { POST } = await import("./route");

/**
 * BND-011: invite POST tests.
 *
 * Coverage: happy path persists email, missing/malformed email rejected,
 * email is normalized (case + whitespace) before insert.
 */

const RID = "11111111-1111-4111-8111-111111111111";

type InsertedRow = Record<string, unknown>;

function makeSupabase() {
  const inserts: InsertedRow[] = [];
  return {
    _inserts: inserts,
    from: (_t: string) => ({
      insert: (row: InsertedRow) => {
        inserts.push(row);
        return {
          select: () => ({
            single: async () => ({
              data: {
                id: "inv-1",
                token: "tok-1",
                role: row.role ?? "staff",
                email: row.email,
                expires_at: "2026-05-04T00:00:00Z",
                created_at: "2026-04-27T00:00:00Z",
              },
              error: null,
            }),
          }),
        };
      },
    }),
  };
}

function makeReq(body: unknown): NextRequest {
  return {
    json: async () => body,
    headers: new Headers({ origin: "http://localhost:3000" }),
    nextUrl: { origin: "http://localhost:3000" },
  } as unknown as NextRequest;
}

describe("POST /api/team/invite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: valid email persists invitation with that email", async () => {
    const sup = makeSupabase();
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: RID,
      user: { id: "u-1" },
      role: "owner",
    });

    const res = await POST(
      makeReq({ email: "alice@example.com", role: "manager" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("alice@example.com");
    expect(body.role).toBe("manager");
    expect(body.inviteUrl).toContain("/invite/tok-1");
    expect(sup._inserts[0]).toMatchObject({
      restaurant_id: RID,
      email: "alice@example.com",
      role: "manager",
      invited_by: "u-1",
    });
  });

  it("missing email returns 400 with field-level error", async () => {
    const sup = makeSupabase();
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: RID,
      user: { id: "u-1" },
      role: "owner",
    });

    const res = await POST(makeReq({ role: "staff" }));
    expect(res.status).toBe(400);
    expect(sup._inserts).toHaveLength(0);
  });

  it("malformed email returns 400", async () => {
    const sup = makeSupabase();
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: RID,
      user: { id: "u-1" },
      role: "owner",
    });

    const res = await POST(makeReq({ email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(sup._inserts).toHaveLength(0);
  });

  it("normalizes email: 'Alice@Example.com  ' → 'alice@example.com'", async () => {
    const sup = makeSupabase();
    mockRequireOwner.mockResolvedValue({
      supabase: sup,
      restaurantId: RID,
      user: { id: "u-1" },
      role: "owner",
    });

    const res = await POST(makeReq({ email: "Alice@Example.com  " }));
    expect(res.status).toBe(200);
    expect(sup._inserts[0]).toMatchObject({ email: "alice@example.com" });
  });

  it("forwards 403 when caller is not owner", async () => {
    const { NextResponse } = await import("next/server");
    mockRequireOwner.mockResolvedValue(
      NextResponse.json({ error: "Owner access required." }, { status: 403 }),
    );

    const res = await POST(makeReq({ email: "alice@example.com" }));
    expect(res.status).toBe(403);
  });
});
