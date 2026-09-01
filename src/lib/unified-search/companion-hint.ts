// The one-box search's hand-off to the companion (unified-search program,
// slice 2c/3b follow-up).
//
// GET /api/search (route.ts) filters on the facts its own parser recognises
// — vintage, country, region, colour (query-parse.ts) — and falls back to
// trigram-matching the raw text when it recognises nothing. Price and food
// pairing are not among the facts it can filter on at all: the corpora it
// reads have no price column to filter, and "pairing" is a concept this
// route's parser has never modelled. So a query that carries either used to
// fall straight into the trigram fallback and come back full of loose
// word-matches instead of an honest answer or a route to the surface that
// CAN answer it — /api/assistant, whose parseAssistantQuery already reads a
// price bound and a pairing out of that same sentence today.
//
// This module is that check, run in front of the search response: does the
// query carry a price bound or a pairing phrase? If so, the palette offers
// the companion ALONGSIDE whatever the trigram pass returns — not only when
// that pass comes back empty, which is the existing all-scope-miss CTA this
// module leaves untouched.
//
// VOCABULARY-FREE by construction: no word list of its own. It calls the
// assistant's own price parser and its own pairing phrase table
// (assistant-query.ts / assistant-lexicon.ts) — the exact reading the
// assistant would give the same sentence — rather than re-deciding what a
// price or a pairing looks like. It never touches tenant data: a pure
// function of the query string alone, same contract as the parser it
// borrows from (assistant-query.ts's header, D-006b).

import { matchPhrases, normalize, PAIRING_PHRASES } from "@/lib/wine-intelligence/assistant-lexicon";
import { parsePrice } from "@/lib/wine-intelligence/assistant-query";

export type CompanionReason = "price" | "pairing";

export interface CompanionHint {
  suggested: boolean;
  reasons: CompanionReason[];
}

const NO_HINT: CompanionHint = { suggested: false, reasons: [] };

/**
 * Whether `query` carries a dimension GET /api/search cannot answer at all.
 * Never throws, never queries anything — a function of the text alone.
 */
export function companionHint(query: string): CompanionHint {
  const raw = query ?? "";
  const normalized = normalize(raw);
  if (!normalized) return NO_HINT;
  const words = normalized.split(" ").filter(Boolean);

  const reasons: CompanionReason[] = [];

  const price = parsePrice(raw, normalized);
  if (price.priceMin != null || price.priceMax != null) reasons.push("price");

  const pairingHit = PAIRING_PHRASES.some(({ phrases }) => {
    const match = matchPhrases(words, phrases);
    return match !== null && !match.negated;
  });
  if (pairingHit) reasons.push("pairing");

  return reasons.length > 0 ? { suggested: true, reasons } : NO_HINT;
}
