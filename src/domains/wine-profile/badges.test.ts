import { describe, expect, it } from "vitest";
import { computeBadges, type BadgeInput } from "./badges";

const kinds = (input: BadgeInput) => computeBadges(input).map((b) => b.kind);

const base: BadgeInput = {
  asOf: "2026-09-03",
  window: null,
  windowBasis: null,
  sellingFormatUnits: 6,
  otherFormatUnits: 0,
  lastPutAwayAt: "2026-08-01",
  lastDepletionAt: "2026-08-20",
  deadStockDays: 90,
  publishedBottlePrice: 90,
  weightedUnitCost: 40,
  listedAndOrderable: true,
};

const daysAgo = (n: number) =>
  new Date(Date.UTC(2026, 8, 3) - n * 86_400_000).toISOString().slice(0, 10);

describe("drink now", () => {
  it("does not fire merely for being inside a wide window", () => {
    // 2026 sits inside 2024-2039, but the wine is nowhere near its close.
    // "In window" is not "drink now" -- that conflation is what makes a badge
    // row worthless.
    expect(
      kinds({ ...base, window: { start: 2024, end: 2039 }, windowBasis: "sourced" }),
    ).not.toContain("drink_now");
  });

  it("fires inside the last two years of the window", () => {
    expect(
      kinds({ ...base, window: { start: 2024, end: 2027 }, windowBasis: "sourced" }),
    ).toContain("drink_now");
  });

  it("fires on a house override as readily as on a source", () => {
    expect(
      kinds({ ...base, window: { start: 2024, end: 2027 }, windowBasis: "override" }),
    ).toContain("drink_now");
  });

  it("never fires on an unsourced window", () => {
    // An inferred window is exactly what the retirement removes. Telling staff
    // to drink a bottle on the strength of a guess is the defect, not the
    // feature.
    expect(
      kinds({ ...base, window: { start: 2024, end: 2027 }, windowBasis: "inferred" }),
    ).not.toContain("drink_now");
  });

  it("never fires without a window at all", () => {
    expect(kinds({ ...base, window: null, windowBasis: null })).not.toContain("drink_now");
  });

  it("does not fire once the window has closed", () => {
    expect(
      kinds({ ...base, window: { start: 2010, end: 2020 }, windowBasis: "sourced" }),
    ).not.toContain("drink_now");
  });
});

describe("last bottle", () => {
  it("counts the selling format only", () => {
    // One 750 left and four magnums is still the last bottle of the thing on
    // the list.
    expect(kinds({ ...base, sellingFormatUnits: 1, otherFormatUnits: 4 })).toContain("last_bottle");
  });

  it("does not fire on two", () => {
    expect(kinds({ ...base, sellingFormatUnits: 2 })).not.toContain("last_bottle");
  });

  it("does not fire on none", () => {
    // Nothing on hand is not "last bottle" -- it is off the list entirely.
    expect(kinds({ ...base, sellingFormatUnits: 0 })).not.toContain("last_bottle");
  });
});

describe("slow mover", () => {
  it("does not call newly received stock slow", () => {
    // Received on Monday is not dead on Tuesday. A sliding window measured
    // from "no pour rows" fires on everything just put away.
    expect(
      kinds({ ...base, lastPutAwayAt: daysAgo(2), lastDepletionAt: null, deadStockDays: 90 }),
    ).not.toContain("slow_mover");
  });

  it("fires when nothing has depleted since it was put away long ago", () => {
    expect(
      kinds({ ...base, lastPutAwayAt: daysAgo(200), lastDepletionAt: null, deadStockDays: 90 }),
    ).toContain("slow_mover");
  });

  it("is cleared by a real depletion", () => {
    expect(
      kinds({ ...base, lastPutAwayAt: daysAgo(200), lastDepletionAt: daysAgo(10), deadStockDays: 90 }),
    ).not.toContain("slow_mover");
  });

  it("is not cleared by a depletion older than the threshold", () => {
    expect(
      kinds({ ...base, lastPutAwayAt: daysAgo(400), lastDepletionAt: daysAgo(200), deadStockDays: 90 }),
    ).toContain("slow_mover");
  });

  it("measures the days to the date it is given, not to a fixed day of the year", () => {
    // daysBetween once measured to 3 September of `year` regardless of the
    // real date, so in December a bottle put away in September read as two
    // days old. The badge input carries the actual date instead.
    expect(
      kinds({ ...base, asOf: "2026-12-15", lastPutAwayAt: "2026-09-01", lastDepletionAt: null, deadStockDays: 90 }),
    ).toContain("slow_mover");
  });

  it("says nothing about a wine with no stock", () => {
    expect(
      kinds({ ...base, sellingFormatUnits: 0, otherFormatUnits: 0, lastPutAwayAt: daysAgo(400), lastDepletionAt: null }),
    ).not.toContain("slow_mover");
  });
});

describe("below cost", () => {
  it("fires when the published price is under the weighted cost", () => {
    expect(kinds({ ...base, publishedBottlePrice: 35, weightedUnitCost: 40 })).toContain("below_cost");
  });

  it("names its cost basis in the rule, so the number is predictable", () => {
    const badge = computeBadges({ ...base, publishedBottlePrice: 35, weightedUnitCost: 40 })
      .find((b) => b.kind === "below_cost");
    expect(badge!.rule).toMatch(/weighted average/i);
    expect(badge!.rule).toMatch(/40/);
  });

  it("ignores an unpriced list row rather than reading it as zero", () => {
    // "Price on request" and "not priced yet" are not "priced at nothing".
    expect(kinds({ ...base, publishedBottlePrice: null, weightedUnitCost: 40 })).not.toContain("below_cost");
  });

  it("ignores a zero price for the same reason", () => {
    expect(kinds({ ...base, publishedBottlePrice: 0, weightedUnitCost: 40 })).not.toContain("below_cost");
  });

  it("says nothing when cost is unknown", () => {
    // A missing cost must not read as a healthy margin.
    expect(kinds({ ...base, publishedBottlePrice: 35, weightedUnitCost: null })).not.toContain("below_cost");
  });

  it("does not fire at exactly cost", () => {
    expect(kinds({ ...base, publishedBottlePrice: 40, weightedUnitCost: 40 })).not.toContain("below_cost");
  });
});

describe("off list", () => {
  it("fires when stock exists but nothing orderable lists it", () => {
    expect(kinds({ ...base, listedAndOrderable: false })).toContain("off_list");
  });

  it("does not fire when there is no stock to sell", () => {
    expect(
      kinds({ ...base, sellingFormatUnits: 0, otherFormatUnits: 0, listedAndOrderable: false }),
    ).not.toContain("off_list");
  });

  it("does not fire when the wine is listed and orderable", () => {
    expect(kinds({ ...base, listedAndOrderable: true })).not.toContain("off_list");
  });
});

describe("the badge set as a whole", () => {
  it("raises nothing for an ordinary healthy wine", () => {
    expect(kinds(base)).toEqual([]);
  });

  it("has no mis-binned badge", () => {
    // Dropped deliberately: a wine in the well and the reserve cage is normal,
    // and bin_location drifting from bins.code is a data-quality matter rather
    // than a warning about this bottle. See D14 in the design spec.
    const everyKind = computeBadges({
      ...base, sellingFormatUnits: 1, listedAndOrderable: false,
      publishedBottlePrice: 10, weightedUnitCost: 40,
      window: { start: 2024, end: 2027 }, windowBasis: "sourced",
      lastPutAwayAt: daysAgo(400), lastDepletionAt: null,
    }).map((b) => b.kind);
    expect(everyKind).not.toContain("mis_binned");
  });

  it("gives every badge a rule sentence a buyer can act on", () => {
    const badges = computeBadges({
      ...base, sellingFormatUnits: 1, listedAndOrderable: false,
      publishedBottlePrice: 10, weightedUnitCost: 40,
      window: { start: 2024, end: 2027 }, windowBasis: "sourced",
      lastPutAwayAt: daysAgo(400), lastDepletionAt: null,
    });
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      // A sentence, not a character count. "One left on hand." is a perfectly
      // good rule and an arbitrary length floor would reject it.
      expect(badge.rule.trim().split(/\s+/).length).toBeGreaterThanOrEqual(4);
      expect(badge.rule).toMatch(/\.$/);
      expect(badge.label).not.toBe(badge.rule);
    }
  });
});
