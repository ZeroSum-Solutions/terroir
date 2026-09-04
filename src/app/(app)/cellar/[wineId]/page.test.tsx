import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  notFound: vi.fn(),
  resolveXWinesProfile: vi.fn(),
  fetchVintageRatings: vi.fn(),
  resolveHouseProfile: vi.fn(),
  resolveReferenceProfile: vi.fn(),
  resolveCellarContext: vi.fn(),
  started: [] as string[],
}));

vi.mock("@/lib/auth-context", () => ({ getAuthContext: mocks.getAuthContext }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/wine-intelligence/xwines-profile", () => ({
  resolveXWinesProfile: mocks.resolveXWinesProfile,
  fetchVintageRatings: mocks.fetchVintageRatings,
}));
vi.mock("@/domains/wine-profile/resolve-house-profile", () => ({
  resolveHouseProfile: mocks.resolveHouseProfile,
}));
vi.mock("@/domains/wine-profile/resolve-reference-profile", () => ({
  resolveReferenceProfile: mocks.resolveReferenceProfile,
}));
vi.mock("@/domains/wine-profile/resolve-cellar-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domains/wine-profile/resolve-cellar-context")>()),
  resolveCellarContext: mocks.resolveCellarContext,
}));
vi.mock("./wine-detail-view", () => ({ WineDetailView: () => null }));

const { default: WineDetailPage } = await import("./page");

const WINE_ID = "11111111-2222-4333-8444-555555555555";
const WINE = {
  id: WINE_ID,
  name: "Koonunga Hill Shiraz-Cabernet",
  producer: "Penfolds",
  vintage: 2018,
  size_ml: 750,
  canonical_wine_id: null,
  drink_window_start: 2020,
  drink_window_end: 2030,
  drink_window_basis: null,
  drink_window_set_by: null,
  drink_window_set_at: null,
};

const HOUSE = {
  taste: { value: { descriptors: [], corpusSize: 0 }, basis: { kind: "house", notes: 0 } },
  score: null,
  notes: [],
};
const REFERENCE = { window: null, score: null, notes: [], structure: null };
const CELLAR = {
  sellingFormatUnits: 1,
  otherFormatUnits: 0,
  bottleCount: 1,
  locations: ["A2"],
  lastPutAwayAt: "2026-08-01",
  lastDepletionAt: null,
  deadStockDays: 90,
  publishedBottlePrice: null,
  weightedUnitCost: null,
  listedAndOrderable: true,
};

function supabaseReturning(wine: unknown, errors: { wine?: unknown } = {}) {
  const filters: Record<string, unknown> = {};
  const selected: Record<string, string> = {};
  return {
    filters,
    selected,
    client: {
      from: (table: string) => {
        const self = {
          select: (columns: string) => {
            selected[table] = columns;
            return self;
          },
          eq: (column: string, value: unknown) => {
            filters[`${table}.${column}`] = value;
            return self;
          },
          order: () => self,
          maybeSingle: () => ({
            then: (r: (v: unknown) => unknown) =>
              r(errors.wine ? { data: null, error: errors.wine } : { data: wine, error: null }),
          }),
          then: (r: (v: unknown) => unknown) => r({ data: [], error: null }),
        };
        return self;
      },
      rpc: () => ({
        then: (r: (v: unknown) => unknown) => r({ data: [], error: null }),
      }),
    },
  };
}

/** A resolver stub that records when it STARTED, then settles on a later tick. */
function deferred<T>(name: string, value: T) {
  return vi.fn(async () => {
    mocks.started.push(name);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return value;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.started.length = 0;
  mocks.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  mocks.resolveXWinesProfile.mockResolvedValue({ status: "ok", value: null });
  mocks.fetchVintageRatings.mockResolvedValue({ status: "ok", value: [] });
  mocks.resolveHouseProfile.mockImplementation(deferred("house", HOUSE));
  mocks.resolveReferenceProfile.mockImplementation(deferred("reference", REFERENCE));
  mocks.resolveCellarContext.mockImplementation(deferred("cellar", CELLAR));
});

it("404s a segment that is not a wine id without querying", async () => {
  // /cellar/[wineId] catches every non-static /cellar/<x>; without this guard a
  // crawler on /cellar/add would send "add" to a uuid column and raise 22P02.
  mocks.getAuthContext.mockResolvedValue({ supabase: {}, restaurantId: "r-1" });

  await expect(
    WineDetailPage({ params: Promise.resolve({ wineId: "add" }) }),
  ).rejects.toThrow("NEXT_NOT_FOUND");
  expect(mocks.getAuthContext).not.toHaveBeenCalled();
});

it("404s a wine id that belongs to no wine in this restaurant", async () => {
  const { client } = supabaseReturning(null);
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });

  await expect(
    WineDetailPage({ params: Promise.resolve({ wineId: WINE_ID }) }),
  ).rejects.toThrow("NEXT_NOT_FOUND");
  expect(mocks.resolveHouseProfile).not.toHaveBeenCalled();
});

it("scopes the wine query, and every resolver, to the caller's restaurant", async () => {
  // Defence in depth beside RLS: this page is keyed on a UUID straight from the
  // URL, which is exactly where a missing tenant filter leaks a neighbour's wine.
  const { client, filters } = supabaseReturning(WINE);
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });

  await WineDetailPage({ params: Promise.resolve({ wineId: WINE_ID }) });

  expect(filters["wines.id"]).toBe(WINE_ID);
  expect(filters["wines.restaurant_id"]).toBe("r-1");
  expect(mocks.resolveHouseProfile).toHaveBeenCalledWith(client, "r-1", WINE_ID);
  expect(mocks.resolveCellarContext).toHaveBeenCalledWith(client, "r-1", WINE_ID, 750);
  expect(mocks.resolveReferenceProfile).toHaveBeenCalledWith(
    client,
    "r-1",
    expect.objectContaining({ canonicalWineId: null, vintage: 2018, drinkWindowBasis: null }),
    null,
  );
});

it("starts all three resolvers before any of them settles", async () => {
  // Three round trips in series is the latency the composable split exists
  // to avoid. Each stub records its start and settles a tick later, so a
  // serial `await` would leave the next name unrecorded until the first ends.
  const { client } = supabaseReturning(WINE);
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });

  await WineDetailPage({ params: Promise.resolve({ wineId: WINE_ID }) });

  expect(mocks.started.slice(0, 3).sort()).toEqual(["cellar", "house", "reference"]);
});

it("hands the view what the resolvers returned, and never reads the row's rating columns", async () => {
  const { client, selected } = supabaseReturning(WINE);
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });

  const element = await WineDetailPage({ params: Promise.resolve({ wineId: WINE_ID }) });

  const props = element.props;
  expect(props.house).toBe(HOUSE);
  expect(props.reference).toBe(REFERENCE);
  expect(props.bottleCount).toBe(1);
  expect(props.locations).toEqual(["A2"]);
  // The one bottle on hand raises Last bottle; the row's unsourced window does
  // not raise Drink now, because the reference resolver returned no window.
  expect(props.badges.value.map((b: { kind: string }) => b.kind)).toEqual(["last_bottle"]);
  expect(props.badges.basis.kind).toBe("measured");
  // The columns the old byline printed are not even selected. A view that
  // never receives rating_source cannot print "claude_inference · 88".
  expect(selected.wines).not.toMatch(/\b(rating|rating_source|review_excerpt|tasting_notes)\b/);
  expect(selected.wines).toMatch(/drink_window_basis, drink_window_set_by, drink_window_set_at/);
});

it("does not fetch vintage ratings when no reference entry matched", async () => {
  // An unmatched wine is the common case; it must cost one query, not two.
  const { client } = supabaseReturning(WINE);
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });

  const element = await WineDetailPage({ params: Promise.resolve({ wineId: WINE_ID }) });

  expect(mocks.fetchVintageRatings).not.toHaveBeenCalled();
  expect(element.props.vintageRatings).toEqual({ status: "ok", value: [] });
});

it("fetches vintage ratings for the matched corpus wine, and hands the match to the reference resolver", async () => {
  const { client } = supabaseReturning(WINE);
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });
  const matched = { wineId: 174177, body: null, acidity: null };
  mocks.resolveXWinesProfile.mockResolvedValue({ status: "ok", value: matched });
  mocks.fetchVintageRatings.mockResolvedValue({
    status: "ok",
    value: [{ vintage: 2018, ratingAvg: 3.7, ratingCount: 960 }],
  });

  const element = await WineDetailPage({ params: Promise.resolve({ wineId: WINE_ID }) });

  // The bottle's own vintage goes with the request so the ratings window can
  // never drop it.
  expect(mocks.fetchVintageRatings).toHaveBeenCalledWith(expect.anything(), 174177, 2018);
  expect(element.props.vintageRatings.value).toHaveLength(1);
  expect(mocks.resolveReferenceProfile).toHaveBeenCalledWith(
    expect.anything(),
    "r-1",
    expect.anything(),
    matched,
  );
});

it("throws rather than 404s when the wine query itself fails", async () => {
  // maybeSingle() returns null for "no such wine" AND for a database outage.
  // Calling notFound() on the second tells the user their bottle was deleted.
  const { client } = supabaseReturning(null, { wine: { message: "57P01" } });
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });

  await expect(
    WineDetailPage({ params: Promise.resolve({ wineId: WINE_ID }) }),
  ).rejects.toMatchObject({ message: "57P01" });
  expect(mocks.notFound).not.toHaveBeenCalled();
});

it("throws rather than reporting an empty cellar when the cellar read fails", async () => {
  // A failed inventory read reduced to bottleCount 0 renders as "None on
  // hand" — a stock claim invented out of an outage. The cellar resolver
  // throws; the page must let it.
  const { client } = supabaseReturning(WINE);
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });
  mocks.resolveCellarContext.mockRejectedValue({ message: "57P01" });

  await expect(
    WineDetailPage({ params: Promise.resolve({ wineId: WINE_ID }) }),
  ).rejects.toMatchObject({ message: "57P01" });
});
