import { WINE_RULES, type WineRule } from "./rules";

export type WineData = {
  varietal: string | null;
  region: string | null;
  country: string | null;
  vintage: number | null;
};

export type RatingSource =
  | "rule_engine"
  | "claude_inference"
  | "vinous"
  | "parker"
  | "js"
  | "wine_spectator"
  | "decanter"
  | "aggregate";

export type EnrichmentResult = {
  drinkWindowStart: number | null;
  drinkWindowEnd: number | null;
  // BND-039: peak year + rating source make per-wine intelligence visible
  // in the drawer + briefing alert. Rule-engine doesn't produce a rating,
  // so `rating` stays null until a Phase-2 critic source is wired.
  peakYear: number | null;
  ratingSource: RatingSource | null;
  reviewExcerpt: string | null;
  servingTempMin: number | null;
  servingTempMax: number | null;
  servingTempLabel: string | null;
  decantMinutes: number | null;
};

function normalize(s: string | null): string {
  return (s ?? "").toLowerCase().trim();
}

function matchesField(ruleValue: string | undefined, wineValue: string): boolean {
  if (!ruleValue) return true; // no constraint = matches anything
  return wineValue.includes(ruleValue);
}

/**
 * Find the best matching rule for a wine. More specific matches win.
 */
function findRule(wine: WineData): WineRule | null {
  const varietal = normalize(wine.varietal);
  const region = normalize(wine.region);

  let bestRule: WineRule | null = null;
  let bestScore = -1;

  for (const rule of WINE_RULES) {
    let score = 0;

    // Check varietal match
    if (rule.match.varietal) {
      if (!matchesField(rule.match.varietal, varietal)) continue;
      score += 2;
    }

    // Check region match
    if (rule.match.region) {
      if (!matchesField(rule.match.region, region)) continue;
      score += 3; // region is more specific
    }

    // Check colour match (broad fallback)
    if (rule.match.colour) {
      // We infer colour from varietal since we don't have a colour field on wines
      const colour = inferColour(varietal);
      if (!matchesField(rule.match.colour, colour)) continue;
      score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }

  return bestRule;
}

/**
 * Infer wine colour from varietal name.
 */
function inferColour(varietal: string): string {
  const reds = [
    "cabernet", "merlot", "pinot noir", "syrah", "shiraz", "malbec",
    "zinfandel", "nebbiolo", "sangiovese", "tempranillo", "grenache",
    "mourvèdre", "barbera", "gamay", "cabernet franc", "petite sirah",
    "carmenere", "pinotage", "touriga",
  ];
  const whites = [
    "chardonnay", "sauvignon blanc", "riesling", "pinot grigio", "pinot gris",
    "viognier", "gewürztraminer", "chenin blanc", "grüner veltliner",
    "albariño", "vermentino", "marsanne", "roussanne", "semillon",
    "muscadet", "trebbiano", "garganega", "fiano",
  ];
  const sparkling = ["champagne", "prosecco", "cava", "crémant", "franciacorta"];
  const rose = ["rosé", "rose"];

  if (sparkling.some((s) => varietal.includes(s))) return "sparkling";
  if (rose.some((r) => varietal.includes(r))) return "rosé";
  if (reds.some((r) => varietal.includes(r))) return "red";
  if (whites.some((w) => varietal.includes(w))) return "white";
  return "";
}

/**
 * Enrich a wine with drink window and serving temperature data.
 *
 * BND-039 additions: when a rule matches, also returns `peakYear`
 * (midpoint of the offset range) and `ratingSource: 'rule_engine'`.
 * `rating` stays null — rule engine doesn't produce a numeric score.
 * Wines with no rule match return all-null and become candidates for
 * the Claude inference fallback in `enrich-claude.ts`.
 */
export function enrichWine(wine: WineData): EnrichmentResult {
  const rule = findRule(wine);

  if (!rule) {
    return {
      drinkWindowStart: null,
      drinkWindowEnd: null,
      peakYear: null,
      ratingSource: null,
      reviewExcerpt: null,
      servingTempMin: null,
      servingTempMax: null,
      servingTempLabel: null,
      decantMinutes: null,
    };
  }

  const drinkWindowStart = wine.vintage
    ? wine.vintage + rule.drinkWindow.offsetStart
    : null;
  const drinkWindowEnd = wine.vintage
    ? wine.vintage + rule.drinkWindow.offsetEnd
    : null;

  // Peak is the midpoint of the optimal range. We don't store an
  // explicit `peakOffset` on rules (rules.ts is intentionally minimal —
  // the rule engine is a coarse fallback, not a critic). For wines
  // where peak position matters more (e.g., Bordeaux that drinks well
  // young AND old), Phase 2 critic data will overwrite this.
  const peakYear =
    drinkWindowStart != null && drinkWindowEnd != null
      ? Math.round((drinkWindowStart + drinkWindowEnd) / 2)
      : null;

  return {
    drinkWindowStart,
    drinkWindowEnd,
    peakYear,
    ratingSource: "rule_engine",
    reviewExcerpt: null,
    servingTempMin: rule.servingTemp.min,
    servingTempMax: rule.servingTemp.max,
    servingTempLabel: rule.servingTemp.label,
    decantMinutes: rule.decantMinutes,
  };
}
