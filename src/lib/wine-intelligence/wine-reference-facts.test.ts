import { describe, expect, it, vi } from "vitest";
import { resolveWineFacts, fetchLwinReference } from "./wine-reference-facts";
import type { XWinesProfile } from "./xwines-profile";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const profile = (over: Partial<XWinesProfile> = {}) =>
  ({
    wineId: 1,
    matchedName: "x",
    matchedWinery: "y",
    provenance: "matched",
    matchScore: 0.9,
    image: null,
    type: null,
    elaborate: null,
    grapes: [],
    pairings: [],
    abv: null,
    body: null,
    acidity: null,
    regionName: null,
    country: null,
    ...over,
  }) as unknown as XWinesProfile;

const wine = (over = {}) => ({ region: null, country: null, varietal: null, ...over });

describe("resolveWineFacts — precedence", () => {
  it("never overrides what the restaurant itself recorded", () => {
    const out = resolveWineFacts({
      wine: wine({ region: "Barossa", country: "Australia" }),
      lwin: { producer: null, region: "Rioja", country: "Spain", varietal: null },
      profile: profile({ regionName: "Chianti", country: "Italy" }),
    });
    expect(out).toMatchObject({ region: "Barossa", country: "Australia" });
    expect(out.source).toMatchObject({ region: "wine", country: "wine" });
  });

  it("prefers LWIN over the corpus, because LWIN is an identity match", () => {
    const out = resolveWineFacts({
      wine: wine(),
      lwin: { producer: null, region: "Rioja", country: "Spain", varietal: null },
      profile: profile({ regionName: "Chianti", country: "Italy" }),
    });
    expect(out).toMatchObject({ region: "Rioja", country: "Spain" });
    expect(out.source.region).toBe("lwin");
  });

  it("falls through to the corpus when LWIN has nothing", () => {
    const out = resolveWineFacts({
      wine: wine(),
      lwin: null,
      profile: profile({ regionName: "Chianti", country: "Italy" }),
    });
    expect(out).toMatchObject({ region: "Chianti", country: "Italy" });
    expect(out.source.country).toBe("corpus");
  });

  it("treats an empty string in the row as blank, not as an answer", () => {
    // The CSV importer writes '' rather than NULL into NOT NULL columns, which
    // is why 321 production wines have a producer that is neither set nor null.
    const out = resolveWineFacts({
      wine: wine({ region: "   " }),
      lwin: { producer: null, region: "Rioja", country: null, varietal: null },
      profile: null,
    });
    expect(out.region).toBe("Rioja");
  });

  it("reports null rather than inventing a fact nobody holds", () => {
    const out = resolveWineFacts({ wine: wine(), lwin: null, profile: null });
    expect(out).toMatchObject({ region: null, country: null, varietal: null });
    expect(out.source).toMatchObject({ region: null, country: null, varietal: null });
  });
});

describe("resolveWineFacts — varietal from the corpus", () => {
  it("uses a corpus grape only when the corpus names exactly one", () => {
    const one = resolveWineFacts({
      wine: wine(),
      lwin: null,
      profile: profile({ grapes: ["Nebbiolo"] }),
    });
    expect(one.varietal).toBe("Nebbiolo");
  });

  it("survives a profile that arrived without a grapes array at all", () => {
    const out = resolveWineFacts({
      wine: wine(),
      lwin: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      profile: { regionName: "Rioja", country: "Spain" } as any,
    });
    expect(out).toMatchObject({ region: "Rioja", varietal: null });
  });

  it("declines to pick a grape out of a blend", () => {
    const blend = resolveWineFacts({
      wine: wine(),
      lwin: null,
      profile: profile({ grapes: ["Cabernet Sauvignon", "Merlot"] }),
    });
    expect(blend.varietal).toBeNull();
  });
});

describe("fetchLwinReference", () => {
  const client = (payload: unknown) =>
    ({
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve(payload) }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  it("does not query at all for a wine with no lwin_id", async () => {
    const from = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await fetchLwinReference({ from } as any, null)).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it("treats an unselected column as absent rather than throwing", async () => {
    // A caller that never selected lwin_id arrives with undefined. Reading
    // .trim() off it took the whole wine page down with a TypeError.
    const from = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await fetchLwinReference({ from } as any, undefined)).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it("degrades to null rather than throwing the page away", async () => {
    // The wine, its inventory and its corpus profile are all still worth
    // rendering without a region.
    const read = await fetchLwinReference(client({ data: null, error: { message: "boom" } }), "1234567");
    expect(read).toBeNull();
  });

  it("returns the reference row when there is one", async () => {
    const row = { producer: "CVNE", region: "Rioja", country: "Spain", varietal: "Tempranillo" };
    expect(await fetchLwinReference(client({ data: row, error: null }), "1234567")).toEqual(row);
  });
});
