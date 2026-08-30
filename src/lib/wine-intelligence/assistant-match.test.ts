import { describe, expect, it } from "vitest";
import { selectCellarMatches, type AssistantCellarWine } from "./assistant-match";
import type { AssistantQuery } from "./assistant-query";

const wine = (over: Partial<AssistantCellarWine> = {}): AssistantCellarWine => ({
  wineId: "w1",
  name: "Reserva",
  producer: "Quinta Test",
  vintage: 2019,
  colour: "red",
  country: "Portugal",
  region: "Douro",
  varietal: "Touriga Nacional",
  price: 80,
  onHand: 4,
  type: "Red",
  body: "Full-bodied",
  grapes: ["Touriga Nacional"],
  pairings: ["Beef", "Lamb"],
  ratingAvg: 4.1,
  ratingCount: 900,
  imageUrl: null,
  elaborate: "Assemblage/Blend",
  ...over,
});

const query = (over: Partial<AssistantQuery> = {}): AssistantQuery => ({
  understood: [],
  unrecognized: [],
  ...over,
});

describe("selectCellarMatches", () => {
  it("returns nothing when the query understood nothing, rather than everything", () => {
    // The dangerous default. An unparsed question must not silently render as
    // "here is your whole cellar", which reads like an answer.
    expect(selectCellarMatches([wine()], query())).toEqual([]);
  });

  it("filters by pairing overlap", () => {
    const beef = wine({ wineId: "beef", pairings: ["Beef"] });
    const fish = wine({ wineId: "fish", pairings: ["Lean Fish"] });
    const got = selectCellarMatches([beef, fish], query({ pairing: ["Beef"], understood: ["pairing"] }));
    expect(got.map((w) => w.wineId)).toEqual(["beef"]);
  });

  it("treats a multi-value pairing as a union, not an intersection", () => {
    const rich = wine({ wineId: "rich", pairings: ["Rich Fish"] });
    const lean = wine({ wineId: "lean", pairings: ["Lean Fish"] });
    const got = selectCellarMatches(
      [rich, lean],
      query({ pairing: ["Rich Fish", "Lean Fish"], understood: ["pairing"] }),
    );
    expect(got).toHaveLength(2);
  });

  it("filters by price band inclusively", () => {
    const cheap = wine({ wineId: "cheap", price: 30 });
    const mid = wine({ wineId: "mid", price: 200 });
    const dear = wine({ wineId: "dear", price: 500 });
    const got = selectCellarMatches(
      [cheap, mid, dear],
      query({ priceMin: 200, priceMax: 400, understood: ["priceMin", "priceMax"] }),
    );
    expect(got.map((w) => w.wineId)).toEqual(["mid"]);
  });

  it("excludes a wine with no price when a price bound was asked for", () => {
    // A NULL price cannot be shown to satisfy "$200-400". Including it would
    // put an unpriced bottle in a priced answer.
    const unpriced = wine({ wineId: "unpriced", price: null });
    expect(
      selectCellarMatches([unpriced], query({ priceMax: 400, understood: ["priceMax"] })),
    ).toEqual([]);
  });

  it("falls back to the cellar's own colour when the wine has no corpus row", () => {
    const orphan = wine({ wineId: "orphan", type: null, colour: "sparkling" });
    const got = selectCellarMatches([orphan], query({ type: "Sparkling", understood: ["type"] }));
    expect(got.map((w) => w.wineId)).toEqual(["orphan"]);
  });

  it("maps the cellar's 'fortified' colour onto the corpus's port type", () => {
    const port = wine({ wineId: "port", type: null, colour: "fortified" });
    const got = selectCellarMatches([port], query({ type: "Dessert/Port", understood: ["type"] }));
    expect(got.map((w) => w.wineId)).toEqual(["port"]);
  });

  it("matches a grape against varietal or the corpus grape list", () => {
    const byVarietal = wine({ wineId: "v", varietal: "Malbec", grapes: [] });
    const byCorpus = wine({ wineId: "c", varietal: null, grapes: ["Malbec"] });
    const miss = wine({ wineId: "m", varietal: "Merlot", grapes: ["Merlot"] });
    const got = selectCellarMatches(
      [byVarietal, byCorpus, miss],
      query({ grape: "Malbec", understood: ["grape"] }),
    );
    expect(got.map((w) => w.wineId).sort()).toEqual(["c", "v"]);
  });

  it("ANDs separate dimensions", () => {
    const both = wine({ wineId: "both", country: "Portugal", type: "Red" });
    const onlyCountry = wine({ wineId: "one", country: "Portugal", type: "White", colour: "white" });
    const got = selectCellarMatches(
      [both, onlyCountry],
      query({ country: "Portugal", type: "Red", understood: ["country", "type"] }),
    );
    expect(got.map((w) => w.wineId)).toEqual(["both"]);
  });

  it("compares vocabulary values case- and accent-insensitively", () => {
    const w = wine({ wineId: "sg", region: "Serra Gaúcha" });
    const got = selectCellarMatches([w], query({ region: "serra gaucha", understood: ["region"] }));
    expect(got.map((w2) => w2.wineId)).toEqual(["sg"]);
  });

  it("filters blends from single varietals", () => {
    const blend = wine({ wineId: "blend", elaborate: "Assemblage/Bordeaux Red Blend" });
    const single = wine({ wineId: "single", elaborate: "Varietal/100%" });
    expect(
      selectCellarMatches([blend, single], query({ blend: true, understood: ["blend"] })).map((w) => w.wineId),
    ).toEqual(["blend"]);
    expect(
      selectCellarMatches([blend, single], query({ blend: false, understood: ["blend"] })).map((w) => w.wineId),
    ).toEqual(["single"]);
  });

  it("excludes a wine with no corpus row when blend was asked for", () => {
    // Unknown is not "not a blend". Guessing either way would put a wine in
    // an answer on the strength of missing data.
    const orphan = wine({ wineId: "orphan", elaborate: null });
    expect(selectCellarMatches([orphan], query({ blend: true, understood: ["blend"] }))).toEqual([]);
    expect(selectCellarMatches([orphan], query({ blend: false, understood: ["blend"] }))).toEqual([]);
  });

  it("orders by community rating, then by how many bottles are on hand", () => {
    const low = wine({ wineId: "low", ratingAvg: 3.2, onHand: 9 });
    const high = wine({ wineId: "high", ratingAvg: 4.5, onHand: 1 });
    const mid = wine({ wineId: "mid", ratingAvg: 4.5, onHand: 6 });
    const got = selectCellarMatches(
      [low, high, mid],
      query({ country: "Portugal", understood: ["country"] }),
    );
    expect(got.map((w) => w.wineId)).toEqual(["mid", "high", "low"]);
  });

  it("puts wines that are out of stock last without hiding them", () => {
    const out = wine({ wineId: "out", onHand: 0, ratingAvg: 5 });
    const inStock = wine({ wineId: "in", onHand: 2, ratingAvg: 3 });
    const got = selectCellarMatches(
      [out, inStock],
      query({ country: "Portugal", understood: ["country"] }),
    );
    expect(got.map((w) => w.wineId)).toEqual(["in", "out"]);
  });
});
