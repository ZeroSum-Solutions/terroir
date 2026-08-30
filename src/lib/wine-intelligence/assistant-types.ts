// Wire types shared by /api/assistant and the client panel.

import type { AssistantQuery } from "./assistant-query";
import type { AssistantCellarWine } from "./assistant-match";

export type { AssistantCellarWine };

/** A corpus wine offered when the cellar itself holds nothing that matches. */
export interface AssistantCorpusWine {
  wineId: number;
  name: string;
  winery: string | null;
  country: string | null;
  region: string | null;
  type: string | null;
  body: string | null;
  grapes: string[];
  pairings: string[];
  ratingAvg: number | null;
  ratingCount: number | null;
  imageUrl: string | null;
  imageKind: string | null;
}

export interface AssistantResponse {
  /** Echoed so the UI can show exactly which constraints were read. */
  query: AssistantQuery;
  /** Matches from the tenant's own cellar, best first. */
  cellar: AssistantCellarWine[];
  /** How many cellar wines matched before the response was truncated. */
  cellarTotal: number;
  /**
   * Reference-corpus wines matching the same query. Populated ONLY when the
   * cellar had no match, and labelled as not-in-your-cellar by the UI — it is
   * an answer to "what would fit", never a claim of stock.
   */
  corpus: AssistantCorpusWine[];
}
