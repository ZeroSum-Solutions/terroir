import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { VALID_THEME } from "@/test/fixtures/menu-theme";

const mockRequireRole = vi.fn();
const mockRevalidatePath = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args) }));

const { POST } = await import("./route");

function makeSupabase(row: { id: string; slug: string | null } | null) {
  const updates: unknown[] = [];
  const from = vi.fn(() => ({
    update: (payload: unknown) => {
      updates.push(payload);
      return {
        eq: () => ({
          eq: () => ({
            select: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
          }),
        }),
      };
    },
  }));
  return { supabase: { from }, updates };
}

function post(body: unknown): NextRequest {
  return new Request("http://localhost/api/wine-lists/list-1/theme", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const context = { params: Promise.resolve({ id: "list-1" }) };

describe("POST /api/wine-lists/[id]/theme", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a low-contrast theme with an actionable 422", async () => {
    const { supabase, updates } = makeSupabase({ id: "list-1", slug: "dinner" });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const theme = {
      ...VALID_THEME,
      palette: { ...VALID_THEME.palette, text: "#777777" },
    };

    const response = await POST(post({ theme }), context);
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("theme_contrast_failed");
    expect(body.error.message).toContain("palette.text on palette.background");
    expect(updates).toHaveLength(0);
  });

  it("rejects raw CSS before database access", async () => {
    const { supabase, updates } = makeSupabase({ id: "list-1", slug: null });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const response = await POST(
      post({ theme: { ...VALID_THEME, rawCss: "body{}" } }),
      context,
    );

    expect(response.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("stores the validated theme on the scoped list and revalidates its public page", async () => {
    const { supabase, updates } = makeSupabase({ id: "list-1", slug: "dinner" });
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const response = await POST(post({ theme: VALID_THEME }), context);

    expect(response.status).toBe(200);
    expect(updates).toEqual([{ theme: VALID_THEME }]);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/list/dinner");
    await expect(response.json()).resolves.toEqual({ theme: VALID_THEME });
  });

  it("404s a cross-tenant list even with an RLS-bypassed client", async () => {
    const { supabase } = makeSupabase(null);
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    expect((await POST(post({ theme: VALID_THEME }), context)).status).toBe(404);
  });

  it("propagates manager authorization failures", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    );
    expect((await POST(post({ theme: VALID_THEME }), context)).status).toBe(403);
  });
});
