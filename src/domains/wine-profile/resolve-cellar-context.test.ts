// The cellar resolver's derivations, tested without a database.
//
// Each rule here is a boundary the badge audit named (spec §4.4): selling
// format versus other formats, weighted cost over non-zero lots, the
// PUBLISHED price only. A wrong derivation upstream makes computeBadges lie
// with perfect fidelity.
import { describe, expect, it } from "vitest";
import {
  composeBadges,
  deriveCellarFacts,
  isSellingFormat,
  type CellarFacts,
  type InventoryRow,
  type ListRow,
} from "./resolve-cellar-context";

const lot = (overrides: Partial<InventoryRow> = {}): InventoryRow => ({
  quantity: 6,
  unit_cost: 40,
  added_at: "2026-08-01T10:00:00.000Z",
  bin_location: "A2",
  section: null,
  format: "750ml",
  ...overrides,
});

const listed = (overrides: Partial<ListRow> = {}): ListRow => ({
  bottle_price: 90,
  hidden: false,
  is_available: true,
  wine_list_sections: { wine_lists: { is_published: true, archived: false } },
  ...overrides,
});

const derive = (input: Partial<Parameters<typeof deriveCellarFacts>[0]> = {}) =>
  deriveCellarFacts({
    inventory: [lot()],
    lastDepletionAt: null,
    lists: [listed()],
    deadStockDays: 90,
    sizeMl: 750,
    ...input,
  });

describe("selling format", () => {
  it("treats a lot with no recorded format as the selling format", () => {
    // Most lots predate the format column. Counting them as "other" would
    // make Last bottle fire on a cellar with a case on hand.
    expect(isSellingFormat(null, 750)).toBe(true);
  });

  it("matches a millilitre format to the wine's own size", () => {
    expect(isSellingFormat("750ml", 750)).toBe(true);
    expect(isSellingFormat("1500ml", 750)).toBe(false);
  });

  it("treats named formats as other formats", () => {
    expect(isSellingFormat("magnum", 750)).toBe(false);
    expect(isSellingFormat("half", 750)).toBe(false);
  });

  it("counts selling-format units apart from magnums and halves", () => {
    const facts = derive({
      inventory: [lot({ quantity: 1 }), lot({ quantity: 4, format: "magnum" }), lot({ quantity: 2, format: "half" })],
    });
    expect(facts.sellingFormatUnits).toBe(1);
    expect(facts.otherFormatUnits).toBe(6);
    expect(facts.bottleCount).toBe(7);
  });
});

describe("cost basis", () => {
  it("weights unit cost by quantity across lots", () => {
    const facts = derive({ inventory: [lot({ quantity: 1, unit_cost: 100 }), lot({ quantity: 3, unit_cost: 20 })] });
    expect(facts.weightedUnitCost).toBe(40);
  });

  it("ignores zero-quantity lots and zero costs", () => {
    // An emptied lot's cost is history, and a zero cost is "unknown", not free.
    const facts = derive({
      inventory: [lot({ quantity: 0, unit_cost: 500 }), lot({ quantity: 2, unit_cost: 0 }), lot({ quantity: 2, unit_cost: 30 })],
    });
    expect(facts.weightedUnitCost).toBe(30);
  });

  it("is null rather than zero when no lot carries a cost", () => {
    const facts = derive({ inventory: [lot({ unit_cost: 0 })] });
    expect(facts.weightedUnitCost).toBeNull();
  });
});

describe("the published price", () => {
  it("reads only rows a guest can order from", () => {
    const facts = derive({
      lists: [
        listed({ bottle_price: 20, hidden: true }),
        listed({ bottle_price: 25, is_available: false }),
        listed({ bottle_price: 30, wine_list_sections: { wine_lists: { is_published: false, archived: false } } }),
        listed({ bottle_price: 35, wine_list_sections: { wine_lists: { is_published: true, archived: true } } }),
        listed({ bottle_price: 90 }),
      ],
    });
    expect(facts.publishedBottlePrice).toBe(90);
    expect(facts.listedAndOrderable).toBe(true);
  });

  it("takes the lowest of several published prices", () => {
    // If the wine is below cost on any list a guest can see, it is below cost.
    const facts = derive({ lists: [listed({ bottle_price: 90 }), listed({ bottle_price: 60 })] });
    expect(facts.publishedBottlePrice).toBe(60);
  });

  it("skips a glass-only row for the price but still counts it as listed", () => {
    const facts = derive({ lists: [listed({ bottle_price: null })] });
    expect(facts.publishedBottlePrice).toBeNull();
    expect(facts.listedAndOrderable).toBe(true);
  });

  it("is not listed when the only row is hidden", () => {
    const facts = derive({ lists: [listed({ hidden: true })] });
    expect(facts.listedAndOrderable).toBe(false);
  });
});

describe("dates and locations", () => {
  it("takes the latest put-away as a plain date", () => {
    const facts = derive({
      inventory: [lot({ added_at: "2026-03-01T10:00:00.000Z" }), lot({ added_at: "2026-08-14T23:30:00.000Z" })],
    });
    expect(facts.lastPutAwayAt).toBe("2026-08-14");
  });

  it("has no put-away date with no lots", () => {
    expect(derive({ inventory: [] }).lastPutAwayAt).toBeNull();
  });

  it("lists distinct locations, preferring the bin over the section", () => {
    const facts = derive({
      inventory: [lot({ bin_location: "A2" }), lot({ bin_location: "A2" }), lot({ bin_location: null, section: "Back room" })],
    });
    expect(facts.locations).toEqual(["A2", "Back room"]);
  });
});

describe("composeBadges", () => {
  const facts: CellarFacts = {
    sellingFormatUnits: 1,
    otherFormatUnits: 0,
    bottleCount: 1,
    locations: [],
    lastPutAwayAt: "2026-08-01",
    lastDepletionAt: "2026-08-20",
    deadStockDays: 90,
    publishedBottlePrice: 90,
    weightedUnitCost: 40,
    listedAndOrderable: true,
  };

  it("stamps the badges with the records basis as of the date given", () => {
    const badges = composeBadges(facts, null, "2026-09-03");
    expect(badges.basis).toEqual({ kind: "measured", asOf: "2026-09-03" });
    expect(badges.value.map((b) => b.kind)).toEqual(["last_bottle"]);
  });

  it("raises Drink now from a sourced window and from an override alike", () => {
    const sourced = composeBadges(
      facts,
      { value: { start: 2020, end: 2027 }, basis: { kind: "sourced", name: "S", url: "https://s", asOf: "2026-01-01" } },
      "2026-09-03",
    );
    const override = composeBadges(
      facts,
      { value: { start: 2020, end: 2027 }, basis: { kind: "override", by: "Devin", at: "2026-01-01" } },
      "2026-09-03",
    );
    expect(sourced.value.map((b) => b.kind)).toContain("drink_now");
    expect(override.value.map((b) => b.kind)).toContain("drink_now");
  });

  it("never raises Drink now from a window with any other basis", () => {
    // The type admits a corpus-based window; the rule does not. If one ever
    // arrives, it must not open a bottle.
    const badges = composeBadges(
      facts,
      { value: { start: 2020, end: 2027 }, basis: { kind: "corpus", name: "X-Wines" } },
      "2026-09-03",
    );
    expect(badges.value.map((b) => b.kind)).not.toContain("drink_now");
  });
});
