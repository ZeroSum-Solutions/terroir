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

type WineRow = { id: string } | null;

function makeSupabase(opts: {
  wine: WineRow;
  uploadError?: { message: string } | null;
  updateError?: { message: string } | null;
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
      single: () =>
        Promise.resolve({
          data: table === "wines" ? opts.wine : null,
          error: opts.wine ? null : { message: "missing" },
        }),
      update: (payload: unknown) => {
        const updateFilters: Array<[string, string]> = [];
        const updateChain = {
          eq: (col: string, val: string): unknown => {
            updateFilters.push([col, val]);
            if (updateFilters.length >= 2) {
              updates.push({ payload, filters: updateFilters });
              return Promise.resolve({ error: opts.updateError ?? null });
            }
            return updateChain;
          },
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

function makeContext(id = "w-1") {
  return { params: Promise.resolve({ id }) };
}

function makeFile(type = "image/png", size = 3) {
  return new File([new Uint8Array(size)], "hero", { type });
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
    const { supabase } = makeSupabase({ wine: { id: "w-1" } });
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
    const { supabase } = makeSupabase({ wine: { id: "w-1" } });
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
    const { supabase, upload, getPublicUrl, updates } = makeSupabase({
      wine: { id: "w-1" },
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
      hero_image_url: "https://cdn.example/r-A/w-1.png",
    });
    expect(upload).toHaveBeenCalledWith("r-A/w-1.png", expect.any(Buffer), {
      contentType: "image/png",
      upsert: true,
    });
    expect(getPublicUrl).toHaveBeenCalledWith("r-A/w-1.png");
    expect(updates).toContainEqual({
      payload: { hero_image_url: "https://cdn.example/r-A/w-1.png" },
      filters: [
        ["id", "w-1"],
        ["restaurant_id", "r-A"],
      ],
    });
  });

  it("415s unsupported image types before touching storage", async () => {
    const { supabase, upload } = makeSupabase({ wine: { id: "w-1" } });
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

  it("413s images over 10 MB", async () => {
    const { supabase, upload } = makeSupabase({ wine: { id: "w-1" } });
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

  it("500s when storage upload fails", async () => {
    const { supabase } = makeSupabase({
      wine: { id: "w-1" },
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
      wine: { id: "w-1" },
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
    expect(remove).toHaveBeenCalledWith(["r-A/w-1.jpg"]);
    expect(remove).toHaveBeenCalledWith(["r-A/w-1.png"]);
    expect(remove).toHaveBeenCalledWith(["r-A/w-1.webp"]);
    expect(updates).toContainEqual({
      payload: { hero_image_url: null },
      filters: [
        ["id", "w-1"],
        ["restaurant_id", "r-A"],
      ],
    });
  });

  it("still clears the hero URL when object removal is best-effort", async () => {
    const { supabase, updates } = makeSupabase({
      wine: { id: "w-1" },
      removeError: { message: "not found" },
    });
    mockRequireRole.mockResolvedValue({
      supabase,
      restaurantId: "r-A",
      user: { id: "u-1" },
      role: "manager",
    });

    const res = await DELETE({} as NextRequest, makeContext());

    expect(res.status).toBe(200);
    expect(updates).toContainEqual({
      payload: { hero_image_url: null },
      filters: [
        ["id", "w-1"],
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
      wine: { id: "w-1" },
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
});
