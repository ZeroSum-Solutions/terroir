import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import { VALID_THEME } from "@/test/fixtures/menu-theme";

const mockRequireRole = vi.fn();
const mockGenerateMenuThemes = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));
vi.mock("@/lib/branding/menu-design", () => ({
  generateMenuThemes: (...args: unknown[]) => mockGenerateMenuThemes(...args),
  MenuDesignError: class MenuDesignError extends Error {
    constructor() {
      super("The model returned fewer than 3 accessible, uniquely named menu themes.");
    }
  },
}));

const { POST } = await import("./route");
const LIST_ID = "11111111-1111-4111-8111-111111111111";

function makeSupabase(options: { kit?: boolean; list?: boolean } = {}) {
  const updates: unknown[] = [];
  const from = vi.fn((table: string) => ({
    select: () => ({
      eq: () => {
        const result = table === "brand_kits"
          ? options.kit === false
            ? null
            : { palette: { colors: ["#721D35", "#F7F5F2"] } }
          : options.list === false
            ? null
            : {
                name: "Dinner",
                wine_list_sections: [{
                  name: "Reds",
                  wine_list_items: [{
                    wines: { producer: "Example Estate", name: "Cabernet", vintage: 2020 },
                  }],
                }],
              };
        const chain = {
          eq: () => chain,
          maybeSingle: async () => ({ data: result, error: null }),
        };
        return chain;
      },
    }),
    update: (payload: unknown) => {
      updates.push(payload);
      return {
        eq: () => ({
          select: () => ({ single: async () => ({ data: { id: "kit-1" }, error: null }) }),
        }),
      };
    },
  }));
  return { supabase: { from }, updates };
}

function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/brand-kit/propose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe("POST /api/brand-kit/propose", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires manager access", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    );
    expect((await POST(request({ listId: LIST_ID }))).status).toBe(403);
  });

  it("generates from the scoped brand palette and list summary, then stores proposals", async () => {
    const { supabase, updates } = makeSupabase();
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    mockGenerateMenuThemes.mockResolvedValue([
      VALID_THEME,
      { ...VALID_THEME, name: "Paper Reserve" },
      { ...VALID_THEME, name: "Night Service" },
    ]);

    const response = await POST(request({ listId: LIST_ID }));

    expect(response.status).toBe(200);
    expect(mockGenerateMenuThemes).toHaveBeenCalledWith(
      expect.objectContaining({
        palette: { colors: ["#721D35", "#F7F5F2"] },
        listSummary: expect.stringContaining("Example Estate Cabernet 2020"),
      }),
    );
    expect(updates[0]).toMatchObject({ proposals: expect.any(Array) });
    const body = await response.json();
    expect(body.proposals).toHaveLength(3);
    expect(body.proposals[0]).toEqual(VALID_THEME);
  });

  it("passes a validated refine instruction and current theme to the same lane", async () => {
    const { supabase } = makeSupabase();
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    mockGenerateMenuThemes.mockResolvedValue([
      VALID_THEME,
      { ...VALID_THEME, name: "Paper Reserve" },
      { ...VALID_THEME, name: "Night Service" },
    ]);

    await POST(request({
      listId: LIST_ID,
      instruction: "Make it more restrained",
      currentTheme: VALID_THEME,
    }));

    expect(mockGenerateMenuThemes).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: "Make it more restrained",
        currentTheme: VALID_THEME,
      }),
    );
  });

  it("404s when the brand kit or list is outside the active restaurant", async () => {
    const noKit = makeSupabase({ kit: false });
    mockRequireRole.mockResolvedValue({ supabase: noKit.supabase, restaurantId: "r-1" });
    expect((await POST(request({ listId: LIST_ID }))).status).toBe(404);

    const noList = makeSupabase({ list: false });
    mockRequireRole.mockResolvedValue({ supabase: noList.supabase, restaurantId: "r-1" });
    expect((await POST(request({ listId: LIST_ID }))).status).toBe(404);
  });

  it("returns a clear 502 and stores nothing when the lane stays non-compliant", async () => {
    const { supabase, updates } = makeSupabase();
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    const { MenuDesignError } = await import("@/lib/branding/menu-design");
    mockGenerateMenuThemes.mockRejectedValue(new MenuDesignError());

    const response = await POST(request({ listId: LIST_ID }));

    expect(response.status).toBe(502);
    expect(updates).toEqual([]);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "bad_gateway",
        message: expect.stringContaining("fewer than 3 accessible, uniquely named designs"),
      },
    });
  });
});
