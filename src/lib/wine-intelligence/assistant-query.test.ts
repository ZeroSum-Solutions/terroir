import { describe, expect, it } from "vitest";
import { parseAssistantQuery, type AssistantVocabulary } from "./assistant-query";

const vocabulary: AssistantVocabulary = {
  country: ["Argentina", "Portugal", "France", "Italy", "United States"],
  region: ["Mendoza", "Douro", "Bordeaux", "Serra Gaúcha"],
  grape: ["Malbec", "Touriga Nacional", "Cabernet Sauvignon", "Pinot Noir"],
};

const parse = (q: string) => parseAssistantQuery(q, vocabulary);

describe("parseAssistantQuery", () => {
  describe("the PRD's worked example", () => {
    // docs/plans/2026-08-29-terroir-refactor-field-notes.md SCAN-10, quoted
    // verbatim from Devin. This is the query the feature exists to answer, so
    // it gets an assertion of its own rather than being decomposed away.
    it("handles blend + country + price range + pairing together", () => {
      const q = parse(
        "Hey, I'm looking for a good blend from Argentina and something between the $200 and $400 range that might pair nicely with meats.",
      );
      expect(q.country).toBe("Argentina");
      expect(q.priceMin).toBe(200);
      expect(q.priceMax).toBe(400);
      expect(q.pairing).toContain("Beef");
      expect(q.blend).toBe(true);
      // Every content word in Devin's sentence is now either a constraint or
      // a filler word. Nothing is silently dropped.
      expect(q.unrecognized).toHaveLength(0);
    });
  });

  describe("blend vs single varietal", () => {
    it("reads a blend", () => {
      expect(parse("a good blend").blend).toBe(true);
      expect(parse("an assemblage").blend).toBe(true);
    });

    it("reads a single varietal", () => {
      expect(parse("a single varietal red").blend).toBe(false);
      expect(parse("something 100% Malbec").blend).toBe(false);
    });

    it("stays silent when the question says nothing about it", () => {
      expect(parse("a red from Portugal").blend).toBeUndefined();
    });
  });

  describe("colour and type", () => {
    it("reads a bare colour", () => {
      expect(parse("something red").type).toBe("Red");
      expect(parse("a white for tonight").type).toBe("White");
    });

    it("maps common synonyms onto the corpus vocabulary", () => {
      expect(parse("something with bubbles").type).toBe("Sparkling");
      expect(parse("a champagne").type).toBe("Sparkling");
      expect(parse("a pink wine").type).toBe("Rosé");
      expect(parse("a port").type).toBe("Dessert/Port");
    });

    it("does not read a colour that was never mentioned", () => {
      expect(parse("something from Portugal").type).toBeUndefined();
    });

    // "red" appears inside "shredded"; matching must be word-aware, not a
    // naive substring test, or half the corpus vocabulary fires on prose.
    it("does not match a colour word embedded in another word", () => {
      expect(parse("shredded pork").type).toBeUndefined();
    });
  });

  describe("body", () => {
    it("reads body words", () => {
      expect(parse("something full bodied").body).toBe("Full-bodied");
      expect(parse("a light bodied white").body).toBe("Light-bodied");
      expect(parse("medium bodied").body).toBe("Medium-bodied");
    });

    it("maps informal weight words", () => {
      expect(parse("something bold").body).toBe("Full-bodied");
      expect(parse("something crisp and light").body).toBe("Light-bodied");
    });
  });

  describe("pairing", () => {
    it("matches a corpus pairing value directly", () => {
      expect(parse("goes with lamb").pairing).toEqual(["Lamb"]);
    });

    it("maps everyday food words onto the corpus vocabulary", () => {
      expect(parse("pairs with steak").pairing).toContain("Beef");
      expect(parse("something for chicken").pairing).toContain("Poultry");
    });

    // "fish" is genuinely two corpus values. Collapsing to one would silently
    // drop half the honest answers, so the contract carries a list.
    it("expands an ambiguous food word to every value it covers", () => {
      const pairing = parse("what goes with fish").pairing ?? [];
      expect(pairing).toContain("Rich Fish");
      expect(pairing).toContain("Lean Fish");
    });

    it("matches multi-word pairing values", () => {
      expect(parse("something for goat cheese").pairing).toContain("Goat Cheese");
    });
  });

  describe("price", () => {
    it("reads a hyphenated range", () => {
      expect(parse("a red $200-400")).toMatchObject({ priceMin: 200, priceMax: 400 });
    });

    it("reads a between/and range", () => {
      expect(parse("between $50 and $90")).toMatchObject({ priceMin: 50, priceMax: 90 });
    });

    it("reads an upper bound", () => {
      expect(parse("something under $50")).toMatchObject({ priceMax: 50 });
      expect(parse("nothing over 120 dollars")).toMatchObject({ priceMax: 120 });
    });

    it("reads a lower bound", () => {
      expect(parse("something over $100")).toMatchObject({ priceMin: 100 });
    });

    it("orders a reversed range rather than returning an empty band", () => {
      expect(parse("between $400 and $200")).toMatchObject({ priceMin: 200, priceMax: 400 });
    });

    it("does not read a vintage year as a price", () => {
      const q = parse("a 2018 Malbec");
      expect(q.priceMin).toBeUndefined();
      expect(q.priceMax).toBeUndefined();
      // It is not nothing, either: a year is a constraint of its own.
      expect(q.vintages).toEqual([2018]);
    });
  });

  describe("vintage", () => {
    it("reads a bare year as a constraint", () => {
      const q = parse("a 2018 Malbec from Mendoza");
      expect(q.vintages).toEqual([2018]);
      expect(q.understood).toContain("vintage");
    });

    // Two years mean "either" — the same reason `pairing` is a list. Taking
    // only the first would drop the second exactly as silently as the bug
    // this contract exists to prevent.
    it("reads several years as alternatives", () => {
      expect(parse("a 2018 or 2019 Malbec").vintages).toEqual([2018, 2019]);
    });

    it("does not read a monetary figure as a vintage", () => {
      const q = parse("something under $2018");
      expect(q.vintages).toBeUndefined();
      expect(q.priceMax).toBe(2018);
    });

    // Below the band a four-digit number in a wine question is far likelier
    // to be a cuvee name or a street number than a year.
    it("does not read a four-digit number outside the vintage band", () => {
      expect(parse("a 1500 Malbec").vintages).toBeUndefined();
    });

    it("does not read a number glued to a unit as a vintage", () => {
      expect(parse("a 1500ml bottle of Malbec").vintages).toBeUndefined();
    });

    it("says nothing about vintage when the question carries no year", () => {
      expect(parse("a red from Portugal").vintages).toBeUndefined();
    });
  });

  describe("tenant vocabulary", () => {
    it("matches country, region and grape from the caller's own values", () => {
      expect(parse("a Malbec from Mendoza").region).toBe("Mendoza");
      expect(parse("a Malbec from Mendoza").grape).toBe("Malbec");
      expect(parse("anything from Portugal").country).toBe("Portugal");
    });

    it("matches accented vocabulary written without accents", () => {
      expect(parse("wines from Serra Gaucha").region).toBe("Serra Gaúcha");
    });

    it("never invents a value that is not in the vocabulary", () => {
      // Narnia is not a country the tenant holds. It must not become one.
      const q = parse("a red from Narnia");
      expect(q.country).toBeUndefined();
      expect(q.region).toBeUndefined();
      expect(q.unrecognized).toContain("narnia");
    });

    it("prefers the longer vocabulary value when two overlap", () => {
      const v: AssistantVocabulary = {
        country: [],
        region: ["Napa", "Napa Valley"],
        grape: [],
      };
      expect(parseAssistantQuery("wines from Napa Valley", v).region).toBe("Napa Valley");
    });
  });

  describe("honesty about what it did not understand", () => {
    it("reports an empty query as understanding nothing", () => {
      const q = parse("hello there");
      expect(q.understood).toHaveLength(0);
    });

    it("lists the dimensions it did recognise", () => {
      const q = parse("a bold red from Portugal under $80 for beef");
      expect(q.understood).toEqual(
        expect.arrayContaining(["type", "body", "country", "priceMax", "pairing"]),
      );
    });

    it("does not report filler words as unrecognised", () => {
      expect(parse("show me a red wine please").unrecognized).toHaveLength(0);
    });

    // The bug this replaces: pure-digit tokens were stripped from the report,
    // so a number that became neither a price nor a vintage vanished without
    // the panel's "I did not understand X" line ever mentioning it.
    it("reports a number it could place nowhere rather than dropping it", () => {
      expect(parse("a red 1500").unrecognized).toContain("1500");
    });

    it("does not report a year it understood as unrecognised", () => {
      expect(parse("a 2018 red").unrecognized).toHaveLength(0);
    });
  });
});

// A negated facet was AFFIRMED before this: "a red that isn't cabernet"
// returned grape: "Cabernet Sauvignon", so the reader was handed the exact
// wine they asked to avoid — and `understood` listed it, so the panel
// presented the inversion as a constraint it had confidently parsed. That is
// the confident-wrong-answer class this module's own header (D-006b) and the
// D2 grounding contract exist to prevent, and it is worse than not parsing at
// all: an unparsed word says "I did not understand", an inverted one lies.
//
// Scope of the fix, deliberately narrow: a negated facet is NOT SET, and its
// words fall through to `unrecognized` so the panel's existing "I did not
// understand that part" notice fires. Actually EXCLUDING on a negated facet
// (a real NOT predicate) is follow-up work — saying so honestly is not.
describe("parseAssistantQuery — negation is never read as affirmation", () => {
  it("does not return the grape the question rules out", () => {
    const q = parse("a red that isn't cabernet sauvignon");
    expect(q.grape).toBeUndefined();
    expect(q.understood).not.toContain("grape");
    // The rest of the question still parses — only the negated part drops.
    expect(q.type).toBe("Red");
  });

  it("does not return the grape after a plain 'but not'", () => {
    const q = parse("a red but not pinot noir");
    expect(q.grape).toBeUndefined();
    expect(q.type).toBe("Red");
  });

  it("does not return the country the question excludes", () => {
    const q = parse("a red from anywhere except italy");
    expect(q.country).toBeUndefined();
    expect(q.type).toBe("Red");
  });

  it("does not return the very type the question opens by refusing", () => {
    // The worst case found: this returned type "Sparkling" with unrecognized
    // EMPTY, so there was not even a caveat on screen — total confidence,
    // exactly inverted.
    const q = parse("no sparkling please");
    expect(q.type).toBeUndefined();
    expect(q.understood).not.toContain("type");
    expect(q.unrecognized).toContain("sparkling");
  });

  it("does not read a negated vintage as the vintage asked for", () => {
    const q = parse("a bordeaux but not 2016");
    expect(q.vintages ?? []).not.toContain(2016);
  });

  it("still affirms the same facets when nothing negates them", () => {
    // The regression guard: negation detection must not cost the ordinary
    // affirmative reading, which is the overwhelmingly common case.
    const q = parse("a red that is cabernet sauvignon");
    expect(q.grape).toBe("Cabernet Sauvignon");
    expect(q.type).toBe("Red");
  });

  it("stops the negation at the phrase it applies to", () => {
    // "not sparkling" must not suppress the "red" and "Italy" that follow it;
    // a negation that leaks forward would trade one silent wrong answer for
    // another.
    const q = parse("not sparkling, a red from italy");
    expect(q.type).toBe("Red");
    expect(q.country).toBe("Italy");
  });

  it("reaches its object across small words, but not across a content word", () => {
    // These two put the negation the same distance from the facet, and only
    // one of them negates it. A fixed lookback window gets one or the other
    // wrong: in "not sparkling, a red" the refusal has already landed on
    // "sparkling", so the red is genuinely wanted.
    expect(parse("anything other than a malbec").grape).toBeUndefined();
    expect(parse("not sparkling, a malbec").grape).toBe("Malbec");
  });

  it("leaves an unrelated facet alone when the negation lands on a non-facet", () => {
    const q = parse("something white without oak");
    expect(q.type).toBe("White");
  });

  it("does not mangle a contraction into a stray token", () => {
    // normalize() turned every apostrophe into a space, so "isn't" became the
    // words "isn" and "t" and surfaced as unrecognized noise.
    const q = parse("a red that isn't cabernet sauvignon");
    expect(q.unrecognized).not.toContain("isn");
  });
});

// The assistant's country/region vocabulary is the tenant's own DISTINCT
// values, so it knew "Italy" but not "italian", and its type table knew "red"
// but not "reds". The search gazetteer (src/lib/unified-search/wine-gazetteer)
// already carries demonyms, plurals and alternate spellings because slice 3a
// had to; spending a provider call to recover "italian" when a lookup table in
// the same repo resolves it would be paying for capability we own (ops spec
// 2026-09-01 §2.1). The honesty rule is unchanged: a demonym resolves ONLY to
// a country the tenant actually holds — it never introduces one.
describe("parseAssistantQuery — demonyms, plurals and spellings from the gazetteer", () => {
  it("reads a demonym as the country the tenant holds", () => {
    const q = parse("an italian red");
    expect(q.country).toBe("Italy");
    expect(q.type).toBe("Red");
    // The demonym was understood, so it is not reported as noise.
    expect(q.unrecognized).not.toContain("italian");
  });

  it("reads another demonym the same way", () => {
    expect(parse("a portuguese white").country).toBe("Portugal");
  });

  it("reads a plural type", () => {
    expect(parse("bold reds").type).toBe("Red");
    expect(parse("crisp whites").type).toBe("White");
  });

  it("reads an alternate spelling of a region the tenant holds", () => {
    const q = parseAssistantQuery("a bourgogne", {
      country: [],
      region: ["Burgundy"],
      grape: [],
    });
    expect(q.region).toBe("Burgundy");
  });

  it("never lets a demonym introduce a country the tenant does not hold", () => {
    // Same sentence, tenant with no Italian wine: "italian" must stay a word
    // it could not place, exactly as "Narnia" does. The gazetteer knowing a
    // country is not the same as this cellar having one.
    const q = parseAssistantQuery("an italian red", { country: ["France"], region: [], grape: [] });
    expect(q.country).toBeUndefined();
    expect(q.unrecognized).toContain("italian");
  });

  it("still honours a negation that lands on the demonym", () => {
    const q = parse("a red but not italian");
    expect(q.country).toBeUndefined();
    expect(q.type).toBe("Red");
  });

  it("does not read a filler word as a country just because a gazetteer lists it", () => {
    // The gazetteer's surface terms for "United States" include "us". In
    // "show us a red", "us" is the reader, not a nation — and it is already in
    // FILLER_WORDS, which is the tell: a word the parser treats as noise cannot
    // also be a country signal.
    const q = parse("show us a red");
    expect(q.country).toBeUndefined();
    expect(q.type).toBe("Red");
  });
});

