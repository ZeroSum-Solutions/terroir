import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

const { GET } = await import("./route");

type ScanRow = { raw_image_path: string | null };
const SCAN_ID = "11111111-1111-4111-8111-111111111111";

function makeSupabase(opts: {
  scan: ScanRow | null;
  fetchError?: { code?: string; message: string } | null;
  signedUrl?: string;
  signedError?: { message: string } | null;
}) {
  const createSignedUrl = vi.fn(() =>
    Promise.resolve({
      data: opts.signedUrl ? { signedUrl: opts.signedUrl } : null,
      error: opts.signedError ?? null,
    }),
  );
  const storageFrom = vi.fn(() => ({ createSignedUrl }));
  const from = vi.fn((table: string) => {
    const filters: Array<[string, string]> = [];
    const chain = {
      select: () => chain,
      eq: (col: string, val: string) => {
        filters.push([col, val]);
        return chain;
      },
      single: () =>
        Promise.resolve({
          data: table === "invoice_scans" ? opts.scan : null,
          error: opts.fetchError ?? null,
        }),
    };
    return chain;
  });
  return {
    supabase: { from, storage: { from: storageFrom } },
    createSignedUrl,
    storageFrom,
  };
}

function makeContext(id = SCAN_ID) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/scans/[id]/image", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401s when unauthenticated", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const res = await GET({} as NextRequest, makeContext());

    expect(res.status).toBe(401);
  });

  it("returns a signed invoice image URL", async () => {
    const { supabase, createSignedUrl, storageFrom } = makeSupabase({
      scan: { raw_image_path: `r-A/${SCAN_ID}.png` },
      signedUrl: "https://signed.example/scan-1",
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const res = await GET({} as NextRequest, makeContext());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      url: "https://signed.example/scan-1",
    });
    expect(storageFrom).toHaveBeenCalledWith("invoice-images");
    expect(createSignedUrl).toHaveBeenCalledWith(`r-A/${SCAN_ID}.png`, 300);
  });

  it("404s when the scan has no image path", async () => {
    const { supabase, createSignedUrl } = makeSupabase({
      scan: { raw_image_path: null },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const res = await GET({} as NextRequest, makeContext());

    expect(res.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("404s when the stored path is outside the current tenant prefix", async () => {
    const { supabase, createSignedUrl } = makeSupabase({
      scan: { raw_image_path: `r-B/${SCAN_ID}.png` },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const res = await GET({} as NextRequest, makeContext());

    expect(res.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("500s when the scan lookup provider fails", async () => {
    const { supabase, createSignedUrl } = makeSupabase({
      scan: null,
      fetchError: { code: "XX000", message: "private database detail" },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const res = await GET({} as NextRequest, makeContext());

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("private");
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("500s when storage cannot create a signed URL", async () => {
    const { supabase } = makeSupabase({
      scan: { raw_image_path: `r-A/${SCAN_ID}.png` },
      signedError: { message: "storage unavailable" },
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "staff",
    });

    const res = await GET({} as NextRequest, makeContext());

    expect(res.status).toBe(500);
  });
});
