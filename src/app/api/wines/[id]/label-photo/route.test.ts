import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: (...args: unknown[]) => mockRequireMembership(...args),
}));

const mockSaveWineLabelPhoto = vi.fn();
vi.mock("@/domains/cellar/wine-image-service", async () => {
  const actual = await vi.importActual<
    typeof import("@/domains/cellar/wine-image-service")
  >("@/domains/cellar/wine-image-service");
  return {
    ...actual,
    saveWineLabelPhoto: (...args: unknown[]) => mockSaveWineLabelPhoto(...args),
  };
});

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const { POST } = await import("./route");
const {
  WineImageNotFoundError,
  WineImageStorageError,
  WineImageTooLargeError,
  WineImageUnsupportedTypeError,
} = await import("@/domains/cellar/wine-image-service");

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const WINE_ID = "55555555-5555-4555-8555-555555555555";

function request(body: FormData | null): NextRequest {
  return {
    formData: async () => {
      if (!body) throw new Error("not multipart");
      return body;
    },
  } as unknown as NextRequest;
}

function withFile(name = "label.jpg", type = "image/jpeg"): FormData {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(10)], name, { type }));
  return form;
}

const params = Promise.resolve({ id: WINE_ID });

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireMembership.mockResolvedValue({ supabase: {}, restaurantId: RESTAURANT_ID });
  mockSaveWineLabelPhoto.mockResolvedValue({
    applied: true,
    heroImageUrl: "https://cdn.example/label.jpg",
  });
});

describe("POST /api/wines/[id]/label-photo", () => {
  it("is open to any member, not just owner/manager — it can only fill an empty slot", async () => {
    await POST(request(withFile()), { params });

    expect(mockRequireMembership).toHaveBeenCalled();
  });

  it("returns 401/403 straight through when auth refuses", async () => {
    const refusal = NextResponse.json({ error: "nope" }, { status: 403 });
    mockRequireMembership.mockResolvedValue(refusal);

    const res = await POST(request(withFile()), { params });

    expect(res).toBe(refusal);
    expect(mockSaveWineLabelPhoto).not.toHaveBeenCalled();
  });

  it("stores the photo and reports the URL", async () => {
    const res = await POST(request(withFile()), { params });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      hero_image_url: "https://cdn.example/label.jpg",
      applied: true,
    });
    expect(mockSaveWineLabelPhoto).toHaveBeenCalledWith(
      expect.objectContaining({ restaurantId: RESTAURANT_ID, wineId: WINE_ID }),
    );
  });

  it("treats a wine that already has a picture as an ordinary 200, not an error", async () => {
    // Re-scanning a bottle already in the cellar is normal. Reporting it as a
    // failure would put an error in front of a completed save.
    mockSaveWineLabelPhoto.mockResolvedValue({ applied: false, heroImageUrl: null });

    const res = await POST(request(withFile()), { params });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ hero_image_url: null, applied: false });
  });

  it("rejects a body that is not multipart", async () => {
    const res = await POST(request(null), { params });

    expect(res.status).toBe(400);
    expect(mockSaveWineLabelPhoto).not.toHaveBeenCalled();
  });

  it("rejects a multipart body with no file field", async () => {
    const res = await POST(request(new FormData()), { params });

    expect(res.status).toBe(400);
    expect(mockSaveWineLabelPhoto).not.toHaveBeenCalled();
  });

  it("rejects a 'file' field that is a string rather than a file", async () => {
    const form = new FormData();
    form.append("file", "not-a-file");

    const res = await POST(request(form), { params });

    expect(res.status).toBe(400);
    expect(mockSaveWineLabelPhoto).not.toHaveBeenCalled();
  });

  it.each([
    ["a wine in another restaurant", () => new WineImageNotFoundError(), 404],
    ["an unsupported type", () => new WineImageUnsupportedTypeError(), 415],
    ["an oversized file", () => new WineImageTooLargeError(), 413],
    ["a storage failure", () => new WineImageStorageError(new Error("boom")), 500],
  ])("maps %s to %i", async (_label, makeError, status) => {
    mockSaveWineLabelPhoto.mockRejectedValue(makeError());

    const res = await POST(request(withFile()), { params });

    expect(res.status).toBe(status);
  });
});
