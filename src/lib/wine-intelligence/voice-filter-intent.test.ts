import { describe, expect, it } from "vitest";
import { resolveVoiceFilterIntent, type FacetVocabulary } from "./voice-filter-intent";

const vocabulary: FacetVocabulary = {
  country: ["France", "Italy", "United States"],
  region: ["Napa", "Napa Valley", "Burgundy", "California"],
  varietal: ["Cabernet Sauvignon", "Pinot Noir", "Chardonnay"],
};

describe("resolveVoiceFilterIntent", () => {
  it("matches a region facet", () => {
    expect(
      resolveVoiceFilterIntent("pull up any wines from California", vocabulary),
    ).toEqual({ region: "California" });
  });

  it("matches a country facet", () => {
    expect(
      resolveVoiceFilterIntent("any wines from Italy", vocabulary),
    ).toEqual({ country: "Italy" });
  });

  it("matches a varietal facet", () => {
    expect(
      resolveVoiceFilterIntent("show me the Chardonnay", vocabulary),
    ).toEqual({ varietal: "Chardonnay" });
  });

  it("matches a drink-now status phrase", () => {
    expect(
      resolveVoiceFilterIntent("show me wines that are ready to drink", vocabulary),
    ).toEqual({ filter: "drink-now" });
  });

  it("matches multiple dimensions in one utterance", () => {
    expect(
      resolveVoiceFilterIntent("any Chardonnay from Burgundy", vocabulary),
    ).toEqual({ varietal: "Chardonnay", region: "Burgundy" });
  });

  it("prefers the more specific vocabulary value when two both match", () => {
    // "Napa" and "Napa Valley" both match exactly (score 1.0) — the longer,
    // more specific value should win the tie.
    expect(
      resolveVoiceFilterIntent("any wines from Napa Valley", vocabulary),
    ).toEqual({ region: "Napa Valley" });
  });

  it("emits exactly one dimension when a value is both a country and a region (same evidence span)", () => {
    const overlapping: FacetVocabulary = {
      country: ["Georgia", "France"],
      region: ["Georgia", "Napa"],
      varietal: ["Chardonnay"],
    };
    const result = resolveVoiceFilterIntent("show me Georgia wines", overlapping);
    expect(result).not.toBeNull();
    expect(Object.keys(result ?? {})).toHaveLength(1);
    // Same span, same score -> the more specific dimension (region) wins.
    expect(result).toEqual({ region: "Georgia" });
  });

  it("falls back to a tight search phrase when nothing in the vocabulary matches", () => {
    expect(
      resolveVoiceFilterIntent("show me any Opus One please", vocabulary),
    ).toEqual({ search: "opus one" });
  });

  it("returns null for unrelated speech (never guess)", () => {
    expect(
      resolveVoiceFilterIntent("what is the weather tomorrow", vocabulary),
    ).toBeNull();
  });

  it("returns null for an empty transcript", () => {
    expect(resolveVoiceFilterIntent("   ", vocabulary)).toBeNull();
  });

  it("returns null when the vocabulary is empty and nothing collapses to a tight phrase", () => {
    const empty: FacetVocabulary = { country: [], region: [], varietal: [] };
    expect(
      resolveVoiceFilterIntent("do we still have any wine in the cellar", empty),
    ).toBeNull();
  });
});
