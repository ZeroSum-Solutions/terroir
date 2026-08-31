import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function urlRequest(url: string) {
  return new Request("http://localhost/api/brand-kit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
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

  // LIST-05 — the route used to accept image/png alone, so the JPEG most
  // people have to hand was refused by a decoder that can read it.
  it.each([
    ["image/jpeg", "logo.jpg"],
    ["image/webp", "logo.webp"],
    ["image/gif", "logo.gif"],
    ["image/avif", "logo.avif"],
  ])("extracts a palette from %s", async (type, name) => {
    const { supabase, upsert } = makeSupabase();
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
    mockExtractPalette.mockResolvedValue(["#CC2233"]);

    const response = await POST(request(new File(["bytes"], name, { type })));

    expect(response.status).toBe(200);
    expect(mockExtractPalette).toHaveBeenCalledWith(expect.any(Buffer), type);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ palette: { colors: ["#CC2233"] } }),
      { onConflict: "restaurant_id" },
    );
  });

  it("still rejects a format the rasterizer cannot be trusted with", async () => {
    const { supabase } = makeSupabase();
    mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });

    const response = await POST(
      request(new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" })),
    );

    expect(response.status).toBe(422);
    expect(mockExtractPalette).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "unsupported_logo_format",
        message: expect.stringContaining("PNG, JPEG, WebP"),
      },
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
        message: expect.stringContaining("PNG, JPEG, WebP"),
      },
    });
  });

  describe("LIST-05 — building a kit from a business URL", () => {
    const previousKey = process.env.FIRECRAWL_API_KEY;
    afterEach(() => {
      if (previousKey === undefined) delete process.env.FIRECRAWL_API_KEY;
      else process.env.FIRECRAWL_API_KEY = previousKey;
      vi.unstubAllGlobals();
    });

    it.each([
      "http://127.0.0.1/admin",
      "http://localhost:3000",
      "https://10.0.0.5",
      "https://192.168.1.1",
      "https://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
    ])("refuses %s without calling out", async (url) => {
      const { supabase } = makeSupabase();
      mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
      const outbound = vi.fn();
      vi.stubGlobal("fetch", outbound);

      const response = await POST(urlRequest(url));

      expect(response.status).toBe(400);
      expect(outbound).not.toHaveBeenCalled();
    });

    it("stores the palette Firecrawl's branding format returns", async () => {
      const { supabase, upsert } = makeSupabase();
      mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
      process.env.FIRECRAWL_API_KEY = "fc-test";
      const outbound = vi.fn(async () =>
        Response.json({
          success: true,
          data: {
            branding: {
              colors: { primary: "#FF4C00", background: "#F9F9F9" },
              // Not SVG (finding C: safeLogoUrl refuses data:image/svg+xml —
              // covered directly in site-brand.test.ts) — a raster format,
              // to keep this test's focus on palette + logo storage.
              images: { logo: "data:image/png;base64,iVBORw0KGgoAAAA=" },
            },
          },
        }),
      );
      vi.stubGlobal("fetch", outbound);

      const response = await POST(urlRequest("thefrenchlaundry.com"));

      expect(response.status).toBe(200);
      expect(outbound).toHaveBeenCalledWith(
        "https://api.firecrawl.dev/v2/scrape",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            url: "https://thefrenchlaundry.com/",
            formats: ["branding"],
          }),
        }),
      );
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          palette: { colors: ["#FF4C00", "#F9F9F9"] },
          logo_url: expect.stringContaining("data:image/png"),
        }),
        { onConflict: "restaurant_id" },
      );
    });

    it("says so, rather than failing silently, when the key is missing", async () => {
      const { supabase, upsert } = makeSupabase();
      mockRequireRole.mockResolvedValue({ supabase, restaurantId: "r-1" });
      delete process.env.FIRECRAWL_API_KEY;

      const response = await POST(urlRequest("https://example.com"));

      expect(response.status).toBe(502);
      expect(upsert).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toMatchObject({
        error: { message: expect.stringContaining("Upload a logo instead") },
      });
    });
  });
});
