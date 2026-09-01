// Deterministic natural-language query parser for the wine assistant
// (SCAN-10's grounded lane).
//
// ── WHY THIS IS NOT A CHATBOT ────────────────────────────────────────────
//
// D-006b (docs/plans/2026-08-28-camera-first-decisions-recorded.md) defers
// "embeddings, vector indexes, open-ended chat, and multi-turn conversational
// search" from v1, and permits extending the deterministic resolver "only
// when it emits the same structured query contract; it must not generate SQL
// or ungrounded prose". That decision is the whole design here:
//
//   • No model is called. This is a pure function of (text, vocabulary).
//   • No SQL is generated. The output is a struct of whitelisted fields the
//     caller binds as parameters.
//   • No value is invented. Every country/region/grape it emits came from
//     the caller's own DISTINCT values; every type/body/pairing came from the
//     corpus's closed vocabulary. "A red from Narnia" yields no country — it
//     does not yield `country: "Narnia"`.
//
// The last point is the one that matters in front of an investor. A generated
// answer can describe a real, named, findable wine in terms its producer would
// dispute, on a screen someone can check on their phone. Everything this
// module emits is traceable to a row.
//
// ── RELATIONSHIP TO voice-filter-intent.ts ───────────────────────────────
//
// Sibling, not replacement. That module serves the voice control and matches
// with span-aware trigram similarity, because speech-to-text output is fuzzy
// and misspells the tenant's own values. This one serves a TYPED box, where
// the input is exactly what the user meant to write, so it matches on word
// boundaries instead — precise, and with no accept threshold to tune. It also
// carries three dimensions the cellar's URL facets have no room for (pairing,
// body, price), which is why it is a separate contract rather than a widening
// of VoiceFilterPayload.

import { foldAccents } from "./name-resolver";
import { countrySurfaceTerms, regionSurfaceTerms } from "@/lib/unified-search/wine-gazetteer";
import {
  BLEND_PHRASES,
  BODY_PHRASES,
  FILLER_WORDS,
  PAIRING_PHRASES,
  SINGLE_VARIETAL_PHRASES,
  TYPE_PHRASES,
  isNegated,
  matchPhrases,
  normalize,
  phraseWordIndex,
} from "./assistant-lexicon";

/** The caller's own DISTINCT values — never arbitrary user text. */
export interface AssistantVocabulary {
  country: readonly string[];
  region: readonly string[];
  grape: readonly string[];
}

/**
 * A structured, whitelisted query. Every field is either absent or a value
 * that exists in the data; the caller binds these as parameters.
 */
export interface AssistantQuery {
  type?: string;
  body?: string;
  /** true = a blend, false = a single varietal. Absent when unasked. */
  blend?: boolean;
  pairing?: string[];
  country?: string;
  region?: string;
  grape?: string;
  /** Years asked for, ORed — a list for the same reason `pairing` is one:
   * keeping only the first of "2018 or 2019" would drop the second silently. */
  vintages?: number[];
  priceMin?: number;
  priceMax?: number;
  /** Dimensions actually recognised, so the UI can show its working. */
  understood: string[];
  /** Content words it could not place, so the UI can say so plainly. */
  unrecognized: string[];
}

/** No extra spellings — grapes are matched on the tenant's value alone. */
const NO_SURFACE_TERMS = (): readonly string[] => [];

/**
 * Longest vocabulary value present in the text, or undefined. Longer wins so
 * "Napa Valley" beats "Napa" when both are held.
 *
 * `surfaceTerms` is how the tenant's noun gets its adjective: a value the
 * tenant holds ("Italy") is also looked for under every spelling the search
 * gazetteer knows for it ("italian"). The rule that every emitted value came
 * from the tenant's own rows is untouched — a spelling can only resolve to a
 * value that is already in `vocabulary`. `normalized` is the spelling that
 * actually matched, so the words consumed are the words the reader typed.
 */
function bestVocabularyMatch(
  vocabulary: readonly string[],
  words: readonly string[],
  surfaceTerms: (canonical: string) => readonly string[],
): { value: string; normalized: string } | undefined {
  let winner: { value: string; normalized: string } | undefined;
  for (const raw of vocabulary) {
    const value = raw?.trim();
    if (!value) continue;
    const spellings = new Set([normalize(value), ...surfaceTerms(value).map(normalize)]);
    for (const norm of spellings) {
      if (!norm) continue;
      // A word the parser treats as noise cannot also be a country: the
      // gazetteer lists "us" for the United States, and "show us a red" is
      // addressed to the assistant, not set in America.
      if (FILLER_WORDS.has(norm)) continue;
      const index = phraseWordIndex(words, norm);
      if (index < 0) continue;
      // A ruled-out value is not a constraint. Left unconsumed on purpose.
      if (isNegated(words, index)) continue;
      if (!winner || norm.length > winner.normalized.length) {
        winner = { value, normalized: norm };
      }
    }
  }
  return winner;
}

/** A number written as a price: preceded by $/currency word, or followed by
 * "dollars". A bare 2018 in "a 2018 Malbec" is a vintage and is not one. */
interface PriceBounds {
  priceMin?: number;
  priceMax?: number;
  spans: string[];
}

function parsePrice(raw: string, normalized: string): PriceBounds {
  const spans: string[] = [];

  // Work on the raw string for price detection so "$" survives normalization.
  const lowered = foldAccents(raw).toLowerCase();

  // Every number that is explicitly monetary.
  const amounts: number[] = [];
  const money = /\$\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:dollars?|bucks|usd)\b/g;
  for (let m = money.exec(lowered); m !== null; m = money.exec(lowered)) {
    const n = Number((m[1] ?? m[2] ?? "").replace(/,/g, ""));
    if (Number.isFinite(n)) {
      amounts.push(n);
      spans.push(String(n));
    }
  }

  // "$200-400" and "$200 to 400": the second number inherits the first's
  // currency marker, so it is monetary even without a "$" of its own.
  const range = /\$\s*(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|to|and)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/.exec(lowered);
  if (range) {
    const lo = Number(range[1].replace(/,/g, ""));
    const hi = Number(range[2].replace(/,/g, ""));
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      spans.push(String(lo), String(hi));
      return { priceMin: Math.min(lo, hi), priceMax: Math.max(lo, hi), spans };
    }
  }

  if (amounts.length >= 2) {
    const lo = Math.min(amounts[0], amounts[1]);
    const hi = Math.max(amounts[0], amounts[1]);
    return { priceMin: lo, priceMax: hi, spans };
  }

  if (amounts.length === 1) {
    const [n] = amounts;
    // A negation flips the comparator: "nothing over 120" is a CEILING of
    // 120, not a floor. Checked first, because the phrase it negates
    // ("over", "more than") is still present in the text and would
    // otherwise match the lower-bound pattern below and inverse the band.
    const negatedLower = /\b(nothing|not|no|never)\s+(over|above|more than|higher than)\b/.test(normalized);
    const upper = negatedLower
      || /\b(under|below|less than|no more than|up to|cheaper than|max|maximum)\b/.test(normalized);
    const lower = !negatedLower
      && /\b(over|above|more than|at least|min|minimum|starting at)\b/.test(normalized);
    if (upper) return { priceMax: n, spans };
    if (lower) return { priceMin: n, spans };
    // A lone monetary figure with no comparator reads as a target: give it a
    // band rather than demanding an exact match no bottle will hit.
    return { priceMin: Math.round(n * 0.8), priceMax: Math.round(n * 1.2), spans };
  }

  return { spans };
}

// The band a four-digit number must sit in to read as a year, and the reasons,
// are the typed-search parser's (src/lib/unified-search/query-parse.ts): below
// 1850 such a number is likelier a cuvee name or a street number than a
// vintage, and futures sell two years ahead of release. Borrowed, NOT shared —
// slice 3a rejected merging the two parsers, and that still holds.
const OLDEST_VINTAGE = 1850;
const VINTAGE_LOOKAHEAD_YEARS = 2;

/**
 * Years in `text`, minus any number already spent as a price — "$2018" is a
 * budget, not a bottling. Matches a BARE four-digit token, so "1500ml" is a
 * bottle size and stays out.
 */
function parseVintages(words: readonly string[], priceSpans: readonly string[]): number[] {
  const spent = new Set(priceSpans);
  const newest = new Date().getUTCFullYear() + VINTAGE_LOOKAHEAD_YEARS;
  const years: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (!/^\d{4}$/.test(word) || spent.has(word)) continue;
    const year = Number(word);
    if (year < OLDEST_VINTAGE || year > newest) continue;
    // "a Bordeaux but not 2016" rules the year out; it does not ask for it.
    if (isNegated(words, i)) continue;
    if (!years.includes(year)) years.push(year);
  }
  return years;
}

/** See the comment where this is used: a bare "100" is ambiguous with a
 *  price once normalize() has removed the "%" sign, so this checks the raw
 *  text instead of the word list parsePrice/matchPhrases both work from. */
const SINGLE_VARIETAL_PERCENT = /\b100\s*%/;

/**
 * Parse a typed question into a whitelisted, structured query.
 *
 * Never throws and never invents: an unparseable question returns a query
 * that understood nothing, which the caller should surface as "I did not
 * understand that" rather than as an unfiltered result set.
 */
export function parseAssistantQuery(
  raw: string,
  vocabulary: AssistantVocabulary,
): AssistantQuery {
  const text = normalize(raw ?? "");
  const query: AssistantQuery = { understood: [], unrecognized: [] };
  if (!text) return query;

  // Facets are matched against the word list rather than the whole string, so
  // every match knows its position and can be checked for a negation in front
  // of it (see NEGATION_PHRASES).
  const words = text.split(" ").filter(Boolean);

  // Words consumed by a recognised facet, so they are not later reported as
  // unrecognised.
  const consumed: string[] = [];
  const consume = (phrase: string) => {
    for (const w of phrase.split(" ")) if (w) consumed.push(w);
  };

  for (const { value, phrases } of TYPE_PHRASES) {
    const match = matchPhrases(words, phrases);
    if (match === null) continue;
    // Negated: leave it unconsumed and keep looking. "Not sparkling, a red"
    // must still reach Red rather than stopping at the refused type.
    if (match.negated) continue;
    query.type = value;
    query.understood.push("type");
    consume(match.hit);
    break;
  }

  for (const { value, phrases } of BODY_PHRASES) {
    const match = matchPhrases(words, phrases);
    if (match === null || match.negated) continue;
    query.body = value;
    query.understood.push("body");
    consume(match.hit);
    break;
  }

  // Pairing accumulates: "beef and mushrooms" is two honest constraints.
  const pairings = new Set<string>();
  for (const { values, phrases } of PAIRING_PHRASES) {
    const match = matchPhrases(words, phrases);
    if (match === null || match.negated) continue;
    for (const v of values) pairings.add(v);
    consume(match.hit);
  }
  if (pairings.size > 0) {
    query.pairing = [...pairings];
    query.understood.push("pairing");
  }

  // Single-varietal is checked first: "single varietal" contains no blend
  // word, but "100% Malbec" and "a blend" must not both fire on one question.
  const singleMatch = matchPhrases(words, SINGLE_VARIETAL_PHRASES);
  const blendMatch = matchPhrases(words, BLEND_PHRASES);
  // "100% Malbec" is the single-varietal idiom, checked against the RAW text
  // rather than a word list: normalize() strips "%" along with every other
  // punctuation mark, so a bare "100" token cannot tell that idiom apart
  // from an unrelated "$100" price without losing the very thing ("%")
  // that disambiguates them.
  const singleByPercent = SINGLE_VARIETAL_PERCENT.test(raw ?? "");
  // A negated hit sets nothing: "not a blend" implies a single varietal only
  // if you are willing to guess, and guessing is what this module does not do.
  if ((singleMatch !== null && !singleMatch.negated) || singleByPercent) {
    query.blend = false;
    query.understood.push("blend");
    if (singleMatch) consume(singleMatch.hit);
  } else if (blendMatch !== null && !blendMatch.negated) {
    query.blend = true;
    query.understood.push("blend");
    consume(blendMatch.hit);
  }

  const region = bestVocabularyMatch(vocabulary.region, words, regionSurfaceTerms);
  if (region) {
    query.region = region.value;
    query.understood.push("region");
    consume(region.normalized);
  }

  const country = bestVocabularyMatch(vocabulary.country, words, countrySurfaceTerms);
  if (country) {
    query.country = country.value;
    query.understood.push("country");
    consume(country.normalized);
  }

  const grape = bestVocabularyMatch(vocabulary.grape, words, NO_SURFACE_TERMS);
  if (grape) {
    query.grape = grape.value;
    query.understood.push("grape");
    consume(grape.normalized);
  }

  const price = parsePrice(raw ?? "", text);
  if (price.priceMin != null) {
    query.priceMin = price.priceMin;
    query.understood.push("priceMin");
  }
  if (price.priceMax != null) {
    query.priceMax = price.priceMax;
    query.understood.push("priceMax");
  }
  for (const s of price.spans) consume(s);

  const vintages = parseVintages(words, price.spans);
  if (vintages.length > 0) {
    query.vintages = vintages;
    query.understood.push("vintage");
    for (const year of vintages) consume(String(year));
  }

  const consumedSet = new Set(consumed);
  query.unrecognized = words
    .filter(
      (w) =>
        w.length > 2 &&
        !consumedSet.has(w) &&
        !FILLER_WORDS.has(w),
    );

  return query;
}
