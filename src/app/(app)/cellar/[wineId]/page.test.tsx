import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  notFound: vi.fn(),
  resolveXWinesProfile: vi.fn(),
  fetchVintageRatings: vi.fn(),
}));

vi.mock("@/lib/auth-context", () => ({ getAuthContext: mocks.getAuthContext }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/wine-intelligence/xwines-profile", () => ({
  resolveXWinesProfile: mocks.resolveXWinesProfile,
  fetchVintageRatings: mocks.fetchVintageRatings,
}));
vi.mock("./wine-detail-view", () => ({ WineDetailView: () => null }));

const { default: WineDetailPage } = await import("./page");

const WINE_ID = "11111111-2222-4333-8444-555555555555";
const WINE = {
  id: WINE_ID,
  name: "Koonunga Hill Shiraz-Cabernet",
  producer: "Penfolds",
  vintage: 2018,
  canonical_wine_id: null,
};

function supabaseReturning(
  wine: unknown,
  inventory: unknown[],
  errors: { wine?: unknown; inventory?: unknown } = {},
) {
  const filters: Record<string, unknown> = {};
  return {
    filters,
    client: {
      from: (table: string) => {
        const self = {
          select: () => self,
          eq: (column: string, value: unknown) => {
            filters[`${table}.${column}`] = value;
            return self;
          },
          maybeSingle: () => ({
            then: (r: (v: unknown) => unknown) =>
              r(
                errors.wine
                  ? { data: null, error: errors.wine }
                  : { data: wine, error: null },
              ),
          }),
          then: (r: (v: unknown) => unknown) =>
            r(
              errors.inventory
                ? { data: null, error: errors.inventory }
                : { data: inventory, error: null },
            ),
        };
        return self;
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  mocks.resolveXWinesProfile.mockResolvedValue({ status: "ok", value: null });
  mocks.fetchVintageRatings.mockResolvedValue({ status: "ok", value: [] });
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
  const { client } = supabaseReturning(null, []);
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });

  await expect(
    WineDetailPage({ params: Promise.resolve({ wineId: WINE_ID }) }),
  ).rejects.toThrow("NEXT_NOT_FOUND");
});

it("scopes the wine query to the caller's restaurant", async () => {
  // Defence in depth beside RLS: this page is keyed on a UUID straight from the
  // URL, which is exactly where a missing tenant filter leaks a neighbour's wine.
  const { client, filters } = supabaseReturning(WINE, []);
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });

  await WineDetailPage({ params: Promise.resolve({ wineId: WINE_ID }) });

  expect(filters["wines.id"]).toBe(WINE_ID);
  expect(filters["wines.restaurant_id"]).toBe("r-1");
  expect(filters["inventory_items.restaurant_id"]).toBe("r-1");
});

it("sums bottles across inventory lots and lists their distinct locations", async () => {
  const { client } = supabaseReturning(WINE, [
    { quantity: 4, bin_location: "A2", section: null },
    { quantity: 2, bin_location: "A2", section: null },
    { quantity: 3, bin_location: null, section: "Back room" },
    { quantity: null, bin_location: null, section: null },
  ]);
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });

  const element = await WineDetailPage({
    params: Promise.resolve({ wineId: WINE_ID }),
  });

  const props = element.props;
  expect(props.bottleCount).toBe(9);
  expect(props.locations).toEqual(["A2", "Back room"]);
});

it("does not fetch vintage ratings when no reference entry matched", async () => {
  // An unmatched wine is the common case; it must cost one query, not two.
  const { client } = supabaseReturning(WINE, []);
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });

  const element = await WineDetailPage({
    params: Promise.resolve({ wineId: WINE_ID }),
  });

  expect(mocks.fetchVintageRatings).not.toHaveBeenCalled();
  expect(element.props.vintageRatings).toEqual({ status: "ok", value: [] });
});

it("fetches vintage ratings for the matched corpus wine", async () => {
  const { client } = supabaseReturning(WINE, []);
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });
  mocks.resolveXWinesProfile.mockResolvedValue({
    status: "ok",
    value: { wineId: 174177 },
  });
  mocks.fetchVintageRatings.mockResolvedValue({
    status: "ok",
    value: [{ vintage: 2018, ratingAvg: 3.7, ratingCount: 960 }],
  });

  const element = await WineDetailPage({
    params: Promise.resolve({ wineId: WINE_ID }),
  });

  // The bottle's own vintage goes with the request so the ratings window can
  // never drop it.
  expect(mocks.fetchVintageRatings).toHaveBeenCalledWith(expect.anything(), 174177, 2018);
  expect(element.props.vintageRatings.value).toHaveLength(1);
});

it("throws rather than 404s when the wine query itself fails", async () => {
  // maybeSingle() returns null for "no such wine" AND for a database outage.
  // Calling notFound() on the second tells the user their bottle was deleted.
  const { client } = supabaseReturning(null, [], { wine: { message: "57P01" } });
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });

  await expect(
    WineDetailPage({ params: Promise.resolve({ wineId: WINE_ID }) }),
  ).rejects.toMatchObject({ message: "57P01" });
  expect(mocks.notFound).not.toHaveBeenCalled();
});

it("throws rather than reporting an empty cellar when the inventory query fails", async () => {
  // A null inventory reduced to bottleCount 0, which the view renders as
  // "None on hand" — a stock claim invented out of an outage.
  const { client } = supabaseReturning(WINE, [], { inventory: { message: "57P01" } });
  mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });

  await expect(
    WineDetailPage({ params: Promise.resolve({ wineId: WINE_ID }) }),
  ).rejects.toMatchObject({ message: "57P01" });
});
