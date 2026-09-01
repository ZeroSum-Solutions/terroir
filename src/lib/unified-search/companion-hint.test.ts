// Companion hand-off hint (unified-search program, slice 2c/3b follow-up).
//
// Vocabulary-free by construction: every case here mirrors a reading
// parseAssistantQuery (src/lib/wine-intelligence/assistant-query.ts) already
// gives the same sentence today — this module borrows that parser rather
// than re-deciding what a price or a pairing looks like, so these cases are
// picked to match assistant-query.test.ts's own price phrasings.
import { describe, expect, it } from "vitest";
import { companionHint } from "./companion-hint";

describe("companionHint", () => {
  it("suggests the companion for a price ceiling — 'under $X'", () => {
    expect(companionHint("something under $50")).toEqual({
      suggested: true,
      reasons: ["price"],
    });
  });

  it("suggests the companion for a negated price floor — 'nothing over N dollars'", () => {
    expect(companionHint("nothing over 120 dollars")).toEqual({
      suggested: true,
      reasons: ["price"],
    });
  });

  it("suggests the companion for a price floor — 'over $X'", () => {
    expect(companionHint("something over $100")).toEqual({
      suggested: true,
      reasons: ["price"],
    });
  });

  it("suggests the companion for a price range", () => {
    expect(companionHint("between $50 and $90")).toEqual({
      suggested: true,
      reasons: ["price"],
    });
  });

  it("suggests the companion for a pairing word", () => {
    expect(companionHint("a red for steak")).toEqual({
      suggested: true,
      reasons: ["pairing"],
    });
  });

  it("suggests the companion with both reasons when price and pairing are both present", () => {
    expect(companionHint("something under $40 for fish")).toEqual({
      suggested: true,
      reasons: ["price", "pairing"],
    });
  });

  it("does not suggest the companion for a plain wine name", () => {
    expect(companionHint("Chateau Margaux 2015")).toEqual({
      suggested: false,
      reasons: [],
    });
  });

  it("does not suggest the companion for a query the tier-1 search already answers", () => {
    // The exact defect this closes (route.ts header, 2026-08-31): this used
    // to fall through to trigram noise with no companion offered at all —
    // but it carries neither a price nor a pairing, so this module correctly
    // stays silent; the all-scope-miss CTA is what covers it, unchanged.
    expect(companionHint("a crisp white from Portugal")).toEqual({
      suggested: false,
      reasons: [],
    });
  });

  it("does not suggest the companion for an empty query", () => {
    expect(companionHint("")).toEqual({ suggested: false, reasons: [] });
  });

  it("matches pairing words token-for-token, so a wine word that merely contains one never trips it", () => {
    // "porto" / "port" share letters with "pork"; "lambrusco" contains "lamb".
    // The lexicon matcher is whole-token equality, and this pins that a
    // substring matcher can never be swapped in silently.
    for (const query of ["porto", "quinta do noval 10 year old tawny port", "lambrusco", "duckhorn merlot"]) {
      expect(companionHint(query), query).toEqual({ suggested: false, reasons: [] });
    }
  });

  it("is not tripped up by a bare vintage year", () => {
    expect(companionHint("a 2018 Malbec")).toEqual({
      suggested: false,
      reasons: [],
    });
  });
});
