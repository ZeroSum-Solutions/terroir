import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireRole = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

const { DELETE, POST } = await import("./route");

type WineRow = { id: string; hero_image_url?: string | null } | null;
const WINE_ID = "11111111-1111-4111-8111-111111111111";

function makeSupabase(opts: {
  wine: WineRow;
  uploadError?: { message: string } | null;
  lookupError?: { message: string } | null;
  updateError?: { message: string } | null;
  updatedWine?: WineRow;
  removeError?: { message: string } | null;
}) {
  const upload = vi.fn(() =>
    Promise.resolve({ data: null, error: opts.uploadError ?? null }),
  );
  const getPublicUrl = vi.fn((path: string) => ({
    data: { publicUrl: `https://cdn.example/${path}` },
  }));
  const remove = vi.fn(() =>
    Promise.resolve({ data: null, error: opts.removeError ?? null }),
  );
  const storageFrom = vi.fn(() => ({ upload, getPublicUrl, remove }));
  const updates: unknown[] = [];
  const from = vi.fn((table: string) => {
    const selectFilters: Array<[string, string]> = [];
    const selectChain = {
      select: () => selectChain,
      eq: (col: string, val: string) => {
        selectFilters.push([col, val]);
        return selectChain;
      },
      maybeSingle: () =>
        Promise.resolve({
          data: table === "wines" ? opts.wine : null,
          error: opts.lookupError ?? null,
        }),
      update: (payload: unknown) => {
        const updateFilters: Array<[string, string]> = [];
        const updateChain = {
          eq: (col: string, val: string) => {
            updateFilters.push([col, val]);
            return updateChain;
          },
          select: () => ({
            maybeSingle: () => {
              updates.push({ payload, filters: updateFilters });
              return Promise.resolve({
                data:
                  opts.updatedWine === undefined
                    ? opts.wine
                    : opts.updatedWine,
                error: opts.updateError ?? null,
              });
            },
          }),
        };
        return updateChain;
      },
    };
    return selectChain;
  });
  return {
    supabase: { from, storage: { from: storageFrom } },
    getPublicUrl,
    remove,
    storageFrom,
    updates,
    upload,
  };
}

function makeContext(id = WINE_ID) {
  return { params: Promise.resolve({ id }) };
}

function makeFile(type = "image/png", size?: number) {
  const signature =
    type === "image/jpeg"
      ? new Uint8Array([0xff, 0xd8, 0xff])
      : type === "image/png"
        ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        : type === "image/webp"
          ? new TextEncoder().encode("RIFF0000WEBP")
          : new Uint8Array([0x47, 0x49, 0x46]);
  const bytes = new Uint8Array(size ?? Math.max(signature.length, 16));
  bytes.set(signature.subarray(0, bytes.length));
  return new File([bytes], "hero", { type });
}

function makeFormRequest(file: File | null): NextRequest {
  const formData = new FormData();
  if (file) formData.set("file", file);
  return { formData: async () => formData } as NextRequest;
}

function badFormRequest(): NextRequest {
  return ({
    formData: async () => {
      throw new Error("not multipart");
    },
  } as unknown) as NextRequest;
}

describe("POST /api/wines/[id]/image", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401s when unauthenticated", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const res = await POST(makeFormRequest(makeFile()), makeContext());

    expect(res.status).toBe(401);
  });

  it("400s when the request is not multipart form data", async () => {
    const { supabase } = makeSupabase({ wine: { id: WINE_ID } });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await POST(badFormRequest(), makeContext());

    expect(res.status).toBe(400);
  });

  it("400s when the file field is missing", async () => {
    const { supabase } = makeSupabase({ wine: { id: WINE_ID } });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await POST(makeFormRequest(null), makeContext());

    expect(res.status).toBe(400);
  });

  it("uploads the hero image and persists the public URL", async () => {
    const { supabase, upload, getPublicUrl, remove, updates } = makeSupabase({
      wine: { id: WINE_ID },
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await POST(makeFormRequest(makeFile()), makeContext());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      hero_image_url: `https://cdn.example/r-A/${WINE_ID}.png`,
    });
    expect(upload).toHaveBeenCalledWith(
      `r-A/${WINE_ID}.png`,
      expect.any(Buffer),
      {
      contentType: "image/png",
      upsert: true,
      },
    );
    expect(getPublicUrl).toHaveBeenCalledWith(`r-A/${WINE_ID}.png`);
    expect(updates).toContainEqual({
      payload: {
        hero_image_url: `https://cdn.example/r-A/${WINE_ID}.png`,
      },
      filters: [
        ["id", WINE_ID],
        ["restaurant_id", "r-A"],
      ],
    });
    expect(remove).toHaveBeenCalledWith([`r-A/${WINE_ID}.jpg`]);
    expect(remove).toHaveBeenCalledWith([`r-A/${WINE_ID}.webp`]);
    expect(remove).not.toHaveBeenCalledWith([`r-A/${WINE_ID}.png`]);
  });

  it("treats an upload to the already-persisted object path as idempotent", async () => {
    const publicUrl = `https://cdn.example/r-A/${WINE_ID}.png`;
    const { supabase, updates } = makeSupabase({
      wine: { id: WINE_ID, hero_image_url: publicUrl },
      updateError: { message: "write should not run" },
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await POST(makeFormRequest(makeFile()), makeContext());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      hero_image_url: publicUrl,
    });
    expect(updates).toHaveLength(0);
  });

  it("415s unsupported image types before touching storage", async () => {
    const { supabase, upload } = makeSupabase({ wine: { id: WINE_ID } });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await POST(makeFormRequest(makeFile("image/gif")), makeContext());

    expect(res.status).toBe(415);
    expect(upload).not.toHaveBeenCalled();
  });

  it("415s when declared image type does not match the file bytes", async () => {
    const { supabase, upload } = makeSupabase({ wine: { id: WINE_ID } });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });
    const spoofed = new File(["not a png"], "hero.png", {
      type: "image/png",
    });

    const res = await POST(makeFormRequest(spoofed), makeContext());

    expect(res.status).toBe(415);
    expect(upload).not.toHaveBeenCalled();
  });

  it("413s images over 10 MB", async () => {
    const { supabase, upload } = makeSupabase({ wine: { id: WINE_ID } });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await POST(
      makeFormRequest(makeFile("image/png", 10 * 1024 * 1024 + 1)),
      makeContext(),
    );

    expect(res.status).toBe(413);
    expect(upload).not.toHaveBeenCalled();
  });

  it("404s when the wine is outside the caller restaurant", async () => {
    const { supabase, upload } = makeSupabase({ wine: null });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await POST(makeFormRequest(makeFile()), makeContext());

    expect(res.status).toBe(404);
    expect(upload).not.toHaveBeenCalled();
  });

  it("500s when the tenant wine lookup fails", async () => {
    const { supabase, upload } = makeSupabase({
      wine: null,
      lookupError: { message: "database offline" },
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await POST(makeFormRequest(makeFile()), makeContext());

    expect(res.status).toBe(500);
    expect(upload).not.toHaveBeenCalled();
  });

  it("500s when storage upload fails", async () => {
    const { supabase } = makeSupabase({
      wine: { id: WINE_ID },
      uploadError: { message: "bucket offline" },
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await POST(makeFormRequest(makeFile()), makeContext());

    expect(res.status).toBe(500);
  });

  it("removes the uploaded object when persisting its URL fails", async () => {
    const { supabase, remove } = makeSupabase({
      wine: { id: WINE_ID },
      updateError: { message: "write failed" },
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await POST(makeFormRequest(makeFile()), makeContext());

    expect(res.status).toBe(500);
    expect(remove).toHaveBeenCalledWith([`r-A/${WINE_ID}.png`]);
  });

  it("404s and removes the object when the tenant update affects no wine", async () => {
    const { supabase, remove } = makeSupabase({
      wine: { id: WINE_ID },
      updatedWine: null,
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await POST(makeFormRequest(makeFile()), makeContext());

    expect(res.status).toBe(404);
    expect(remove).toHaveBeenCalledWith([`r-A/${WINE_ID}.png`]);
  });
});

describe("DELETE /api/wines/[id]/image", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401s when unauthenticated", async () => {
    mockRequireRole.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const res = await DELETE({} as NextRequest, makeContext());

    expect(res.status).toBe(401);
  });

  it("removes image variants and clears the hero URL", async () => {
    const { supabase, remove, updates } = makeSupabase({
      wine: { id: WINE_ID },
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await DELETE({} as NextRequest, makeContext());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ hero_image_url: null });
    expect(remove).toHaveBeenCalledWith([`r-A/${WINE_ID}.jpg`]);
    expect(remove).toHaveBeenCalledWith([`r-A/${WINE_ID}.png`]);
    expect(remove).toHaveBeenCalledWith([`r-A/${WINE_ID}.webp`]);
    expect(updates).toContainEqual({
      payload: { hero_image_url: null },
      filters: [
        ["id", WINE_ID],
        ["restaurant_id", "r-A"],
      ],
    });
  });

  it("500s after clearing the URL when object removal needs a retry", async () => {
    const { supabase, updates } = makeSupabase({
      wine: { id: WINE_ID },
      removeError: { message: "not found" },
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await DELETE({} as NextRequest, makeContext());

    expect(res.status).toBe(500);
    expect(updates).toContainEqual({
      payload: { hero_image_url: null },
      filters: [
        ["id", WINE_ID],
        ["restaurant_id", "r-A"],
      ],
    });
  });

  it("404s when the wine is outside the caller restaurant", async () => {
    const { supabase, remove } = makeSupabase({ wine: null });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await DELETE({} as NextRequest, makeContext());

    expect(res.status).toBe(404);
    expect(remove).not.toHaveBeenCalled();
  });

  it("500s when clearing the hero URL fails", async () => {
    const { supabase } = makeSupabase({
      wine: { id: WINE_ID },
      updateError: { message: "write failed" },
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await DELETE({} as NextRequest, makeContext());

    expect(res.status).toBe(500);
  });

  it("404s when clearing the URL affects no tenant wine", async () => {
    const { supabase, remove } = makeSupabase({
      wine: { id: WINE_ID },
      updatedWine: null,
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await DELETE({} as NextRequest, makeContext());

    expect(res.status).toBe(404);
    expect(remove).not.toHaveBeenCalled();
  });
});
