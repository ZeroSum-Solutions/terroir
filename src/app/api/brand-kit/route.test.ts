import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireRole = vi.fn();
const mockExtractPalette = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));
vi.mock("@/lib/branding/palette", () => ({
  extractPaletteFromImage: (...args: unknown[]) => mockExtractPalette(...args),
}));

const { POST } = await import("./route");

function makeSupabase() {
  const upsert = vi.fn((payload: unknown, options: unknown) => ({
    select: () => ({
      single: async () => ({ data: { id: "kit-1", ...payload as object }, error: null }),
    }),
    payload,
    options,
  }));
  return { supabase: { from: vi.fn(() => ({ upsert })) }, upsert };
}

function request(file: File | null) {
  const form = new FormData();
  if (file) form.set("file", file);
  return new Request("http://localhost/api/brand-kit", {
    method: "POST",
    body: form,
  }) as unknown as NextRequest;
}

describe("POST /api/brand-kit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires an owner or manager", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    );
    expect((await POST(request(null))).status).toBe(403);
    expect(mockRequireRole).toHaveBeenCalledWith(["owner", "manager"]);
  });

  it("rejects unsupported logo types before extraction", async () => {
    const { supabase } = makeSupabase();
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const response = await POST(
      request(new File(["gif"], "logo.gif", { type: "image/gif" })),
    );

    expect(response.status).toBe(422);
    expect(mockExtractPalette).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "unsupported_logo_format",
        message: expect.stringContaining("non-interlaced 8-bit RGB or RGBA PNG"),
      },
    });
  });

  it.each([
    ["image/jpeg", "logo.jpg"],
    ["image/webp", "logo.webp"],
  ])("rejects advertised-but-undecodable %s uploads with the exact PNG contract", async (type, name) => {
    const { supabase } = makeSupabase();
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const response = await POST(request(new File(["bytes"], name, { type })));

    expect(response.status).toBe(422);
    expect(mockExtractPalette).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining("non-interlaced 8-bit RGB or RGBA PNG") },
    });
  });

  it("creates or updates the brand kit with the extracted palette", async () => {
    const { supabase, upsert } = makeSupabase();
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    mockExtractPalette.mockResolvedValue(["#CC2233", "#2244CC"]);
    const file = new File(["png-bytes"], "logo.png", { type: "image/png" });

    const response = await POST(request(file));

    expect(response.status).toBe(200);
    expect(mockExtractPalette).toHaveBeenCalledWith(
      expect.any(Buffer),
      "image/png",
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        restaurant_id: "r-1",
        logo_url: expect.stringMatching(/^data:image\/png;base64,/),
        palette: { colors: ["#CC2233", "#2244CC"] },
        proposals: null,
      }),
      { onConflict: "restaurant_id" },
    );
    await expect(response.json()).resolves.toMatchObject({
      brandKit: {
        palette: { colors: ["#CC2233", "#2244CC"] },
        proposals: null,
      },
    });
  });

  it("422s a corrupt supported image without touching the database", async () => {
    const { supabase, upsert } = makeSupabase();
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    mockExtractPalette.mockRejectedValue(new Error("bad pixels"));

    const response = await POST(
      request(new File(["not-a-png"], "logo.png", { type: "image/png" })),
    );

    expect(response.status).toBe(422);
    expect(upsert).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_logo",
        message: expect.stringContaining("non-interlaced 8-bit RGB or RGBA PNG"),
      },
    });
  });
});
