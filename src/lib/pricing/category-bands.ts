/**
 * BND-040 — Category-aware pricing bands.
 *
 * Lookup tables for default markup and pour-cost bands keyed on
 * varietal/region/critic-score tier. Per the architect-review and
 * Plan-agent critique: a universal 2.5–3× markup default would flag
 * every Krug and DRC as "underpriced." Champagne lists ~2×, grower
 * Burgundy ~1.8×, BTG Pinot 4×+. Different wines, different bands.
 *
 * When a wine matches multiple rules, the most specific match wins
 * (varietal + region + critic-score > varietal + region > varietal).
 *
 * "No band" when nothing matches — surfaces show "Insufficient data
 * for a category benchmark on this wine" and fall back to the user's
 * house default. Never make up a band.
 */

export type CategoryBand = {
  /** Lower bound of typical bottle markup ratio for this category. */
  markupLow: number;
  /** Upper bound of typical bottle markup ratio. */
  markupHigh: number;
  /** Lower bound of typical pour cost % for this category. */
  pourCostLow: number;
  /** Upper bound of typical pour cost %. */
  pourCostHigh: number;
  /** Human-readable label for the band ("Bordeaux 1ère", etc.). */
  label: string;
};

type CategoryRule = {
  /** Varietal substring match (lowercase; null means any). */
  varietal?: string;
  /** Region substring match (lowercase; null means any). */
  region?: string;
  /** Min critic rating for this rule to apply (Parker scale; null means any). */
  ratingMin?: number;
  /** The band returned when the rule matches. */
  band: CategoryBand;
};

/** Match priority: more specific rules earlier — first match wins. */
const RULES: readonly CategoryRule[] = [
  // ── Specific high-allocation tiers first ──
  {
    varietal: "champagne",
    band: {
      markupLow: 1.8,
      markupHigh: 2.5,
      pourCostLow: 24,
      pourCostHigh: 30,
      label: "Champagne",
    },
  },
  {
    region: "champagne",
    band: {
      markupLow: 1.8,
      markupHigh: 2.5,
      pourCostLow: 24,
      pourCostHigh: 30,
      label: "Champagne",
    },
  },

  // ── Burgundy (allocation-driven, lower markup) ──
  {
    region: "burgundy",
    band: {
      markupLow: 2.0,
      markupHigh: 2.8,
      pourCostLow: 22,
      pourCostHigh: 28,
      label: "Burgundy",
    },
  },
  {
    varietal: "pinot noir",
    region: "burgundy",
    band: {
      markupLow: 2.0,
      markupHigh: 2.8,
      pourCostLow: 22,
      pourCostHigh: 28,
      label: "Burgundy red",
    },
  },
  {
    varietal: "chardonnay",
    region: "burgundy",
    band: {
      markupLow: 2.0,
      markupHigh: 2.8,
      pourCostLow: 22,
      pourCostHigh: 28,
      label: "Burgundy white",
    },
  },

  // ── Bordeaux 1ères / icon Bordeaux (rating ≥ 95) ──
  {
    region: "bordeaux",
    ratingMin: 95,
    band: {
      markupLow: 2.0,
      markupHigh: 2.6,
      pourCostLow: 22,
      pourCostHigh: 28,
      label: "Bordeaux 1ère",
    },
  },
  {
    region: "pauillac",
    ratingMin: 95,
    band: {
      markupLow: 2.0,
      markupHigh: 2.6,
      pourCostLow: 22,
      pourCostHigh: 28,
      label: "Pauillac (icon)",
    },
  },

  // ── Generic Bordeaux ──
  {
    region: "bordeaux",
    band: {
      markupLow: 2.4,
      markupHigh: 3.2,
      pourCostLow: 20,
      pourCostHigh: 26,
      label: "Bordeaux",
    },
  },

  // ── Italian — Piedmont (Barolo, Barbaresco) ──
  {
    region: "piedmont",
    band: {
      markupLow: 2.3,
      markupHigh: 3.0,
      pourCostLow: 22,
      pourCostHigh: 28,
      label: "Piedmont",
    },
  },
  {
    varietal: "nebbiolo",
    band: {
      markupLow: 2.3,
      markupHigh: 3.0,
      pourCostLow: 22,
      pourCostHigh: 28,
      label: "Nebbiolo",
    },
  },

  // ── Italian — Tuscany (Super Tuscans, Brunello, Chianti Classico) ──
  {
    region: "tuscany",
    ratingMin: 95,
    band: {
      markupLow: 2.0,
      markupHigh: 2.6,
      pourCostLow: 22,
      pourCostHigh: 28,
      label: "Super Tuscan / icon",
    },
  },
  {
    region: "tuscany",
    band: {
      markupLow: 2.5,
      markupHigh: 3.3,
      pourCostLow: 20,
      pourCostHigh: 26,
      label: "Tuscany",
    },
  },

  // ── Rhône ──
  {
    region: "rhone",
    band: {
      markupLow: 2.4,
      markupHigh: 3.2,
      pourCostLow: 20,
      pourCostHigh: 26,
      label: "Rhône",
    },
  },

  // ── Generic varietal fallbacks ──
  {
    varietal: "cabernet sauvignon",
    band: {
      markupLow: 3.0,
      markupHigh: 4.0,
      pourCostLow: 16,
      pourCostHigh: 20,
      label: "Cabernet Sauvignon",
    },
  },
  {
    varietal: "pinot noir",
    band: {
      markupLow: 2.8,
      markupHigh: 3.6,
      pourCostLow: 18,
      pourCostHigh: 22,
      label: "Pinot Noir",
    },
  },
  {
    varietal: "chardonnay",
    band: {
      markupLow: 2.8,
      markupHigh: 3.5,
      pourCostLow: 18,
      pourCostHigh: 22,
      label: "Chardonnay",
    },
  },
  {
    varietal: "sauvignon blanc",
    band: {
      markupLow: 3.0,
      markupHigh: 4.0,
      pourCostLow: 16,
      pourCostHigh: 20,
      label: "Sauvignon Blanc",
    },
  },
  {
    varietal: "riesling",
    band: {
      markupLow: 2.8,
      markupHigh: 3.5,
      pourCostLow: 18,
      pourCostHigh: 22,
      label: "Riesling",
    },
  },
  {
    varietal: "syrah",
    band: {
      markupLow: 2.8,
      markupHigh: 3.6,
      pourCostLow: 18,
      pourCostHigh: 22,
      label: "Syrah",
    },
  },
  {
    varietal: "shiraz",
    band: {
      markupLow: 2.8,
      markupHigh: 3.6,
      pourCostLow: 18,
      pourCostHigh: 22,
      label: "Shiraz",
    },
  },
  {
    varietal: "merlot",
    band: {
      markupLow: 2.8,
      markupHigh: 3.6,
      pourCostLow: 18,
      pourCostHigh: 22,
      label: "Merlot",
    },
  },
];

function normalize(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

/**
 * Look up the category band for a wine. Returns null when nothing matches.
 *
 * Wines without a matching rule fall back to the user's house default
 * — surfaces display "Insufficient data for a category benchmark"
 * (per architect-review finding 4 in BND-040 plan).
 */
export function getCategoryBand(wine: {
  varietal?: string | null;
  region?: string | null;
  rating?: number | null;
}): CategoryBand | null {
  const varietal = normalize(wine.varietal);
  const region = normalize(wine.region);
  const rating = wine.rating ?? 0;

  for (const rule of RULES) {
    if (rule.varietal && !varietal.includes(rule.varietal)) continue;
    if (rule.region && !region.includes(rule.region)) continue;
    if (rule.ratingMin != null && rating < rule.ratingMin) continue;
    return rule.band;
  }
  return null;
}

/**
 * Convenience: returns the band's midpoint markup, intended as a "target"
 * when no per-wine or restaurant override is set. Renders gracefully when
 * the wine has no category match (caller falls back to house default).
 */
export function getCategoryMidpointMarkup(wine: {
  varietal?: string | null;
  region?: string | null;
  rating?: number | null;
}): number | null {
  const band = getCategoryBand(wine);
  if (!band) return null;
  return (band.markupLow + band.markupHigh) / 2;
}

export function getCategoryMidpointPourCost(wine: {
  varietal?: string | null;
  region?: string | null;
  rating?: number | null;
}): number | null {
  const band = getCategoryBand(wine);
  if (!band) return null;
  return (band.pourCostLow + band.pourCostHigh) / 2;
}
