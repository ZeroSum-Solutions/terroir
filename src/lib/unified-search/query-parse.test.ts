// P1 — the typed-search query parser (program plan D1: vintage tokens,
// country[]/region[], demonyms, and the preference-vs-filter split).
//
// The corpus in fixtures/query-parse-cases.json is the acceptance bar and
// carries its own rationale per case; this file drives it and then pins the
// edges a corpus of realistic queries does not naturally reach.
import { describe, expect, it } from "vitest";
import corpus from "./fixtures/query-parse-cases.json";
import { parseSearchQuery } from "./query-parse";

type ExpectedParse = {
  vintages?: number[];
  countries?: string[];
  regions?: string[];
  colours?: string[];
  body?: string[];
  text?: string;
};

describe("parseSearchQuery — corpus", () => {
  for (const testCase of corpus.cases as Array<{
    why: string;
    query: string;
    expect: ExpectedParse;
  }>) {
    it(`${testCase.why} — ${JSON.stringify(testCase.query)}`, () => {
      const parsed = parseSearchQuery(testCase.query);
      const want = testCase.expect;
      expect(parsed.filters.vintages).toEqual(want.vintages ?? []);
      expect(parsed.filters.countries).toEqual(want.countries ?? []);
      expect(parsed.filters.regions).toEqual(want.regions ?? []);
      expect(parsed.filters.colours).toEqual(want.colours ?? []);
      expect(parsed.preferences.body).toEqual(want.body ?? []);
      expect(parsed.text).toBe(want.text ?? "");
    });
  }
});

describe("parseSearchQuery — edges the corpus does not reach", () => {
  it("keeps a year that is out of wine range as ordinary text", () => {
    // A vintage filter built from "3000" would match nothing and silently
    // empty the results; leaving it in the needle at least searches for it.
    const parsed = parseSearchQuery("cuvee 3000");
    expect(parsed.filters.vintages).toEqual([]);
    expect(parsed.text).toBe("cuvee 3000");
  });

  it("accepts a vintage at the far edge of the range", () => {
    const parsed = parseSearchQuery("madeira 1875");
    expect(parsed.filters.vintages).toEqual([1875]);
  });

  it("names each vintage once, however many times it is typed", () => {
    const parsed = parseSearchQuery("barolo 2016 2016");
    expect(parsed.filters.vintages).toEqual([2016]);
  });

  it("does not let a country inside a producer's name hijack the filter", () => {
    // "Chile" is a country; "Chilean" is its demonym. Neither appears here —
    // a substring match would have found "chile" inside "Chiles" and filtered
    // the search down to a country the user never named.
    const parsed = parseSearchQuery("domaine des chiles");
    expect(parsed.filters.countries).toEqual([]);
    expect(parsed.text).toBe("domaine des chiles");
  });

  it("leaves nothing in the needle when every word was understood", () => {
    const parsed = parseSearchQuery("italian red 2016");
    expect(parsed.text).toBe("");
  });

  it("says whether anything at all was understood", () => {
    // The palette needs this to tell 'a query we parsed and genuinely missed'
    // from 'a query we never understood' — different sentences to the user.
    expect(parseSearchQuery("italian barolo").understood).toBe(true);
    expect(parseSearchQuery("chateau margaux").understood).toBe(false);
  });

  it("is a pure read of the text — the same query parses the same way twice", () => {
    const first = parseSearchQuery("crisp white from portugal 2020");
    const second = parseSearchQuery("crisp white from portugal 2020");
    expect(first).toEqual(second);
  });
});
