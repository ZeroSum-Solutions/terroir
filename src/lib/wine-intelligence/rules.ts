/**
 * Static varietal/region rules for drink windows and serving temperatures.
 * Fallback when no LWIN match is found.
 *
 * drinkWindow offsets are years from vintage.
 * servingTemp values are in Fahrenheit.
 */

export type WineRule = {
  match: { varietal?: string; region?: string; colour?: string };
  drinkWindow: { offsetStart: number; offsetEnd: number };
  servingTemp: { min: number; max: number; label: string };
};

// Match priority: more specific (varietal + region) wins over varietal-only
export const WINE_RULES: WineRule[] = [
  // ── Red — Specific regions ──────────────────────────────────────
  { match: { varietal: "cabernet sauvignon", region: "napa" }, drinkWindow: { offsetStart: 5, offsetEnd: 20 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "cabernet sauvignon", region: "bordeaux" }, drinkWindow: { offsetStart: 5, offsetEnd: 25 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "pinot noir", region: "burgundy" }, drinkWindow: { offsetStart: 3, offsetEnd: 15 }, servingTemp: { min: 55, max: 60, label: "Slightly below room temperature" } },
  { match: { varietal: "pinot noir", region: "oregon" }, drinkWindow: { offsetStart: 3, offsetEnd: 12 }, servingTemp: { min: 55, max: 60, label: "Slightly below room temperature" } },
  { match: { varietal: "nebbiolo", region: "piedmont" }, drinkWindow: { offsetStart: 7, offsetEnd: 25 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "sangiovese", region: "tuscany" }, drinkWindow: { offsetStart: 4, offsetEnd: 15 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "tempranillo", region: "rioja" }, drinkWindow: { offsetStart: 4, offsetEnd: 18 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "malbec", region: "mendoza" }, drinkWindow: { offsetStart: 2, offsetEnd: 10 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "syrah", region: "rhone" }, drinkWindow: { offsetStart: 4, offsetEnd: 15 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },

  // ── Red — Generic varietals ─────────────────────────────────────
  { match: { varietal: "cabernet sauvignon" }, drinkWindow: { offsetStart: 4, offsetEnd: 15 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "pinot noir" }, drinkWindow: { offsetStart: 2, offsetEnd: 10 }, servingTemp: { min: 55, max: 60, label: "Slightly below room temperature" } },
  { match: { varietal: "merlot" }, drinkWindow: { offsetStart: 3, offsetEnd: 12 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "syrah" }, drinkWindow: { offsetStart: 3, offsetEnd: 12 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "shiraz" }, drinkWindow: { offsetStart: 3, offsetEnd: 12 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "zinfandel" }, drinkWindow: { offsetStart: 2, offsetEnd: 8 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "nebbiolo" }, drinkWindow: { offsetStart: 5, offsetEnd: 20 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "sangiovese" }, drinkWindow: { offsetStart: 3, offsetEnd: 12 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "tempranillo" }, drinkWindow: { offsetStart: 3, offsetEnd: 15 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "malbec" }, drinkWindow: { offsetStart: 2, offsetEnd: 8 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "grenache" }, drinkWindow: { offsetStart: 2, offsetEnd: 8 }, servingTemp: { min: 58, max: 63, label: "Cool room temperature" } },
  { match: { varietal: "mourvèdre" }, drinkWindow: { offsetStart: 3, offsetEnd: 12 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },
  { match: { varietal: "barbera" }, drinkWindow: { offsetStart: 2, offsetEnd: 7 }, servingTemp: { min: 58, max: 63, label: "Slightly below room temperature" } },
  { match: { varietal: "gamay" }, drinkWindow: { offsetStart: 1, offsetEnd: 5 }, servingTemp: { min: 55, max: 58, label: "Lightly chilled" } },
  { match: { varietal: "cabernet franc" }, drinkWindow: { offsetStart: 3, offsetEnd: 12 }, servingTemp: { min: 58, max: 63, label: "Slightly below room temperature" } },
  { match: { varietal: "petite sirah" }, drinkWindow: { offsetStart: 3, offsetEnd: 12 }, servingTemp: { min: 60, max: 65, label: "Cool room temperature" } },

  // ── White — Specific regions ────────────────────────────────────
  { match: { varietal: "chardonnay", region: "burgundy" }, drinkWindow: { offsetStart: 3, offsetEnd: 12 }, servingTemp: { min: 50, max: 55, label: "Cool cellar temperature" } },
  { match: { varietal: "riesling", region: "alsace" }, drinkWindow: { offsetStart: 3, offsetEnd: 15 }, servingTemp: { min: 46, max: 50, label: "Well chilled" } },
  { match: { varietal: "riesling", region: "mosel" }, drinkWindow: { offsetStart: 3, offsetEnd: 20 }, servingTemp: { min: 46, max: 50, label: "Well chilled" } },

  // ── White — Generic varietals ───────────────────────────────────
  { match: { varietal: "chardonnay" }, drinkWindow: { offsetStart: 1, offsetEnd: 5 }, servingTemp: { min: 48, max: 54, label: "Chilled" } },
  { match: { varietal: "sauvignon blanc" }, drinkWindow: { offsetStart: 1, offsetEnd: 3 }, servingTemp: { min: 45, max: 50, label: "Well chilled" } },
  { match: { varietal: "riesling" }, drinkWindow: { offsetStart: 2, offsetEnd: 10 }, servingTemp: { min: 45, max: 50, label: "Well chilled" } },
  { match: { varietal: "pinot grigio" }, drinkWindow: { offsetStart: 1, offsetEnd: 3 }, servingTemp: { min: 45, max: 48, label: "Well chilled" } },
  { match: { varietal: "pinot gris" }, drinkWindow: { offsetStart: 1, offsetEnd: 4 }, servingTemp: { min: 45, max: 50, label: "Well chilled" } },
  { match: { varietal: "viognier" }, drinkWindow: { offsetStart: 1, offsetEnd: 4 }, servingTemp: { min: 48, max: 52, label: "Chilled" } },
  { match: { varietal: "gewürztraminer" }, drinkWindow: { offsetStart: 1, offsetEnd: 5 }, servingTemp: { min: 46, max: 50, label: "Well chilled" } },
  { match: { varietal: "chenin blanc" }, drinkWindow: { offsetStart: 2, offsetEnd: 10 }, servingTemp: { min: 46, max: 50, label: "Well chilled" } },
  { match: { varietal: "grüner veltliner" }, drinkWindow: { offsetStart: 1, offsetEnd: 5 }, servingTemp: { min: 46, max: 50, label: "Well chilled" } },
  { match: { varietal: "albariño" }, drinkWindow: { offsetStart: 1, offsetEnd: 3 }, servingTemp: { min: 45, max: 48, label: "Well chilled" } },
  { match: { varietal: "vermentino" }, drinkWindow: { offsetStart: 1, offsetEnd: 3 }, servingTemp: { min: 45, max: 48, label: "Well chilled" } },
  { match: { varietal: "marsanne" }, drinkWindow: { offsetStart: 2, offsetEnd: 8 }, servingTemp: { min: 48, max: 52, label: "Chilled" } },
  { match: { varietal: "roussanne" }, drinkWindow: { offsetStart: 2, offsetEnd: 8 }, servingTemp: { min: 48, max: 52, label: "Chilled" } },
  { match: { varietal: "semillon" }, drinkWindow: { offsetStart: 2, offsetEnd: 10 }, servingTemp: { min: 48, max: 52, label: "Chilled" } },

  // ── Rosé ────────────────────────────────────────────────────────
  { match: { colour: "rosé" }, drinkWindow: { offsetStart: 0, offsetEnd: 2 }, servingTemp: { min: 45, max: 50, label: "Well chilled" } },

  // ── Sparkling ───────────────────────────────────────────────────
  { match: { varietal: "champagne" }, drinkWindow: { offsetStart: 2, offsetEnd: 10 }, servingTemp: { min: 42, max: 47, label: "Ice cold" } },
  { match: { varietal: "prosecco" }, drinkWindow: { offsetStart: 0, offsetEnd: 2 }, servingTemp: { min: 40, max: 45, label: "Ice cold" } },
  { match: { varietal: "cava" }, drinkWindow: { offsetStart: 0, offsetEnd: 3 }, servingTemp: { min: 42, max: 47, label: "Ice cold" } },
  { match: { colour: "sparkling" }, drinkWindow: { offsetStart: 0, offsetEnd: 3 }, servingTemp: { min: 42, max: 47, label: "Ice cold" } },

  // ── Dessert / Fortified ─────────────────────────────────────────
  { match: { varietal: "port" }, drinkWindow: { offsetStart: 5, offsetEnd: 40 }, servingTemp: { min: 58, max: 64, label: "Slightly below room temperature" } },
  { match: { varietal: "sherry" }, drinkWindow: { offsetStart: 0, offsetEnd: 5 }, servingTemp: { min: 50, max: 55, label: "Cool cellar temperature" } },
  { match: { varietal: "sauternes" }, drinkWindow: { offsetStart: 5, offsetEnd: 30 }, servingTemp: { min: 46, max: 50, label: "Well chilled" } },
  { match: { varietal: "madeira" }, drinkWindow: { offsetStart: 5, offsetEnd: 50 }, servingTemp: { min: 55, max: 60, label: "Cool cellar temperature" } },

  // ── Broad fallbacks by colour ───────────────────────────────────
  { match: { colour: "red" }, drinkWindow: { offsetStart: 2, offsetEnd: 10 }, servingTemp: { min: 58, max: 65, label: "Cool room temperature" } },
  { match: { colour: "white" }, drinkWindow: { offsetStart: 1, offsetEnd: 4 }, servingTemp: { min: 45, max: 52, label: "Chilled" } },
];
