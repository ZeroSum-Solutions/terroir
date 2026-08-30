// Selection for the wine assistant: applies a parsed AssistantQuery to the
// tenant's own cellar rows.
//
// Pure and synchronous by design. The cellar is a few hundred rows, so the
// caller fetches them once (RLS-scoped) and filters here, which keeps the
// whole decision — including every tie-break an investor might ask about —
// inspectable and unit-testable, with no query builder in the way.
//
// The one rule worth stating outright: a query that understood NOTHING
// matches nothing. Returning the unfiltered cellar there would render a
// confident-looking answer to a question the parser never read.

import { foldAccents } from "./name-resolver";
import type { AssistantQuery } from "./assistant-query";

export interface AssistantCellarWine {
  wineId: string;
  name: string;
  producer: string | null;
  vintage: number | null;
  /** The cellar's own colour, used when a wine has no corpus row. */
  colour: string | null;
  country: string | null;
  region: string | null;
  varietal: string | null;
  /** retail_median, in dollars. Null when the wine has never been priced. */
  price: number | null;
  onHand: number;
  /** Corpus attributes; null when the wine does not resolve to the corpus. */
  type: string | null;
  body: string | null;
  grapes: string[];
  pairings: string[];
  ratingAvg: number | null;
  ratingCount: number | null;
  imageUrl: string | null;
  /** xwines_catalog.elaborate: "Varietal/100%" or an "Assemblage/..." value. */
  elaborate: string | null;
}

/** Case- and accent-insensitive comparison, so "serra gaucha" finds "Serra
 * Gaúcha" — the same fold the parser applied to the user's text. */
function sameValue(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return foldAccents(a).toLowerCase().trim() === foldAccents(b).toLowerCase().trim();
}

// The cellar's `colour` and the corpus's `type` are different vocabularies for
// the same idea. A wine that never resolved to the corpus still has a colour,
// and answering "show me a sparkling" by silently dropping it would hide
// stock the sommelier can see on the shelf.
const COLOUR_TO_TYPE: Readonly<Record<string, string>> = {
  red: "Red",
  white: "White",
  sparkling: "Sparkling",
  rose: "Rosé",
  dessert: "Dessert",
  fortified: "Dessert/Port",
};

function matchesType(wine: AssistantCellarWine, wanted: string): boolean {
  if (wine.type) return sameValue(wine.type, wanted);
  const mapped = COLOUR_TO_TYPE[(wine.colour ?? "").toLowerCase()];
  return mapped ? sameValue(mapped, wanted) : false;
}

function matchesGrape(wine: AssistantCellarWine, wanted: string): boolean {
  if (sameValue(wine.varietal, wanted)) return true;
  return wine.grapes.some((g) => sameValue(g, wanted));
}

/**
 * The cellar wines that satisfy every understood dimension of `query`.
 *
 * Dimensions are ANDed (each one narrows), but a multi-value `pairing` is
 * ORed within itself — "fish" legitimately means Rich Fish OR Lean Fish, and
 * requiring both would answer with an empty cellar.
 */
export function selectCellarMatches(
  wines: readonly AssistantCellarWine[],
  query: AssistantQuery,
): AssistantCellarWine[] {
  if (query.understood.length === 0) return [];

  const matched = wines.filter((wine) => {
    if (query.type && !matchesType(wine, query.type)) return false;
    if (query.body && !sameValue(wine.body, query.body)) return false;
    if (query.country && !sameValue(wine.country, query.country)) return false;
    if (query.region && !sameValue(wine.region, query.region)) return false;
    if (query.grape && !matchesGrape(wine, query.grape)) return false;

    // Unknown is not "not a blend": a wine with no corpus row is excluded
    // from BOTH answers rather than guessed into one of them.
    if (query.blend != null) {
      if (!wine.elaborate) return false;
      const isBlend = wine.elaborate.toLowerCase().startsWith("assemblage");
      if (isBlend !== query.blend) return false;
    }

    if (query.pairing && query.pairing.length > 0) {
      const hit = query.pairing.some((p) => wine.pairings.some((wp) => sameValue(wp, p)));
      if (!hit) return false;
    }

    // A price bound excludes an unpriced wine rather than admitting it: there
    // is no honest way to show a NULL price as being inside a band.
    if (query.priceMin != null || query.priceMax != null) {
      if (wine.price == null) return false;
      if (query.priceMin != null && wine.price < query.priceMin) return false;
      if (query.priceMax != null && wine.price > query.priceMax) return false;
    }

    return true;
  });

  // In-stock first (an out-of-stock recommendation is not actionable mid
  // service), then community rating, then depth of stock. Out-of-stock wines
  // are ordered last but kept — the sommelier may still want to know the
  // cellar holds the right wine and needs reordering.
  return matched.sort((a, b) => {
    const stock = Number(b.onHand > 0) - Number(a.onHand > 0);
    if (stock !== 0) return stock;
    const rating = (b.ratingAvg ?? 0) - (a.ratingAvg ?? 0);
    if (rating !== 0) return rating;
    return b.onHand - a.onHand;
  });
}
