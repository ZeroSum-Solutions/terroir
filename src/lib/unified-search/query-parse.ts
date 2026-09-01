// The typed-search query parser (program plan D1).
//
// GET /api/search has never parsed its query: `q` goes whole to ILIKE and to
// the trigram RPCs, so "crisp white from Portugal" matches any row whose
// name happens to contain one of those words, and "2016" is just five
// characters of trigram noise. This module turns that text into the parts a
// search can actually act on.
//
// THE SPLIT THAT MATTERS (D1): a FILTER is a fact a row either has or hasn't
// — a vintage, a country, a region, a colour. A PREFERENCE is a matter of
// degree — how full-bodied a wine is. Filters may exclude; preferences may
// only rank. The reason is honesty about missing data: body is recorded for
// a fraction of the corpus, so excluding on "crisp" would answer "you have
// nothing crisp" when the truth is "we don't know how most of these taste".
//
// The parser does NOT judge whether a leftover word is a real wine name. It
// has no producer dictionary, so "chateau" and "zzqqxx" are the same kind of
// thing to it: text for the search to try. What it does report is whether it
// recognised anything at all (`understood`) — which is what lets the palette
// tell "we filtered and genuinely found nothing" apart from "we never
// understood the question, ask the companion instead". Claiming to know
// which words were nonsense would be a confident answer to a question
// nobody asked.
//
// Scope note: this module only READS. Wiring it into the endpoint is a
// separate slice, because filtering trigram RPC results after the fact would
// drop matches the RPC ranked below its limit — that needs the RPC to take
// the filters, which is a migration.

import {
  BODY_INDEX,
  COLOUR_INDEX,
  COUNTRY_INDEX,
  FILLER_TERMS,
  MAX_PHRASE_WORDS,
  REGION_INDEX,
  foldTerm,
  type GazetteerEntry,
} from "./wine-gazetteer";

/** Facts a row either has or hasn't. These may exclude a row. */
export type SearchFilters = {
  vintages: number[];
  countries: string[];
  regions: string[];
  colours: string[];
};

/** Matters of degree. These may only rank a row, never exclude it. */
export type SearchPreferences = {
  body: string[];
};

export type ParsedSearchQuery = {
  filters: SearchFilters;
  preferences: SearchPreferences;
  /** What is left to match as text — the part naming a wine, not describing one. */
  text: string;
  /** Whether anything at all was recognised — a different sentence to the user. */
  understood: boolean;
};

/**
 * The oldest vintage worth reading as one. Older bottles exist, but a
 * four-digit number below this in a wine search is far likelier to be a
 * street address or a cuvée name than a year.
 */
const OLDEST_VINTAGE = 1850;

/** Futures are sold ahead of release, so next year and the one after count. */
function newestVintage(): number {
  return new Date().getUTCFullYear() + 2;
}

/** A bare four-digit number, not one glued to units like "1500ml". */
const YEAR_TOKEN = /^\d{4}$/;

type Token = { raw: string; folded: string };

function tokenize(query: string): Token[] {
  return query
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((raw) => ({ raw, folded: foldTerm(raw) }))
    .filter((token) => token.folded !== "");
}

/** Longest phrase starting at `start` that any of these indexes knows. */
function matchPhrase(
  tokens: Token[],
  start: number,
  indexes: ReadonlyArray<[ReadonlyMap<string, GazetteerEntry>, keyof Buckets]>,
): { entry: GazetteerEntry; bucket: keyof Buckets; length: number } | null {
  const maxLength = Math.min(MAX_PHRASE_WORDS, tokens.length - start);
  // Longest first: "new zealand" must win over "new", and "napa valley" over
  // "napa" — a shorter win would leave a stray word in the needle.
  for (let length = maxLength; length >= 1; length--) {
    const phrase = tokens
      .slice(start, start + length)
      .map((token) => token.folded)
      .join(" ");
    for (const [index, bucket] of indexes) {
      const entry = index.get(phrase);
      if (entry !== undefined) return { entry, bucket, length };
    }
  }
  return null;
}

/**
 * Words that flip a recognised filter word from "wanted" to "ruled out" —
 * the same idea as the assistant parser's NEGATION_PHRASES
 * (wine-intelligence/assistant-lexicon.ts), reimplemented locally on this
 * module's own token model rather than imported: the two parsers fold text
 * differently (this one keeps punctuation other than diacritics; the
 * assistant strips it to spaces), so sharing the check would couple two
 * modules whose matching engines this file's header already keeps separate
 * on purpose. Single words only — "other than"/"anything but" are not
 * covered, matching this module's existing preference for simple, auditable
 * rules over exhaustive phrase coverage.
 *
 * Without this, "no reds tonight" filtered TO reds — the exact inverse of
 * the question, presented with total confidence (colours: ["Red"],
 * understood: true). That is the same confident-wrong-answer class the
 * assistant parser's own negation fix (assistant-lexicon.ts) removed there;
 * it had simply never been ported to this module.
 */
const NEGATION_TOKENS: ReadonlySet<string> = new Set([
  "not", "no", "nothing", "nothin", "without", "except", "excluding", "besides",
  "isnt", "arent", "dont", "doesnt", "didnt", "wasnt", "werent", "wont", "cant",
  "avoid", "avoiding", "skip",
]);

/** How far back a negation may reach before a recognised filter word — the
 *  same bound the assistant parser uses, for the same reason: unbounded
 *  lookback would let one "no" at the start of a long query silently
 *  swallow every filter after it. */
const NEGATION_LOOKBACK = 6;

/** Whether a negation reaches the token at `index` — walking backward
 *  through filler words exactly as the assistant parser's isNegated does,
 *  stopping at the first word that is neither a negation nor filler (a
 *  content word ends the negation's reach). */
function isNegatedAt(tokens: readonly Token[], index: number): boolean {
  // foldTerm() already strips punctuation (including "'"), so "isn't" is
  // folded to "isnt" before this ever runs — no separate stripping needed
  // here to match a contraction against NEGATION_TOKENS.
  for (let i = index - 1, steps = 0; i >= 0 && steps < NEGATION_LOOKBACK; i--, steps++) {
    if (NEGATION_TOKENS.has(tokens[i]!.folded)) return true;
    if (!FILLER_TERMS.has(tokens[i]!.folded)) return false;
  }
  return false;
}

type Buckets = {
  countries: string[];
  regions: string[];
  colours: string[];
  body: string[];
};

function push(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
  const tokens = tokenize(query);
  const buckets: Buckets = { countries: [], regions: [], colours: [], body: [] };
  const vintages: number[] = [];
  const needle: string[] = [];

  // Countries before regions so "Georgia" reads as the country; colour and
  // body last because their words are the least likely to name a place.
  const indexes: ReadonlyArray<[ReadonlyMap<string, GazetteerEntry>, keyof Buckets]> = [
    [COUNTRY_INDEX, "countries"],
    [REGION_INDEX, "regions"],
    [COLOUR_INDEX, "colours"],
    [BODY_INDEX, "body"],
  ];

  const newest = newestVintage();
  let cursor = 0;
  while (cursor < tokens.length) {
    const token = tokens[cursor]!;

    if (YEAR_TOKEN.test(token.folded)) {
      const year = Number(token.folded);
      if (year >= OLDEST_VINTAGE && year <= newest) {
        if (!vintages.includes(year)) vintages.push(year);
        cursor += 1;
        continue;
      }
      // Out of range: not a vintage. Search for it as text rather than
      // building a filter that can only ever match nothing.
      needle.push(token.raw);
      cursor += 1;
      continue;
    }

    const phrase = matchPhrase(tokens, cursor, indexes);
    if (phrase !== null) {
      if (isNegatedAt(tokens, cursor)) {
        // A ruled-out fact is not a filter (D1: filters may exclude, so a
        // wrong one is worse than a missing one). Its words fall through to
        // the needle instead of vanishing, so they are still searched as
        // text — the same choice this module already makes for an
        // out-of-range vintage a few lines up.
        for (let i = cursor; i < cursor + phrase.length; i++) needle.push(tokens[i]!.raw);
        cursor += phrase.length;
        continue;
      }
      push(buckets[phrase.bucket], phrase.entry.canonical);
      cursor += phrase.length;
      continue;
    }

    if (FILLER_TERMS.has(token.folded)) {
      cursor += 1;
      continue;
    }

    needle.push(token.raw);
    cursor += 1;
  }

  return {
    filters: {
      vintages,
      countries: buckets.countries,
      regions: buckets.regions,
      colours: buckets.colours,
    },
    preferences: { body: buckets.body },
    text: needle.join(" "),
    understood:
      vintages.length > 0 ||
      buckets.countries.length > 0 ||
      buckets.regions.length > 0 ||
      buckets.colours.length > 0 ||
      buckets.body.length > 0,
  };
}
