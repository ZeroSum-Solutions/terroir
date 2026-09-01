// P1 slice 2b — the catalogue detail view (program plan D4: "catalogue rows
// get a detail view; add is one action on it. Until P2 lands, [it] renders
// what the interim contract can honestly show (identity + any linked X-Wines
// features), with unknowns visibly unknown").
//
// What these tests pin: producer-first identity with the reference IDs on
// display; linked X-Wines features rendered in the corpus's own words; the
// no-link and corpus-outage states told apart in different sentences; and
// Add-to-cellar offered exactly when an LWIN identity backs it — an X-Wines
// row with no accepted link says it can't be added yet rather than hiding
// the fact.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acidityAxis,
  bodyAxis,
  type XWinesProfile,
} from "@/lib/wine-intelligence/xwines-profile";
import {
  CatalogueDetailView,
  type CatalogueDetailViewProps,
} from "./catalogue-detail-view";

const ok = <T,>(value: T) => ({ status: "ok", value }) as const;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

const fetchMock = vi.fn();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

async function render(props: CatalogueDetailViewProps) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<CatalogueDetailView {...props} />);
  });
  return container;
}

const IDENTITY: CatalogueDetailViewProps["identity"] = {
  lwinId: "1234567",
  xwinesWineId: 174177,
  name: "Koonunga Hill",
  producer: "Penfolds",
  region: "South Australia",
  country: "Australia",
  colour: "Red",
  type: null,
  varietal: "Shiraz",
};

const PROFILE: XWinesProfile = {
  wineId: 174177,
  matchedName: "Koonunga Hill Shiraz-Cabernet",
  matchedWinery: "Penfolds",
  provenance: "linked",
  matchScore: null,
  type: "Red",
  elaborate: "Assemblage/Blend",
  grapes: ["Syrah/Shiraz", "Cabernet Sauvignon"],
  pairings: ["Beef", "Lamb"],
  abv: 14,
  body: bodyAxis("Very full-bodied"),
  acidity: acidityAxis("High"),
  regionName: "South Australia",
  country: "Australia",
  website: "https://www.penfolds.com",
  vintages: [2018, 2017],
  hasNonVintage: false,
  ratingAvg: 3.639,
  ratingCount: 6666,
  image: null,
};

const ADD_PAYLOAD: CatalogueDetailViewProps["addPayload"] = {
  lwin_id: "1234567",
  display_name: "Penfolds, Koonunga Hill, South Australia",
  producer: "Penfolds",
  region: "South Australia",
  country: "Australia",
};

describe("CatalogueDetailView", () => {
  it("titles the wine producer-first and shows the reference identity", async () => {
    const view = await render({
      identity: IDENTITY,
      profile: ok(null),
      addPayload: ADD_PAYLOAD,
    });
    expect(view.querySelector("h1")?.textContent).toBe("Penfolds Koonunga Hill");
    expect(view.textContent).toContain("LWIN 1234567");
    expect(view.textContent).toContain("X-Wines");
  });

  it("does not repeat the producer when the display name already carries it", async () => {
    const view = await render({
      identity: { ...IDENTITY, name: "Penfolds, Koonunga Hill, South Australia" },
      profile: ok(null),
      addPayload: ADD_PAYLOAD,
    });
    expect(view.querySelector("h1")?.textContent).toBe(
      "Penfolds, Koonunga Hill, South Australia",
    );
  });

  it("renders the linked X-Wines features in the corpus's own words", async () => {
    const view = await render({
      identity: IDENTITY,
      profile: ok(PROFILE),
      addPayload: ADD_PAYLOAD,
    });
    expect(view.textContent).toContain("Very full-bodied");
    expect(view.textContent).toContain("High acidity");
    expect(view.textContent).toContain("Beef");
    expect(view.textContent).toContain("3.6");
    expect(view.textContent).toContain("6,666 ratings");
    expect(view.textContent).toContain("Syrah/Shiraz");
  });

  it("captions a corpus stand-in image so it never reads as this wine's label", async () => {
    const view = await render({
      identity: IDENTITY,
      profile: ok({
        ...PROFILE,
        image: {
          url: "http://127.0.0.1:57321/storage/x.jpg",
          kind: "representative",
          source: "openfoodfacts",
          credit: "Open Food Facts",
        },
      }),
      addPayload: ADD_PAYLOAD,
    });
    expect(view.textContent).toContain("Representative bottle — not this wine's label");
    expect(view.textContent).toContain("Open Food Facts");
  });

  it("says the unknowns are unknown when no X-Wines entry is linked", async () => {
    const view = await render({
      identity: IDENTITY,
      profile: ok(null),
      addPayload: ADD_PAYLOAD,
    });
    expect(view.textContent).toContain("No linked X-Wines entry");
    expect(view.textContent).toContain("unknown");
  });

  it("tells a corpus outage apart from a wine that has no entry", async () => {
    const view = await render({
      identity: IDENTITY,
      profile: { status: "unavailable" },
      addPayload: ADD_PAYLOAD,
    });
    expect(view.textContent).toContain("couldn’t be reached");
    expect(view.textContent).not.toContain("No linked X-Wines entry");
  });

  it("adds the wine to the cellar from the detail page and reports Added", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/api/wines/create-from-lwin");
      const body = JSON.parse(String(init?.body));
      expect(body.lwin_id).toBe("1234567");
      expect(body.display_name).toBe("Penfolds, Koonunga Hill, South Australia");
      return { ok: true, status: 200, json: async () => ({ id: "new-wine" }) } as unknown as Response;
    });
    const view = await render({
      identity: IDENTITY,
      profile: ok(PROFILE),
      addPayload: ADD_PAYLOAD,
    });
    const add = [...view.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Add to cellar"),
    );
    if (!add) throw new Error("add button not rendered");
    await act(async () => {
      add.click();
    });
    expect(view.textContent).toContain("Added");
  });

  it("says an unlinked X-Wines wine can't be added yet instead of hiding it", async () => {
    const view = await render({
      identity: { ...IDENTITY, lwinId: null },
      profile: ok(PROFILE),
      addPayload: null,
    });
    expect(
      [...view.querySelectorAll("button")].some((b) =>
        (b.textContent ?? "").includes("Add to cellar"),
      ),
    ).toBe(false);
    expect(view.textContent).toContain("can’t be added");
  });
});
