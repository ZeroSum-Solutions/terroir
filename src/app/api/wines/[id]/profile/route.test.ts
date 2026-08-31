import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse, type NextRequest } from "next/server";
import type { CorpusRead, XWinesProfile } from "@/lib/wine-intelligence/xwines-profile";

const mockRequireMembership = vi.fn();
vi.mock("@/lib/api/auth", () => ({
  requireMembership: () => mockRequireMembership(),
}));

const mockResolve = vi.fn();
vi.mock("@/lib/wine-intelligence/wine-corpus-profile", () => ({
  resolveWineCorpusProfile: (...args: unknown[]) => mockResolve(...args),
}));

const { GET } = await import("./route");

const WINE_ID = "11111111-1111-4111-8111-111111111111";
const RESTAURANT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_RESTAURANT_ID = "33333333-3333-4333-8333-333333333333";

type WineRow = { id: string; restaurant_id: string; name: string; producer: string };

function makeSupabase(options: { wines: WineRow[]; fail?: boolean }) {
  const filters: Record<string, string> = {};
  const supabase = {
    from: () => {
      const self = {
        select: () => self,
        eq: (column: string, value: string) => {
          filters[column] = value;
          return self;
        },
        maybeSingle: async () => {
          if (options.fail) return { data: null, error: { message: "boom" } };
          const match = options.wines.find(
            (wine) =>
              wine.id === filters.id && wine.restaurant_id === filters.restaurant_id,
          );
          return { data: match ?? null, error: null };
        },
      };
      return self;
    },
  };
  return { supabase, filters };
}

const request = {} as NextRequest;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function ok(value: XWinesProfile | null): CorpusRead<XWinesProfile | null> {
  return { status: "ok", value };
}

const PROFILE: XWinesProfile = {
  wineId: 119230,
  matchedName: "Vosne-Romanee",
  matchedWinery: "Benjamin Leroux",
  provenance: "producer-matched",
  matchScore: 0.75,
  type: null,
  elaborate: null,
  grapes: [],
  pairings: [],
  abv: null,
  body: null,
  acidity: null,
  regionName: null,
  country: null,
  website: null,
  vintages: [],
  hasNonVintage: false,
  ratingAvg: null,
  ratingCount: 0,
  image: {
    url: "http://127.0.0.1:57321/storage/v1/object/public/wine-images/xwines/119230.jpeg",
    kind: "producer",
    source: "xwines",
    credit: null,
  },
};

beforeEach(() => {
  mockRequireMembership.mockReset();
  mockResolve.mockReset();
});

describe("GET /api/wines/[id]/profile", () => {
  it("returns the corpus image and the attributes for a wine in this restaurant", async () => {
    const { supabase } = makeSupabase({
      wines: [
        { id: WINE_ID, restaurant_id: RESTAURANT_ID, name: "Benjamin Leroux Vosne-Romanée", producer: "" },
      ],
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: RESTAURANT_ID,
      role: "staff",
    });
    mockResolve.mockResolvedValue(ok(PROFILE));

    const response = await GET(request, params(WINE_ID));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.wineId).toBe(WINE_ID);
    expect(body.available).toBe(true);
    expect(body.profile.image).toEqual(PROFILE.image);
    expect(body.profile.provenance).toBe("producer-matched");
    // The kind travels with the url. A client that renders one without the
    // other cannot caption the picture, and an uncaptioned corpus picture is
    // a stranger's bottle under this wine's name.
    expect(body.profile.image.kind).toBe("producer");
    // A producer-level match carries no taste claim, and the envelope must not
    // invent one on the way out.
    expect(body.profile.body).toBeNull();
    expect(body.profile.grapes).toEqual([]);
  });

  it("passes only the session's own restaurant into the scope filter", async () => {
    const { supabase, filters } = makeSupabase({
      wines: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, name: "W", producer: "P" }],
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: RESTAURANT_ID,
      role: "owner",
    });
    mockResolve.mockResolvedValue(ok(null));

    await GET(request, params(WINE_ID));
    expect(filters).toEqual({ id: WINE_ID, restaurant_id: RESTAURANT_ID });
  });

  it("404s a wine belonging to another restaurant rather than reading it", async () => {
    const { supabase } = makeSupabase({
      wines: [{ id: WINE_ID, restaurant_id: OTHER_RESTAURANT_ID, name: "W", producer: "P" }],
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: RESTAURANT_ID,
      role: "owner",
    });

    const response = await GET(request, params(WINE_ID));
    expect(response.status).toBe(404);
    // The neighbouring tenant's wine is never handed to the resolver at all.
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("rejects an id that is not a uuid before it reaches Postgres", async () => {
    const { supabase } = makeSupabase({ wines: [] });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: RESTAURANT_ID,
      role: "owner",
    });

    const response = await GET(request, params("not-a-uuid"));
    expect(response.status).toBe(400);
  });

  it("passes an auth failure straight back", async () => {
    mockRequireMembership.mockResolvedValue(
      NextResponse.json({ error: { code: "unauthorized" } }, { status: 401 }),
    );
    const response = await GET(request, params(WINE_ID));
    expect(response.status).toBe(401);
  });

  it("says the corpus was unreadable rather than claiming there is no entry", async () => {
    const { supabase } = makeSupabase({
      wines: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, name: "W", producer: "P" }],
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: RESTAURANT_ID,
      role: "owner",
    });
    mockResolve.mockResolvedValue({ status: "unavailable" });

    const response = await GET(request, params(WINE_ID));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ wineId: WINE_ID, available: false, profile: null });
  });

  it("reports no corpus entry as a null profile, not an error", async () => {
    const { supabase } = makeSupabase({
      wines: [{ id: WINE_ID, restaurant_id: RESTAURANT_ID, name: "W", producer: "P" }],
    });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: RESTAURANT_ID,
      role: "owner",
    });
    mockResolve.mockResolvedValue(ok(null));

    const response = await GET(request, params(WINE_ID));
    const body = await response.json();
    expect(body).toEqual({ wineId: WINE_ID, available: true, profile: null });
  });

  it("500s a failed lookup instead of reporting the wine as deleted", async () => {
    const { supabase } = makeSupabase({ wines: [], fail: true });
    mockRequireMembership.mockResolvedValue({
      supabase,
      restaurantId: RESTAURANT_ID,
      role: "owner",
    });

    const response = await GET(request, params(WINE_ID));
    expect(response.status).toBe(500);
  });
});
