import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WineDetailView, type WineDetailViewProps } from "./wine-detail-view";

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

const PROFILE: WineDetailViewProps["profile"] = {
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
  profile: null,
  vintageRatings: [],
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
    const el = await render({ ...BASE, profile: PROFILE });
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
      profile: { ...PROFILE, acidity: null },
    });
    expect(el.textContent).toContain("Very full-bodied");
    expect(el.querySelectorAll('[role="img"]')).toHaveLength(1);
  });

  it("drops the taste section entirely when neither axis is known", async () => {
    const el = await render({
      ...BASE,
      profile: { ...PROFILE, body: null, acidity: null },
    });
    expect(headings(el)).not.toContain("What does this wine taste like?");
  });

  it("renders each food pairing once", async () => {
    const el = await render({ ...BASE, profile: PROFILE });
    expect(el.textContent).toContain("Beef");
    expect(el.textContent).toContain("Lamb");
  });

  it("shows the community rating with its sample size", async () => {
    const el = await render({ ...BASE, profile: PROFILE });
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
    const el = await render({ ...BASE, profile: PROFILE, vintageRatings: ratings });
    const marked = [...el.querySelectorAll("tbody th")].find((row) =>
      row.textContent?.includes("Yours"),
    );
    expect(marked?.textContent).toContain("2018");
  });

  it("hides the table when there is only one vintage to compare", async () => {
    const el = await render({
      ...BASE,
      profile: PROFILE,
      vintageRatings: [ratings[0]],
    });
    expect(headings(el)).not.toContain("Compare vintages");
  });
});
