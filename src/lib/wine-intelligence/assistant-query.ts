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
  priceMin?: number;
  priceMax?: number;
  /** Dimensions actually recognised, so the UI can show its working. */
  understood: string[];
  /** Content words it could not place, so the UI can say so plainly. */
  unrecognized: string[];
}

function normalize(s: string): string {
  return foldAccents(s)
    .toLowerCase()
    .replace(/['’-]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `phrase` appears in `text` on word boundaries — so "red" does
 * not fire inside "shredded". Both arguments are already normalized. */
function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  return ` ${text} `.includes(` ${phrase} `);
}

// ── Closed corpus vocabularies ───────────────────────────────────────────
// xwines_catalog.type and .body are closed sets (6 and 5 values). The phrase
// lists map how people actually ask onto the exact stored value. Order
// matters: the first entry whose phrase is present wins, so more specific
// phrases ("full bodied") precede the words they contain ("full").

const TYPE_PHRASES: ReadonlyArray<{ value: string; phrases: readonly string[] }> = [
  { value: "Dessert/Port", phrases: ["port", "tawny", "vintage port"] },
  { value: "Sparkling", phrases: ["sparkling", "champagne", "bubbles", "bubbly", "prosecco", "cava", "espumante"] },
  { value: "Rosé", phrases: ["rose", "rosado", "pink"] },
  { value: "Dessert", phrases: ["dessert wine", "sweet wine", "pudding wine"] },
  { value: "White", phrases: ["white", "blanc", "branco"] },
  { value: "Red", phrases: ["red", "tinto", "rouge"] },
];

const BODY_PHRASES: ReadonlyArray<{ value: string; phrases: readonly string[] }> = [
  { value: "Very full-bodied", phrases: ["very full bodied", "very full"] },
  { value: "Very light-bodied", phrases: ["very light bodied", "very light"] },
  { value: "Full-bodied", phrases: ["full bodied", "fullbodied", "bold", "big", "heavy", "powerful", "rich"] },
  { value: "Light-bodied", phrases: ["light bodied", "lightbodied", "light", "crisp", "delicate", "easy drinking"] },
  { value: "Medium-bodied", phrases: ["medium bodied", "mediumbodied", "medium"] },
];

// xwines_catalog.harmonize's vocabulary, plus the everyday words people use
// for them. A word that genuinely covers two stored values (fish, cheese,
// meat) maps to ALL of them — collapsing to one would silently drop honest
// answers, so `pairing` is a list.
const PAIRING_PHRASES: ReadonlyArray<{ values: readonly string[]; phrases: readonly string[] }> = [
  { values: ["Beef"], phrases: ["beef", "steak", "ribeye", "sirloin", "burger"] },
  { values: ["Poultry"], phrases: ["poultry", "chicken", "turkey", "duck"] },
  { values: ["Lamb"], phrases: ["lamb", "mutton"] },
  { values: ["Pork"], phrases: ["pork", "ham", "bacon"] },
  { values: ["Veal"], phrases: ["veal"] },
  { values: ["Game Meat"], phrases: ["game meat", "game", "venison", "boar"] },
  { values: ["Cured Meat"], phrases: ["cured meat", "charcuterie", "salami", "prosciutto"] },
  { values: ["Shellfish"], phrases: ["shellfish", "shrimp", "prawns", "lobster", "crab", "oysters", "scallops"] },
  { values: ["Rich Fish", "Lean Fish"], phrases: ["fish", "seafood"] },
  { values: ["Rich Fish"], phrases: ["rich fish", "salmon", "tuna", "mackerel"] },
  { values: ["Lean Fish"], phrases: ["lean fish", "cod", "sole", "halibut", "white fish"] },
  { values: ["Pasta"], phrases: ["pasta", "spaghetti", "risotto", "lasagna"] },
  { values: ["Vegetarian"], phrases: ["vegetarian", "vegan", "vegetables", "veggie"] },
  { values: ["Spicy Food"], phrases: ["spicy food", "spicy", "curry", "chilli", "chili"] },
  { values: ["Goat Cheese"], phrases: ["goat cheese", "chevre"] },
  { values: ["Blue Cheese"], phrases: ["blue cheese", "roquefort", "stilton", "gorgonzola"] },
  { values: ["Soft Cheese"], phrases: ["soft cheese", "brie", "camembert"] },
  { values: ["Hard Cheese"], phrases: ["hard cheese", "cheddar", "manchego"] },
  { values: ["Maturated Cheese"], phrases: ["maturated cheese", "aged cheese", "parmesan"] },
  { values: ["Soft Cheese", "Hard Cheese", "Maturated Cheese"], phrases: ["cheese", "cheese board"] },
  { values: ["Mushrooms"], phrases: ["mushrooms", "mushroom", "truffle"] },
  { values: ["Sweet Dessert"], phrases: ["sweet dessert", "dessert", "chocolate", "cake"] },
  { values: ["Fruit Dessert"], phrases: ["fruit dessert", "fruit tart"] },
  { values: ["Appetizer"], phrases: ["appetizer", "starter", "canapes"] },
  { values: ["Snack"], phrases: ["snack", "snacks", "nibbles"] },
  { values: ["Barbecue"], phrases: ["barbecue", "bbq", "grill", "grilled"] },
  { values: ["Beef", "Lamb", "Pork", "Game Meat", "Veal"], phrases: ["meats", "meat", "red meat"] },
];

// xwines_catalog.elaborate splits the corpus into "Varietal/100%" and the
// "Assemblage/..." family. Two phrase lists rather than one flag, because
// "single varietal" and "blend" are both things people ask for and neither is
// the absence of the other.
const BLEND_PHRASES: readonly string[] = ["blend", "blends", "blended", "assemblage", "cuvee"];
const SINGLE_VARIETAL_PHRASES: readonly string[] = [
  "single varietal", "single variety", "100", "varietal only", "pure", "straight",
];

// Words that carry no facet. Kept tight for the same reason
// voice-filter-intent's list is: under-stripping costs a stray "did not
// understand" chip, over-stripping hides that the query was misread.
const FILLER_WORDS = new Set([
  "a", "an", "the", "of", "for", "to", "in", "on", "at", "by", "with", "and", "or",
  "from", "please", "show", "me", "us", "pull", "up", "find", "get", "bring",
  "any", "some", "all", "list", "give", "have", "got", "want", "need", "looking",
  "wine", "wines", "bottle", "bottles", "cellar", "tonight", "today", "something",
  "anything", "good", "nice", "nicely", "great", "best", "hey", "hi", "hello",
  "there", "im", "i", "is", "it", "that", "what", "goes", "go", "pair", "pairs",
  "pairing", "might", "would", "could", "like", "about", "between", "range",
  "under", "over", "below", "above", "less", "more", "than", "around", "near",
  "dollars", "dollar", "bucks", "usd", "price", "priced", "costs", "cost",
  "drink", "drinking", "serve", "serving", "recommend", "recommendation",
  "we", "you", "my", "our", "your", "can", "do", "does", "please",
  "should", "pour", "pouring", "glass", "dinner", "night", "evening",
  "meal", "dish", "eating", "having", "suggest", "suggestion", "match",
]);

/** Longest vocabulary value present in the text, or undefined. Longer wins so
 * "Napa Valley" beats "Napa" when both are held. */
function bestVocabularyMatch(
  vocabulary: readonly string[],
  text: string,
): { value: string; normalized: string } | undefined {
  let winner: { value: string; normalized: string } | undefined;
  for (const raw of vocabulary) {
    const value = raw?.trim();
    if (!value) continue;
    const norm = normalize(value);
    if (!norm || !containsPhrase(text, norm)) continue;
    if (!winner || norm.length > winner.normalized.length) {
      winner = { value, normalized: norm };
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

  // Words consumed by a recognised facet, so they are not later reported as
  // unrecognised.
  const consumed: string[] = [];
  const consume = (phrase: string) => {
    for (const w of phrase.split(" ")) if (w) consumed.push(w);
  };

  for (const { value, phrases } of TYPE_PHRASES) {
    const hit = phrases.find((p) => containsPhrase(text, normalize(p)));
    if (hit) {
      query.type = value;
      query.understood.push("type");
      consume(normalize(hit));
      break;
    }
  }

  for (const { value, phrases } of BODY_PHRASES) {
    const hit = phrases.find((p) => containsPhrase(text, normalize(p)));
    if (hit) {
      query.body = value;
      query.understood.push("body");
      consume(normalize(hit));
      break;
    }
  }

  // Pairing accumulates: "beef and mushrooms" is two honest constraints.
  const pairings = new Set<string>();
  for (const { values, phrases } of PAIRING_PHRASES) {
    const hit = phrases.find((p) => containsPhrase(text, normalize(p)));
    if (!hit) continue;
    for (const v of values) pairings.add(v);
    consume(normalize(hit));
  }
  if (pairings.size > 0) {
    query.pairing = [...pairings];
    query.understood.push("pairing");
  }

  // Single-varietal is checked first: "single varietal" contains no blend
  // word, but "100% Malbec" and "a blend" must not both fire on one question.
  const singleHit = SINGLE_VARIETAL_PHRASES.find((p) => containsPhrase(text, normalize(p)));
  const blendHit = BLEND_PHRASES.find((p) => containsPhrase(text, normalize(p)));
  if (singleHit) {
    query.blend = false;
    query.understood.push("blend");
    consume(normalize(singleHit));
  } else if (blendHit) {
    query.blend = true;
    query.understood.push("blend");
    consume(normalize(blendHit));
  }

  const region = bestVocabularyMatch(vocabulary.region, text);
  if (region) {
    query.region = region.value;
    query.understood.push("region");
    consume(region.normalized);
  }

  const country = bestVocabularyMatch(vocabulary.country, text);
  if (country) {
    query.country = country.value;
    query.understood.push("country");
    consume(country.normalized);
  }

  const grape = bestVocabularyMatch(vocabulary.grape, text);
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

  const consumedSet = new Set(consumed);
  query.unrecognized = text
    .split(" ")
    .filter(
      (w) =>
        w.length > 2 &&
        !consumedSet.has(w) &&
        !FILLER_WORDS.has(w) &&
        !/^\d+$/.test(w),
    );

  return query;
}
