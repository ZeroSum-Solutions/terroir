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

    it("ignores a vintage year that is not a price", () => {
      const q = parse("a 2018 Malbec");
      expect(q.priceMin).toBeUndefined();
      expect(q.priceMax).toBeUndefined();
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
  });
});
