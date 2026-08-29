import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { XWinesProfile } from "@/lib/wine-intelligence/xwines-profile";
import { WineDetailView, type WineDetailViewProps } from "./wine-detail-view";

/** A corpus read that succeeded. The failed one is spelled out where used. */
const ok = <T,>(value: T) => ({ status: "ok", value }) as const;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(props: WineDetailViewProps) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<WineDetailView {...props} />);
  });
  return container;
}

const WINE: WineDetailViewProps["wine"] = {
  id: "w-1",
  name: "Koonunga Hill Shiraz-Cabernet",
  producer: "Penfolds",
  vintage: 2018,
  varietal: "Shiraz Cabernet",
  region: "South Australia",
  country: "Australia",
  size_ml: 750,
  colour: "red",
  hero_image_url: null,
  tasting_notes: null,
  is_eightysixed: false,
  retail_min: null,
  retail_max: null,
  retail_median: null,
  retail_retailer_count: null,
  rating: null,
  rating_source: null,
  review_excerpt: null,
};

const PROFILE: XWinesProfile = {
  wineId: 174177,
  matchedName: "Koonunga Hill Shiraz-Cabernet",
  matchedWinery: "Penfolds",
  provenance: "matched",
  matchScore: 1,
  type: "Red",
  elaborate: "Assemblage/Blend",
  grapes: ["Syrah/Shiraz", "Cabernet Sauvignon"],
  pairings: ["Beef", "Lamb"],
  abv: 14,
  body: { low: "Light", high: "Bold", position: 0.95, label: "Very full-bodied" },
  acidity: { low: "Soft", high: "Acidic", position: 0.85, label: "High acidity" },
  regionName: "South Australia",
  country: "Australia",
  website: "https://www.penfolds.com",
  vintages: [2018],
  hasNonVintage: false,
  ratingAvg: 3.639,
  ratingCount: 6666,
};

const BASE: WineDetailViewProps = {
  wine: WINE,
  bottleCount: 0,
  locations: [],
  profile: ok(null),
  vintageRatings: ok([]),
};

const headings = (el: HTMLElement) =>
  [...el.querySelectorAll("h2")].map((h) => h.textContent);

describe("without a reference match", () => {
  it("says so plainly instead of rendering empty sections", async () => {
    const el = await render(BASE);
    expect(el.textContent).toContain("No reference entry matched Penfolds");
    expect(headings(el)).not.toContain("What does this wine taste like?");
    expect(headings(el)).not.toContain("Food that goes well with this wine");
  });

  it("still renders the wine's own identity and cellar facts", async () => {
    const el = await render({ ...BASE, bottleCount: 6, locations: ["A2"] });
    expect(el.querySelector("h1")?.textContent).toBe("Koonunga Hill Shiraz-Cabernet");
    expect(el.textContent).toContain("6 on hand");
    expect(headings(el)).toContain("In your cellar");
  });
});

describe("with a reference match", () => {
  it("renders both taste axes with the corpus's own wording", async () => {
    const el = await render({ ...BASE, profile: ok(PROFILE) });
    expect(el.textContent).toContain("Very full-bodied");
    expect(el.textContent).toContain("High acidity");
    const bars = [...el.querySelectorAll('[role="img"]')].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(bars).toEqual([
      "Very full-bodied, between Light and Bold",
      "High acidity, between Soft and Acidic",
    ]);
  });

  it("omits an axis the corpus has no value for", async () => {
    const el = await render({
      ...BASE,
      profile: ok({ ...PROFILE, acidity: null }),
    });
    expect(el.textContent).toContain("Very full-bodied");
    expect(el.querySelectorAll('[role="img"]')).toHaveLength(1);
  });

  it("drops the taste section entirely when neither axis is known", async () => {
    const el = await render({
      ...BASE,
      profile: ok({ ...PROFILE, body: null, acidity: null }),
    });
    expect(headings(el)).not.toContain("What does this wine taste like?");
  });

  it("renders each food pairing once", async () => {
    const el = await render({ ...BASE, profile: ok(PROFILE) });
    expect(el.textContent).toContain("Beef");
    expect(el.textContent).toContain("Lamb");
  });

  it("shows the community rating with its sample size", async () => {
    const el = await render({ ...BASE, profile: ok(PROFILE) });
    // The count is never omitted: 3.6 from 6,666 ratings and 3.6 from 3 are
    // not the same claim.
    expect(el.textContent).toContain("3.6");
    expect(el.textContent).toContain("from 6,666 ratings");
  });
});

describe("compare vintages", () => {
  const ratings = [
    { vintage: 2019, ratingAvg: 3.7, ratingCount: 335 },
    { vintage: 2018, ratingAvg: 3.7, ratingCount: 960 },
  ];

  it("marks the vintage this bottle actually is", async () => {
    const el = await render({
      ...BASE,
      profile: ok(PROFILE),
      vintageRatings: ok(ratings),
    });
    const marked = [...el.querySelectorAll("tbody th")].find((row) =>
      row.textContent?.includes("Yours"),
    );
    expect(marked?.textContent).toContain("2018");
  });

  it("hides the table when there is only one vintage to compare", async () => {
    const el = await render({
      ...BASE,
      profile: ok(PROFILE),
      vintageRatings: ok([ratings[0]]),
    });
    expect(headings(el)).not.toContain("Compare vintages");
  });
});

describe("when the corpus could not be read", () => {
  it("does not claim the wine is absent from the reference", async () => {
    const el = await render({ ...BASE, profile: { status: "unavailable" } });
    expect(el.textContent).toContain("reference corpus couldn\u2019t be reached");
    expect(el.textContent).not.toContain("No reference entry matched");
  });

  it("says why the vintage table is missing rather than showing nothing", async () => {
    const el = await render({
      ...BASE,
      profile: ok(PROFILE),
      vintageRatings: { status: "unavailable" },
    });
    expect(headings(el)).toContain("Compare vintages");
    expect(el.textContent).toContain("Per-vintage ratings couldn\u2019t be read");
    expect(el.querySelector("tbody")).toBeNull();
  });
});

describe("tasting note attribution", () => {
  const CRITIC = { rating: 95, rating_source: "Wine Advocate" };

  it("attributes a critic's excerpt to the critic", async () => {
    const el = await render({
      ...BASE,
      wine: { ...WINE, ...CRITIC, review_excerpt: "Dense and brooding." },
    });
    expect(el.textContent).toContain("Dense and brooding.");
    expect(el.querySelector("blockquote footer")?.textContent).toBe("Wine Advocate · 95");
  });

  it("never signs an in-house note with the critic's byline", async () => {
    // The bug: tasting_notes won the text, but rating_source was appended
    // regardless — putting the sommelier's words in Wine Advocate's mouth.
    const el = await render({
      ...BASE,
      wine: {
        ...WINE,
        ...CRITIC,
        tasting_notes: "Our own note.",
        review_excerpt: "Dense and brooding.",
      },
    });
    expect(el.textContent).toContain("Our own note.");
    expect(el.querySelector("blockquote footer")).toBeNull();
    expect(el.textContent).not.toContain("Wine Advocate");
  });

  it("falls through an empty tasting note to a real excerpt", async () => {
    // `??` kept "" and rendered a blank quote; the display condition used `||`
    // and disagreed with it.
    const el = await render({
      ...BASE,
      wine: {
        ...WINE,
        ...CRITIC,
        tasting_notes: "   ",
        review_excerpt: "Dense and brooding.",
      },
    });
    expect(el.querySelector("blockquote p")?.textContent).toBe("Dense and brooding.");
    expect(el.querySelector("blockquote footer")?.textContent).toBe("Wine Advocate · 95");
  });

  it("renders no tasting-note section when neither text exists", async () => {
    const el = await render({ ...BASE, wine: { ...WINE, ...CRITIC } });
    expect(headings(el)).not.toContain("Tasting note");
  });
});
