import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpload = vi.fn();
const mockGetPublicUrl = vi.fn();
const mockRemove = vi.fn();
vi.mock("@/adapters/storage", async () => {
  const actual = await vi.importActual<typeof import("@/adapters/storage")>("@/adapters/storage");
  return {
    ...actual,
    uploadSupabaseObject: (...args: unknown[]) => mockUpload(...args),
    getSupabasePublicUrl: (...args: unknown[]) => mockGetPublicUrl(...args),
    removeSupabaseObjects: (...args: unknown[]) => mockRemove(...args),
  };
});
const mockCaptureException = vi.fn();
vi.mock("@sentry/nextjs", () => ({ captureException: mockCaptureException }));

const {
  SupabaseStorageError,
} = await import("@/adapters/storage");
const {
  WineImageNotFoundError,
  WineImagePersistenceError,
  WineImageStorageError,
  WineImageTooLargeError,
  WineImageUnsupportedTypeError,
  deleteWineHeroImage,
  uploadWineHeroImage,
} = await import("./wine-image-service");

const RESTAURANT_ID = "11111111-1111-4111-8111-111111111111";
const WINE_ID = "55555555-5555-4555-8555-555555555555";

function makeSupabase(opts: {
  wineExists?: boolean;
  updateError?: { message?: string } | null;
}) {
  const from = vi.fn((table: string) => {
    if (table !== "wines") throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => (opts.wineExists === false
              ? { data: null, error: { code: "PGRST116" } }
              : { data: { id: WINE_ID }, error: null }),
          }),
        }),
      }),
      update: () => ({
        eq: () => ({
          eq: async () => ({ error: opts.updateError ?? null }),
        }),
      }),
    };
  });
  return { from };
}

function makeFile(type: string, size: number, name = "bottle.jpg"): File {
  return new File([new Uint8Array(size)], name, { type });
}

describe("uploadWineHeroImage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses to upload for a wine that doesn't exist in this restaurant", async () => {
    const supabase = makeSupabase({ wineExists: false });

    await expect(
      uploadWineHeroImage({
        supabase: supabase as never,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        file: makeFile("image/jpeg", 1000),
      }),
    ).rejects.toBeInstanceOf(WineImageNotFoundError);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("rejects an unsupported file type before ever touching storage", async () => {
    const supabase = makeSupabase({});

    await expect(
      uploadWineHeroImage({
        supabase: supabase as never,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        file: makeFile("image/gif", 1000),
      }),
    ).rejects.toBeInstanceOf(WineImageUnsupportedTypeError);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("rejects a file over the 10MB limit before touching storage", async () => {
    const supabase = makeSupabase({});

    await expect(
      uploadWineHeroImage({
        supabase: supabase as never,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        file: makeFile("image/png", 10 * 1024 * 1024 + 1),
      }),
    ).rejects.toBeInstanceOf(WineImageTooLargeError);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("wraps a storage upload failure as a reported WineImageStorageError", async () => {
    const supabase = makeSupabase({});
    mockUpload.mockRejectedValue(new SupabaseStorageError("boom", new Error("boom")));

    await expect(
      uploadWineHeroImage({
        supabase: supabase as never,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        file: makeFile("image/jpeg", 1000),
      }),
    ).rejects.toBeInstanceOf(WineImageStorageError);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("re-throws an unrecognized upload error as-is instead of masking it", async () => {
    const supabase = makeSupabase({});
    const unrelated = new Error("network down");
    mockUpload.mockRejectedValue(unrelated);

    await expect(
      uploadWineHeroImage({
        supabase: supabase as never,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        file: makeFile("image/jpeg", 1000),
      }),
    ).rejects.toBe(unrelated);
  });

  it("wraps a failure to persist the uploaded image's URL as WineImagePersistenceError", async () => {
    const supabase = makeSupabase({ updateError: { message: "db down" } });
    mockUpload.mockResolvedValue(undefined);
    mockGetPublicUrl.mockReturnValue("https://cdn.example/wine.jpg");

    await expect(
      uploadWineHeroImage({
        supabase: supabase as never,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        file: makeFile("image/jpeg", 1000),
      }),
    ).rejects.toBeInstanceOf(WineImagePersistenceError);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("returns the public URL on a clean upload", async () => {
    const supabase = makeSupabase({});
    mockUpload.mockResolvedValue(undefined);
    mockGetPublicUrl.mockReturnValue("https://cdn.example/wine.jpg");

    const url = await uploadWineHeroImage({
      supabase: supabase as never,
      restaurantId: RESTAURANT_ID,
      wineId: WINE_ID,
      file: makeFile("image/jpeg", 1000),
    });

    expect(url).toBe("https://cdn.example/wine.jpg");
  });
});

describe("deleteWineHeroImage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses to delete for a wine that doesn't exist in this restaurant", async () => {
    const supabase = makeSupabase({ wineExists: false });

    await expect(
      deleteWineHeroImage({ supabase: supabase as never, restaurantId: RESTAURANT_ID, wineId: WINE_ID }),
    ).rejects.toBeInstanceOf(WineImageNotFoundError);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("wraps a failure to clear the image URL as WineImagePersistenceError even though object removal is best-effort", async () => {
    const supabase = makeSupabase({ updateError: { message: "db down" } });
    mockRemove.mockRejectedValue(new Error("storage unavailable"));

    await expect(
      deleteWineHeroImage({ supabase: supabase as never, restaurantId: RESTAURANT_ID, wineId: WINE_ID }),
    ).rejects.toBeInstanceOf(WineImagePersistenceError);
    // Best-effort removal is attempted for all three extensions regardless
    // of failure.
    expect(mockRemove).toHaveBeenCalledTimes(3);
  });

  it("clears the image URL on a clean delete", async () => {
    const supabase = makeSupabase({});
    mockRemove.mockResolvedValue(undefined);

    const result = await deleteWineHeroImage({
      supabase: supabase as never,
      restaurantId: RESTAURANT_ID,
      wineId: WINE_ID,
    });

    expect(result).toBeNull();
  });
});
