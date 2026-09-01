// P1 slice 2b — /catalogue/[source]/[id], the server component behind the
// palette's catalogue rows. What this suite pins:
//
//   - stray URLs 404 cleanly (unknown source, malformed id) without a query;
//   - source=lwin reads the lwin_catalog row, follows the ACCEPTED
//     lwin_xwines_links decision to the corpus profile, and — because 0145
//     reaches production by hand, after this code (AGENTS #7) — a failed
//     links read degrades to "profile unavailable", never a 500;
//   - source=xwines reads the corpus row as the identity itself, and offers
//     Add only when a reverse accepted link recovers an LWIN identity.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  notFound: vi.fn(),
  fetchXWinesProfileById: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/auth-context", () => ({ getAuthContext: mocks.getAuthContext }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("@/lib/wine-intelligence/xwines-profile", () => ({
  fetchXWinesProfileById: mocks.fetchXWinesProfileById,
}));
vi.mock("./catalogue-detail-view", () => ({
  CatalogueDetailView: () => null,
}));

const { default: CatalogueDetailPage } = await import("./page");

const LWIN_ROW = {
  lwin_id: "1234567",
  display_name: "Penfolds, Koonunga Hill, South Australia",
  producer: "Penfolds",
  varietal: "Shiraz",
  region: "South Australia",
  country: "Australia",
  colour: "Red",
  type: "Wine",
};

/**
 * Minimal supabase double: lwin_catalog and lwin_xwines_links, both settled
 * through maybeSingle(). Records per-table filters so a test can assert what
 * was asked for.
 */
function fakeSupabase(options: {
  lwinRow?: typeof LWIN_ROW | null;
  lwinError?: { message: string } | null;
  link?: { lwin_id?: string; xwines_wine_id?: number } | null;
  linkError?: { message: string } | null;
}) {
  const filters: Record<string, unknown> = {};
  function builder(table: string) {
    const self = {
      select: () => self,
      eq: (column: string, value: unknown) => {
        filters[`${table}.${column}`] = value;
        return self;
      },
      maybeSingle: () => {
        if (table === "lwin_catalog") {
          return options.lwinError
            ? Promise.resolve({ data: null, error: options.lwinError })
            : Promise.resolve({ data: options.lwinRow ?? null, error: null });
        }
        return options.linkError
          ? Promise.resolve({ data: null, error: options.linkError })
          : Promise.resolve({ data: options.link ?? null, error: null });
      },
    };
    return self;
  }
  return {
    filters,
    client: { from: vi.fn((table: string) => builder(table)) },
  };
}

function pageProps(source: string, id: string) {
  return { params: Promise.resolve({ source, id }) };
}

/**
 * The page RETURNS the view element rather than rendering it, so its props
 * are read off the element — JSX creates the element without invoking the
 * component function.
 */
function viewProps<T>(element: unknown): T {
  return (element as { props: T }).props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  mocks.fetchXWinesProfileById.mockResolvedValue({ status: "ok", value: null });
});

describe("/catalogue/[source]/[id]", () => {
  it("404s an unknown source without querying", async () => {
    const { client } = fakeSupabase({});
    mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });
    await expect(CatalogueDetailPage(pageProps("vivino", "1234567"))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(client.from).not.toHaveBeenCalled();
  });

  it("404s a malformed LWIN id without querying", async () => {
    const { client } = fakeSupabase({});
    mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });
    await expect(CatalogueDetailPage(pageProps("lwin", "not-a-lwin"))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(client.from).not.toHaveBeenCalled();
  });

  it("404s an LWIN id the catalogue does not hold", async () => {
    const { client } = fakeSupabase({ lwinRow: null });
    mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });
    await expect(CatalogueDetailPage(pageProps("lwin", "1234567"))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("renders an LWIN wine with its accepted link's corpus profile and an add payload", async () => {
    const { client, filters } = fakeSupabase({
      lwinRow: LWIN_ROW,
      link: { xwines_wine_id: 174177 },
    });
    mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });
    mocks.fetchXWinesProfileById.mockResolvedValue({
      status: "ok",
      value: { wineId: 174177 },
    });

    const element = await CatalogueDetailPage(pageProps("lwin", "1234567"));

    expect(filters["lwin_catalog.lwin_id"]).toBe("1234567");
    expect(filters["lwin_xwines_links.lwin_id"]).toBe("1234567");
    expect(filters["lwin_xwines_links.status"]).toBe("accepted");
    expect(mocks.fetchXWinesProfileById).toHaveBeenCalledWith(client, 174177);

    const props = viewProps<{
      identity: { name: string; producer: string | null; lwinId: string | null };
      profile: { status: string };
      addPayload: { lwin_id: string; display_name: string } | null;
    }>(element);
    expect(props.identity.name).toBe("Penfolds, Koonunga Hill, South Australia");
    expect(props.identity.lwinId).toBe("1234567");
    expect(props.profile.status).toBe("ok");
    expect(props.addPayload).toMatchObject({
      lwin_id: "1234567",
      display_name: "Penfolds, Koonunga Hill, South Australia",
    });
  });

  it("skips the corpus read when no accepted link exists", async () => {
    const { client } = fakeSupabase({ lwinRow: LWIN_ROW, link: null });
    mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });

    const element = await CatalogueDetailPage(pageProps("lwin", "1234567"));

    expect(mocks.fetchXWinesProfileById).not.toHaveBeenCalled();
    const props = viewProps<{ profile: { status: string; value: unknown } }>(element);
    expect(props.profile).toEqual({ status: "ok", value: null });
  });

  it("degrades a failed links read to profile-unavailable and reports it — 0145 lands by hand", async () => {
    const { client } = fakeSupabase({
      lwinRow: LWIN_ROW,
      linkError: { message: "relation does not exist" },
    });
    mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });

    const element = await CatalogueDetailPage(pageProps("lwin", "1234567"));

    const props = viewProps<{ profile: { status: string } }>(element);
    expect(props.profile).toEqual({ status: "unavailable" });
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it("404s an X-Wines id the corpus does not hold", async () => {
    const { client } = fakeSupabase({});
    mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });
    mocks.fetchXWinesProfileById.mockResolvedValue({ status: "ok", value: null });
    await expect(CatalogueDetailPage(pageProps("xwines", "174177"))).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("renders an X-Wines wine from its own corpus row and recovers Add through the reverse link", async () => {
    const { client, filters } = fakeSupabase({
      lwinRow: LWIN_ROW,
      link: { lwin_id: "1234567" },
    });
    mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });
    mocks.fetchXWinesProfileById.mockResolvedValue({
      status: "ok",
      value: {
        wineId: 174177,
        matchedName: "Koonunga Hill Shiraz-Cabernet",
        matchedWinery: "Penfolds",
        type: "Red",
        regionName: "South Australia",
        country: "Australia",
      },
    });

    const element = await CatalogueDetailPage(pageProps("xwines", "174177"));

    expect(mocks.fetchXWinesProfileById).toHaveBeenCalledWith(client, 174177);
    expect(filters["lwin_xwines_links.xwines_wine_id"]).toBe(174177);
    const props = viewProps<{
      identity: { name: string; producer: string | null; xwinesWineId: number | null };
      addPayload: { lwin_id: string } | null;
    }>(element);
    expect(props.identity.name).toBe("Koonunga Hill Shiraz-Cabernet");
    expect(props.identity.producer).toBe("Penfolds");
    expect(props.addPayload).toMatchObject({ lwin_id: "1234567" });
  });

  it("offers no add payload for an X-Wines wine with no accepted link — never a provisional add", async () => {
    const { client } = fakeSupabase({ link: null });
    mocks.getAuthContext.mockResolvedValue({ supabase: client, restaurantId: "r-1" });
    mocks.fetchXWinesProfileById.mockResolvedValue({
      status: "ok",
      value: { wineId: 174177, matchedName: "Community Cuvee", matchedWinery: "Crowd Estate" },
    });

    const element = await CatalogueDetailPage(pageProps("xwines", "174177"));

    const props = viewProps<{ addPayload: unknown }>(element);
    expect(props.addPayload).toBeNull();
  });
});
