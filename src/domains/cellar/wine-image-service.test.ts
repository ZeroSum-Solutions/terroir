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
  saveWineLabelPhoto,
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

/** saveWineLabelPhoto's claim is a conditional update
 * (`.is("hero_image_url", null).select("id")`), which the shared makeSupabase
 * above does not model — it needs its own builder. */
function makeLabelPhotoSupabase(opts: {
  wineExists?: boolean;
  /** Rows the conditional claim matched: [] means the wine already had an image. */
  claimedRows?: Array<{ id: string }>;
  /** PostgREST can answer a filtered update with null data rather than []. */
  claimReturnsNull?: boolean;
  claimError?: { message?: string } | null;
}) {
  const claims: Array<Record<string, unknown>> = [];
  const releases: Array<{ patch: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];

  const from = vi.fn((table: string) => {
    if (table !== "wines") throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () =>
              opts.wineExists === false
                ? { data: null, error: { code: "PGRST116" } }
                : { data: { id: WINE_ID }, error: null },
          }),
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = [];
        const chain = {
          eq: (col: string, val: unknown) => {
            filters.push([col, val]);
            // A plain thenable, deliberately NOT a Promise with `then` assigned
            // onto it: `await` short-circuits a native promise and would never
            // call the override. The release path ends on its third .eq() and
            // is awaited directly.
            return {
              eq: chain.eq,
              is: chain.is,
              then: (resolve: (v: { error: null }) => unknown) => {
                if (filters.length === 3) {
                  releases.push({ patch, filters });
                }
                return Promise.resolve({ error: null }).then(resolve);
              },
            };
          },
          is: () => ({
            select: async () => {
              claims.push(patch);
              if (opts.claimReturnsNull) return { data: null, error: null };
              return {
                data: opts.claimError ? null : (opts.claimedRows ?? [{ id: WINE_ID }]),
                error: opts.claimError ?? null,
              };
            },
          }),
        };
        return chain;
      },
    };
  });

  return { supabase: { from }, claims, releases };
}

describe("saveWineLabelPhoto — a bottle scan's own photo becomes the wine's picture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPublicUrl.mockImplementation(
      ({ path }: { path: string }) => `https://cdn.example/${path}`,
    );
  });

  it("refuses a wine that doesn't exist in this restaurant", async () => {
    const { supabase } = makeLabelPhotoSupabase({ wineExists: false });

    await expect(
      saveWineLabelPhoto({
        supabase: supabase as never,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        file: makeFile("image/jpeg", 1000),
      }),
    ).rejects.toBeInstanceOf(WineImageNotFoundError);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("rejects an unsupported type before touching storage", async () => {
    const { supabase } = makeLabelPhotoSupabase({});

    await expect(
      saveWineLabelPhoto({
        supabase: supabase as never,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        file: makeFile("image/gif", 1000),
      }),
    ).rejects.toBeInstanceOf(WineImageUnsupportedTypeError);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("rejects a file over the size ceiling before touching storage", async () => {
    const { supabase } = makeLabelPhotoSupabase({});

    await expect(
      saveWineLabelPhoto({
        supabase: supabase as never,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        file: makeFile("image/jpeg", 10 * 1024 * 1024 + 1),
      }),
    ).rejects.toBeInstanceOf(WineImageTooLargeError);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("stores the photo and returns the URL for a wine with no picture", async () => {
    const { supabase, claims } = makeLabelPhotoSupabase({});

    const outcome = await saveWineLabelPhoto({
      supabase: supabase as never,
      restaurantId: RESTAURANT_ID,
      wineId: WINE_ID,
      file: makeFile("image/jpeg", 1000),
    });

    expect(outcome).toEqual({
      applied: true,
      heroImageUrl: `https://cdn.example/${RESTAURANT_ID}/${WINE_ID}.jpg`,
    });
    expect(claims).toEqual([
      { hero_image_url: `https://cdn.example/${RESTAURANT_ID}/${WINE_ID}.jpg` },
    ]);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it("writes to the same canonical path a manual upload uses, so deletion still finds it", async () => {
    const { supabase } = makeLabelPhotoSupabase({});

    await saveWineLabelPhoto({
      supabase: supabase as never,
      restaurantId: RESTAURANT_ID,
      wineId: WINE_ID,
      file: makeFile("image/png", 1000, "label.png"),
    });

    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "wine-images",
        path: `${RESTAURANT_ID}/${WINE_ID}.png`,
        contentType: "image/png",
      }),
    );
  });

  it("uploads NOTHING when the wine already has a picture", async () => {
    const { supabase } = makeLabelPhotoSupabase({ claimedRows: [] });

    const outcome = await saveWineLabelPhoto({
      supabase: supabase as never,
      restaurantId: RESTAURANT_ID,
      wineId: WINE_ID,
      file: makeFile("image/jpeg", 1000),
    });

    expect(outcome).toEqual({ applied: false, heroImageUrl: null });
    // The whole point of claiming before uploading: the object path is shared
    // with the manual hero image, so an upload here would have overwritten a
    // manager's chosen picture while its URL kept pointing at the same place.
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("claims the row before uploading, not after", async () => {
    const order: string[] = [];
    const { supabase } = makeLabelPhotoSupabase({});
    mockGetPublicUrl.mockImplementation(({ path }: { path: string }) => `https://cdn.example/${path}`);
    mockUpload.mockImplementation(async () => {
      order.push("upload");
    });
    const originalFrom = supabase.from;
    supabase.from = vi.fn((table: string) => {
      const built = originalFrom(table);
      return {
        ...built,
        update: (patch: Record<string, unknown>) => {
          order.push("claim");
          return built.update(patch);
        },
      };
    }) as never;

    await saveWineLabelPhoto({
      supabase: supabase as never,
      restaurantId: RESTAURANT_ID,
      wineId: WINE_ID,
      file: makeFile("image/jpeg", 1000),
    });

    expect(order).toEqual(["claim", "upload"]);
  });

  it("releases the claim when the upload fails, so no wine points at a missing object", async () => {
    const { supabase, releases } = makeLabelPhotoSupabase({});
    mockUpload.mockRejectedValueOnce(new SupabaseStorageError("upload", { cause: new Error("boom") }));

    await expect(
      saveWineLabelPhoto({
        supabase: supabase as never,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        file: makeFile("image/jpeg", 1000),
      }),
    ).rejects.toBeInstanceOf(WineImageStorageError);

    expect(releases).toHaveLength(1);
    expect(releases[0].patch).toEqual({ hero_image_url: null });
    // Scoped to the URL this call wrote, so a picture someone else set in the
    // meantime is not cleared.
    expect(releases[0].filters).toContainEqual([
      "hero_image_url",
      `https://cdn.example/${RESTAURANT_ID}/${WINE_ID}.jpg`,
    ]);
  });

  it("rethrows an unexpected upload failure unchanged rather than dressing it as a storage error", async () => {
    const { supabase, releases } = makeLabelPhotoSupabase({});
    const unexpected = new TypeError("fetch is not defined");
    mockUpload.mockRejectedValueOnce(unexpected);

    await expect(
      saveWineLabelPhoto({
        supabase: supabase as never,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        file: makeFile("image/jpeg", 1000),
      }),
    ).rejects.toBe(unexpected);

    // The claim is still released: a wine must not keep a URL for an object
    // that was never written, whatever kind of failure prevented it.
    expect(releases).toHaveLength(1);
  });

  it("reports the storage error's own cause when it carries one", async () => {
    const { supabase } = makeLabelPhotoSupabase({});
    const cause = new Error("network reset");
    mockUpload.mockRejectedValueOnce(new SupabaseStorageError("upload", { cause }));

    await expect(
      saveWineLabelPhoto({
        supabase: supabase as never,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        file: makeFile("image/jpeg", 1000),
      }),
    ).rejects.toBeInstanceOf(WineImageStorageError);

    expect(mockCaptureException).toHaveBeenCalledWith(cause, expect.anything());
  });

  it("reports the storage error itself when it carries no cause", async () => {
    const { supabase } = makeLabelPhotoSupabase({});
    const bare = new SupabaseStorageError("upload");
    mockUpload.mockRejectedValueOnce(bare);

    await expect(
      saveWineLabelPhoto({
        supabase: supabase as never,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        file: makeFile("image/jpeg", 1000),
      }),
    ).rejects.toBeInstanceOf(WineImageStorageError);

    expect(mockCaptureException).toHaveBeenCalledWith(bare, expect.anything());
  });

  it("treats a claim that returns no rows and no error as a wine that already has one", async () => {
    // PostgREST can answer a filtered update with null data rather than [].
    const { supabase } = makeLabelPhotoSupabase({ claimReturnsNull: true });

    const outcome = await saveWineLabelPhoto({
      supabase: supabase as never,
      restaurantId: RESTAURANT_ID,
      wineId: WINE_ID,
      file: makeFile("image/jpeg", 1000),
    });

    expect(outcome).toEqual({ applied: false, heroImageUrl: null });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("names a webp label photo .webp, not the .jpg fallback", async () => {
    const { supabase } = makeLabelPhotoSupabase({});

    await saveWineLabelPhoto({
      supabase: supabase as never,
      restaurantId: RESTAURANT_ID,
      wineId: WINE_ID,
      file: makeFile("image/webp", 1000, "label.webp"),
    });

    expect(mockUpload).toHaveBeenCalledWith(
      expect.objectContaining({ path: `${RESTAURANT_ID}/${WINE_ID}.webp` }),
    );
  });

  it("surfaces a failed claim as a persistence error rather than uploading anyway", async () => {
    const { supabase } = makeLabelPhotoSupabase({ claimError: { message: "db down" } });

    await expect(
      saveWineLabelPhoto({
        supabase: supabase as never,
        restaurantId: RESTAURANT_ID,
        wineId: WINE_ID,
        file: makeFile("image/jpeg", 1000),
      }),
    ).rejects.toBeInstanceOf(WineImagePersistenceError);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});
