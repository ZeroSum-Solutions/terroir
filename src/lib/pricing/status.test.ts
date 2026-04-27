import { describe, expect, it } from "vitest";
import {
  formatPricingStatusLabel,
  getBandMarkerPosition,
  getBottleStatus,
  getGlassStatus,
  getMarkupRatio,
  getPourCostPct,
  isPricingOutlier,
  isRetailPlausible,
  isRetailStale,
  isSnoozeActive,
  resolveMarkupTarget,
  resolvePourCostTarget,
  suggestBottlePrice,
  suggestGlassPrice,
  DEFAULT_TARGET_MARKUP_RATIO,
  DEFAULT_TARGET_POUR_COST_PCT,
} from "./status";

describe("getPourCostPct", () => {
  it("computes 22% for a $20 cost / $90 glass", () => {
    // $85/btl × (148/750) = $16.77 cost per pour
    // 16.77 / 76 = 22.06% → use convenient numbers:
    // costPerBottle 76, sizeMl 750, glassPourMl 148, glassPrice 19.95
    // 76 / 750 × 148 = 14.997 cost-per-pour
    // 14.997 / 19.95 = 75% — not what we want, let me re-derive
    // Want 22%: cost-per-pour / glassPrice = 0.22 → cost-per-pour = 0.22 × glassPrice
    // For $20 cost-per-bottle / 750ml × 148ml = $3.95 cost-per-pour. At $18 glass = 21.9%
    expect(getPourCostPct(20, 750, 148, 18)).toBeCloseTo(21.94, 1);
  });
  it("returns null on missing inputs", () => {
    expect(getPourCostPct(null, 750, 148, 18)).toBeNull();
    expect(getPourCostPct(20, null, 148, 18)).toBeNull();
    expect(getPourCostPct(20, 750, null, 18)).toBeNull();
    expect(getPourCostPct(20, 750, 148, null)).toBeNull();
  });
  it("returns null on zero/negative inputs", () => {
    expect(getPourCostPct(20, 0, 148, 18)).toBeNull();
    expect(getPourCostPct(20, 750, 0, 18)).toBeNull();
    expect(getPourCostPct(20, 750, 148, 0)).toBeNull();
  });
});

describe("getMarkupRatio", () => {
  it("computes 2.7× for $230 list / $85 retail", () => {
    expect(getMarkupRatio(230, 85)).toBeCloseTo(2.706, 2);
  });
  it("returns null on missing or non-positive inputs", () => {
    expect(getMarkupRatio(null, 85)).toBeNull();
    expect(getMarkupRatio(230, null)).toBeNull();
    expect(getMarkupRatio(230, 0)).toBeNull();
    expect(getMarkupRatio(0, 85)).toBeNull();
  });
});

describe("suggestBottlePrice", () => {
  it("rounds to nearest dollar (Pichon Lalande example)", () => {
    expect(suggestBottlePrice(85, 2.7)).toBe(230); // 85 × 2.7 = 229.5 → 230
  });
  it("returns null on missing inputs", () => {
    expect(suggestBottlePrice(null, 2.7)).toBeNull();
    expect(suggestBottlePrice(85, null)).toBeNull();
  });
});

describe("suggestGlassPrice", () => {
  it("computes a price hitting the target pour cost (5oz pour, 22% target)", () => {
    // costPerBottle 85, size 750, pour 148, target 22%
    // costPerPour = 85/750 × 148 = 16.77
    // glassPrice = 16.77 × 100 / 22 = 76.24 → 76
    expect(suggestGlassPrice(85, 750, 148, 22)).toBe(76);
  });
  it("returns null on bad target pour cost (>= 100)", () => {
    expect(suggestGlassPrice(85, 750, 148, 100)).toBeNull();
    expect(suggestGlassPrice(85, 750, 148, 0)).toBeNull();
  });
});

describe("getBottleStatus", () => {
  const target = 2.7;
  it("on_target within ±10%", () => {
    expect(getBottleStatus(2.7, target)).toBe("on_target");
    expect(getBottleStatus(2.5, target)).toBe("on_target"); // 7% deviation
    expect(getBottleStatus(2.9, target)).toBe("on_target"); // 7% deviation
  });
  it("tight when actual < target by 10-20%", () => {
    expect(getBottleStatus(2.3, target)).toBe("tight"); // 14.8% under
  });
  it("premium when actual > target by 10-20%", () => {
    expect(getBottleStatus(3.1, target)).toBe("premium"); // 14.8% over
  });
  it("outlier when deviation >20%", () => {
    expect(getBottleStatus(1.4, target)).toBe("outlier"); // 48% under (Pichon @ $115)
    expect(getBottleStatus(3.5, target)).toBe("outlier"); // 30% over
  });
  it("unknown on missing inputs", () => {
    expect(getBottleStatus(null, target)).toBe("unknown");
    expect(getBottleStatus(2.7, null)).toBe("unknown");
  });
});

describe("getGlassStatus", () => {
  const target = 22;
  it("on_target within ±10%", () => {
    expect(getGlassStatus(22, target)).toBe("on_target");
    expect(getGlassStatus(20, target)).toBe("on_target"); // 9% under
  });
  it("tight when actual > target by 10-20% (worse pour cost)", () => {
    expect(getGlassStatus(25, target)).toBe("tight"); // 13.6% over
  });
  it("premium when actual < target by 10-20% (better pour cost)", () => {
    expect(getGlassStatus(19, target)).toBe("premium"); // 13.6% under
  });
  it("outlier when deviation >20% in either direction", () => {
    expect(getGlassStatus(28, target)).toBe("outlier"); // 27% over (very tight margin)
    // Reviewer-find C1: 31.8% under target (much better margin than wanted)
    // SHOULD flag for review — could be missed opportunity OR wrong-wine
    // cost basis from a bad LWIN match. Don't silently swallow extreme
    // favorable deviations.
    expect(getGlassStatus(15, target)).toBe("outlier"); // 31.8% under
  });
});

describe("isPricingOutlier", () => {
  it("triggers when either bottle or glass is outlier", () => {
    expect(isPricingOutlier("outlier", "on_target")).toBe(true);
    expect(isPricingOutlier("on_target", "outlier")).toBe(true);
    expect(isPricingOutlier("outlier", "outlier")).toBe(true);
  });
  it("does not trigger when both are non-outlier", () => {
    expect(isPricingOutlier("on_target", "on_target")).toBe(false);
    expect(isPricingOutlier("tight", "premium")).toBe(false);
    expect(isPricingOutlier("unknown", "unknown")).toBe(false);
  });
});

describe("isSnoozeActive", () => {
  const NOW = new Date("2026-04-26T12:00:00Z");
  it("false when null", () => {
    expect(isSnoozeActive(null, NOW)).toBe(false);
    expect(isSnoozeActive(undefined, NOW)).toBe(false);
  });
  it("true when until is in the future", () => {
    expect(isSnoozeActive("2026-05-26T12:00:00Z", NOW)).toBe(true);
  });
  it("false when until is in the past", () => {
    expect(isSnoozeActive("2026-03-26T12:00:00Z", NOW)).toBe(false);
  });
});

describe("isRetailStale", () => {
  const NOW = new Date("2026-04-26T12:00:00Z");
  it("true when null (never refreshed)", () => {
    expect(isRetailStale(null, NOW)).toBe(true);
  });
  it("false when within 7-day window", () => {
    expect(isRetailStale("2026-04-25T12:00:00Z", NOW)).toBe(false); // 1d
    expect(isRetailStale("2026-04-20T12:00:00Z", NOW)).toBe(false); // 6d
  });
  it("true when older than 7 days", () => {
    expect(isRetailStale("2026-04-19T11:00:00Z", NOW)).toBe(true);
  });
});

describe("isRetailPlausible (sanity filter for Wine-Searcher responses)", () => {
  it("accepts when invoice cost is unknown (no anchor to filter against)", () => {
    expect(isRetailPlausible(85, null)).toBe(true);
    expect(isRetailPlausible(85, undefined)).toBe(true);
  });
  it("accepts plausible price within 0.1×–10× invoice cost", () => {
    expect(isRetailPlausible(85, 80)).toBe(true);
    expect(isRetailPlausible(110, 85)).toBe(true);
    expect(isRetailPlausible(20, 80)).toBe(true); // 0.25× — wholesale is sometimes lower
  });
  it("rejects retail price <0.1× invoice cost (too low — wrong wine?)", () => {
    expect(isRetailPlausible(5, 80)).toBe(false);
  });
  it("rejects retail price >10× invoice cost (too high — wrong wine?)", () => {
    expect(isRetailPlausible(900, 80)).toBe(false);
  });
});

describe("getBandMarkerPosition", () => {
  it("returns 50 when bottle list equals target price", () => {
    // target = 85 × 2.7 = 229.5; band is 70%-130% of that
    // bottleList 229.5 → centered → 50%
    expect(getBandMarkerPosition(229.5, 85, 2.7)).toBeCloseTo(50, 0);
  });
  it("clamps to 0 when bottle list is below band", () => {
    expect(getBandMarkerPosition(50, 85, 2.7)).toBe(0);
  });
  it("clamps to 100 when bottle list is above band", () => {
    expect(getBandMarkerPosition(500, 85, 2.7)).toBe(100);
  });
  it("returns 0 when inputs missing", () => {
    expect(getBandMarkerPosition(null, 85, 2.7)).toBe(0);
    expect(getBandMarkerPosition(230, null, 2.7)).toBe(0);
    expect(getBandMarkerPosition(230, 85, null)).toBe(0);
  });
});

describe("formatPricingStatusLabel", () => {
  it("renders human-readable labels", () => {
    expect(formatPricingStatusLabel("on_target")).toBe("On target");
    expect(formatPricingStatusLabel("tight")).toBe("Tight margin");
    expect(formatPricingStatusLabel("premium")).toBe("Above target");
    expect(formatPricingStatusLabel("outlier")).toBe("Outlier");
    expect(formatPricingStatusLabel("unknown")).toBe("—");
  });
});

describe("resolvePourCostTarget", () => {
  it("prefers per-wine over restaurant over fallback", () => {
    expect(resolvePourCostTarget(18, 22)).toBe(18);
    expect(resolvePourCostTarget(null, 22)).toBe(22);
    expect(resolvePourCostTarget(null, null)).toBe(DEFAULT_TARGET_POUR_COST_PCT);
  });
});

describe("resolveMarkupTarget", () => {
  it("prefers per-wine over restaurant over fallback", () => {
    expect(resolveMarkupTarget(2.5, 2.7)).toBe(2.5);
    expect(resolveMarkupTarget(null, 2.7)).toBe(2.7);
    expect(resolveMarkupTarget(null, null)).toBe(DEFAULT_TARGET_MARKUP_RATIO);
  });
});
