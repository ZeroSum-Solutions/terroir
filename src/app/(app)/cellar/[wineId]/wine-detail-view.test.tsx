import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { XWinesProfile } from "@/lib/wine-intelligence/xwines-profile";
import { resolveWineFacts } from "@/lib/wine-intelligence/wine-reference-facts";
import { aggregateHouseTaste } from "@/domains/wine-profile/resolve-house-profile";
import {
  selectReferenceProfile,
  type ReferenceNoteRow,
} from "@/domains/wine-profile/resolve-reference-profile";
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
  size_ml: 750,
  colour: "red",
  hero_image_url: null,
  is_eightysixed: false,
  retail_min: null,
  retail_max: null,
  retail_median: null,
  retail_retailer_count: null,
};

/**
 * The reference side, run through the real selection rule rather than
 * hand-built, so these cases keep exercising what the page actually applies.
 */
const referenceFor = (profile: XWinesProfile | null, rows: ReferenceNoteRow[] = []) =>
  selectReferenceProfile({
    wine: {
      canonicalWineId: "cw-1",
      vintage: 2018,
      drinkWindowStart: null,
      drinkWindowEnd: null,
      drinkWindowBasis: null,
      drinkWindowSetBy: null,
      drinkWindowSetAt: null,
    },
    rows,
    profile,
    overrideAuthorName: null,
  });

const NO_NOTES = { ...aggregateHouseTaste([]), notes: [] };
const NO_BADGES = { value: [], basis: { kind: "measured" as const, asOf: "2026-09-03" } };

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
  image: null,
};

const BASE: WineDetailViewProps = {
  wine: WINE,
  bottleCount: 0,
  locations: [],
  // Run through the real resolver rather than hand-built, so these cases keep
  // exercising the precedence the page actually applies. The wine's own values
  // stand in for what the row used to carry directly.
  facts: resolveWineFacts({
    wine: {
      region: "South Australia",
      country: "Australia",
      varietal: "Shiraz Cabernet",
    },
    lwin: null,
    profile: null,
  }),
  profile: ok(null),
  vintageRatings: ok([]),
  house: NO_NOTES,
  reference: referenceFor(null),
  badges: NO_BADGES,
  currentYear: 2026,
};

/** A matched profile and the reference profile derived from it, together. */
const matched = (profile: XWinesProfile): Partial<WineDetailViewProps> => ({
  profile: ok(profile),
  reference: referenceFor(profile),
});

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

  // BUG-01's other half. The same CSV import left 321 production wines — 23%
  // of that cellar — with an EMPTY producer, and `0137` deliberately left them
  // empty rather than guess. Naming that blank left a hole in the sentence:
  // "No reference entry matched  closely enough to trust".
  it("names the bottle instead of a hole when the wine has no producer", async () => {
    const el = await render({ ...BASE, wine: { ...WINE, producer: "" } });
    expect(el.textContent).toContain(
      "No reference entry matched this wine closely enough to trust",
    );
    expect(el.textContent).not.toContain("matched  closely");
    expect(el.textContent).not.toContain("matched closely");
  });

  it("still names the producer when there is one", async () => {
    const el = await render(BASE);
    expect(el.textContent).toContain(
      "No reference entry matched Penfolds closely enough to trust",
    );
  });
});

describe("corpus imagery in the hero", () => {
  // The corpus's picture is only sometimes a picture of this wine (0138), and
  // the hero is the one place a reader will take it as the bottle in front of
  // them. These pin the two things that make that safe: a non-"label" kind is
  // captioned with what it actually is, and the tenant's own photograph is
  // never displaced by one.
  const withImage = (kind: "label" | "producer" | "representative") => ({
    ...PROFILE,
    image: {
      url: "http://127.0.0.1:57321/storage/v1/object/public/wine-images/catalog/x.jpg",
      kind,
      source: "openfoodfacts",
      credit: "Open Food Facts contributors, CC-BY-SA-3.0 (123)",
    },
  });

  it("fills an empty hero with the corpus's picture and credits its source", async () => {
    const el = await render({ ...BASE, profile: ok(withImage("label")) });
    const img = el.querySelector("img");
    expect(img?.getAttribute("src")).toContain("/catalog/x.jpg");
    expect(el.textContent).toContain("Reference label for this wine");
    expect(el.textContent).toContain("CC-BY-SA-3.0");
  });

  it("says a producer shot is not this cuvée, in the caption and the alt text", async () => {
    const el = await render({ ...BASE, profile: ok(withImage("producer")) });
    expect(el.textContent).toContain("A bottle from this producer — not this cuvée");
    expect(el.querySelector("img")?.getAttribute("alt")).toBe(
      "A bottle from this producer — not this cuvée",
    );
  });

  it("never lets a representative bottle pass as this wine's label", async () => {
    const el = await render({ ...BASE, profile: ok(withImage("representative")) });
    expect(el.textContent).toContain("Representative bottle — not this wine's label");
    // The alt text must not name the producer over somebody else's bottle.
    expect(el.querySelector("img")?.getAttribute("alt")).not.toContain("Penfolds");
  });

  it("keeps the tenant's own photograph when they have one", async () => {
    const el = await render({
      ...BASE,
      wine: { ...WINE, hero_image_url: "https://example.test/theirs.jpg" },
      profile: ok(withImage("representative")),
    });
    expect(el.querySelector("img")?.getAttribute("src")).toBe("https://example.test/theirs.jpg");
    expect(el.textContent).not.toContain("Representative bottle");
  });

  it("keeps the placeholder when the corpus has no picture either", async () => {
    const el = await render({ ...BASE, profile: ok(PROFILE) });
    expect(el.textContent).not.toContain("Representative bottle");
    expect(el.textContent).not.toContain("Reference label");
  });
});

describe("with a reference match", () => {
  it("renders both taste axes with the corpus's own wording", async () => {
    const el = await render({ ...BASE, ...matched(PROFILE) });
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
    const el = await render({ ...BASE, ...matched({ ...PROFILE, acidity: null }) });
    expect(el.textContent).toContain("Very full-bodied");
    expect(el.querySelectorAll('[role="img"]')).toHaveLength(1);
  });

  it("drops the taste section entirely when neither axis is known", async () => {
    const el = await render({ ...BASE, ...matched({ ...PROFILE, body: null, acidity: null }) });
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

describe("what the page refuses to render", () => {
  it("renders every number with a basis sentence, and no bare score", async () => {
    // The old page printed `rating_source · rating` as a byline — on a
    // claude_inference wine, the fabrication's own name under its number. The
    // row's rating columns are no longer even in the view's type; a score
    // reaches the page only through a resolver, with its basis.
    const house = {
      ...aggregateHouseTaste([
        { id: "n1", body: "", score: 90, tastedOn: null, createdAt: "2026-09-01", attributed: true, authorName: "Devin", descriptors: [] },
        { id: "n2", body: "", score: 86, tastedOn: null, createdAt: "2026-09-01", attributed: true, authorName: "Sam", descriptors: [] },
      ]),
      notes: [],
    };
    const el = await render({ ...BASE, house });
    expect(el.textContent).toMatch(/88\s*\/\s*100/);
    expect(el.textContent).toMatch(/across 2 house notes/i);
  });

  it("shows a published note under its source, never as the house's words", async () => {
    const el = await render({
      ...BASE,
      reference: referenceFor(null, [
        {
          vintage: 2018,
          source_kind: "producer",
          source_name: "Penfolds sheet",
          source_url: "https://example.test/sheet",
          fetched_at: "2026-08-14T00:00:00.000Z",
          body: "Dense and brooding.",
          score: null,
          score_scale: null,
          drink_window_start: null,
          drink_window_end: null,
        },
      ]),
    });
    expect(el.textContent).toContain("Dense and brooding.");
    expect(el.querySelector("blockquote footer")?.textContent).toMatch(/Penfolds sheet/);
    expect(el.querySelector("blockquote footer")?.textContent).toMatch(/14 August 2026/);
  });

  it("draws no drink window when none has a basis", async () => {
    const el = await render(BASE);
    expect(headings(el)).not.toContain("Drink window");
    expect(el.querySelector('[data-testid="drink-window-block"]')).toBeNull();
  });

  it("draws the window when a source states it, and says which source", async () => {
    const el = await render({
      ...BASE,
      reference: referenceFor(null, [
        {
          vintage: 2018,
          source_kind: "producer",
          source_name: "Penfolds sheet",
          source_url: "https://example.test/sheet",
          fetched_at: "2026-08-14T00:00:00.000Z",
          body: null,
          score: null,
          score_scale: null,
          drink_window_start: 2022,
          drink_window_end: 2030,
        },
      ]),
    });
    expect(headings(el)).toContain("Drink window");
    expect(el.textContent).toMatch(/2022–2030/);
    expect(el.textContent).toMatch(/Penfolds sheet/);
  });

  it("renders the badges that fired with their records basis", async () => {
    const el = await render({
      ...BASE,
      badges: {
        value: [{ kind: "last_bottle", label: "Last bottle", rule: "One left on hand." }],
        basis: { kind: "measured", asOf: "2026-09-03" },
      },
    });
    expect(el.textContent).toContain("Last bottle");
    expect(el.textContent).toMatch(/your own records/i);
  });
});
