// The assistant's lexicon: what words mean, and how they are found in a
// sentence.
//
// Split out of assistant-query.ts when the negation rules pushed that file
// past the 400-line budget. The division is by concern, not by line count:
// this module owns the closed vocabularies and the matching primitives over
// them; assistant-query.ts owns the parse — which facets are read, in what
// order, and what the resulting struct says.
//
// Everything here is a pure function of (words, vocabulary). No model, no
// SQL, no invented values — see assistant-query.ts's header for the D-006b
// decision that makes those the standing constraints.

import { foldAccents } from "./name-resolver";

export function normalize(s: string): string {
  return foldAccents(s)
    .toLowerCase()
    // Apostrophes are REMOVED, not spaced: spacing them split "isn't" into
    // the tokens "isn" and "t", which surfaced as unrecognised noise and —
    // worse — hid the negation from the check below. Hyphens still become
    // spaces, so "light-bodied" keeps matching "light bodied".
    .replace(/['’]/g, "")
    .replace(/-/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Where `phrase` starts in `words`, or -1. Matching whole words is what
 * keeps "red" from firing inside "shredded"; the INDEX is what lets the
 * negation check below know which words sit in front of a match. */
export function phraseWordIndex(words: readonly string[], phrase: string): number {
  const parts = phrase.split(" ").filter(Boolean);
  if (parts.length === 0) return -1;
  for (let i = 0; i + parts.length <= words.length; i++) {
    let matched = true;
    for (let j = 0; j < parts.length; j++) {
      if (words[i + j] !== parts[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

// ── Negation ─────────────────────────────────────────────────────────────
//
// Without this, "a red that isn't Cabernet" returned grape "Cabernet
// Sauvignon" and listed it under `understood` — the reader was handed the one
// wine they ruled out, and the panel presented it as a constraint it had
// confidently parsed. "No sparkling please" was worse still: it returned type
// "Sparkling" with `unrecognized` EMPTY, so nothing on screen hinted that the
// answer was the exact inverse of the question.
//
// That is the confident-wrong-answer class this module's header (D-006b) and
// the D2 grounding contract exist to prevent, and it is strictly worse than
// not parsing at all: an unparsed word says "I did not understand this", an
// inverted one asserts something untrue.
//
// What a negated facet does here is simply NOT GET SET, and its words are
// left unconsumed so they fall through to `unrecognized` and the panel says
// it did not understand that part. Excluding on a negated facet — a real NOT
// predicate reaching the query — is follow-up work. Saying so honestly is not.

/** Phrases that flip a facet from "wanted" to "ruled out", already in the
 *  shape normalize() produces (no apostrophes: "isn't" arrives as "isnt"). */
const NEGATION_PHRASES: readonly string[] = [
  "not", "no", "nothing", "nothin", "without", "except", "excluding", "besides", "minus",
  "isnt", "arent", "dont", "doesnt", "didnt", "wasnt", "werent", "wont", "cant",
  "other than", "apart from", "rather than", "anything but", "but not",
  "avoid", "avoiding", "skip", "hate", "dislike",
];

const NEGATION_SET: ReadonlySet<string> = new Set(NEGATION_PHRASES);

/** Longest entry in NEGATION_PHRASES, in words ("other than", "but not"). */
const MAX_NEGATION_WORDS = 2;

/** Bound on the walk below, so a question made entirely of filler words
 *  cannot make this scan the whole string looking for a negation. */
const NEGATION_MAX_STEPS = 6;

/**
 * Whether a negation reaches the facet starting at `startIndex`.
 *
 * A negation binds to its OBJECT, and only small words may stand between the
 * two: "not Merlot", "not a Merlot", "anything other than a Merlot". An
 * intervening CONTENT word ends its reach.
 *
 * That last rule is doing real work, and a fixed lookback window cannot
 * replace it. "Not sparkling, a red from Italy" and "other than a Merlot"
 * put their negation the same distance from the following facet, but only
 * the second one negates it — in the first, "sparkling" is the thing being
 * refused and the red is genuinely wanted. Suppressing every facet
 * downstream of one refusal would trade a silent wrong answer for a
 * different silent wrong answer.
 */
export function isNegated(words: readonly string[], startIndex: number): boolean {
  for (let i = startIndex - 1, steps = 0; i >= 0 && steps < NEGATION_MAX_STEPS; i--, steps++) {
    for (let length = 1; length <= MAX_NEGATION_WORDS; length++) {
      const from = i - length + 1;
      if (from < 0) break;
      if (NEGATION_SET.has(words.slice(from, i + 1).join(" "))) return true;
    }
    if (!FILLER_WORDS.has(words[i]!)) return false;
  }
  return false;
}

/** The first of `phrases` present, preferring one no negation reaches. A hit
 *  that IS negated is reported rather than hidden, so the caller can decline
 *  to set the facet instead of silently affirming it. */
export function matchPhrases(
  words: readonly string[],
  phrases: readonly string[],
): { hit: string; negated: boolean } | null {
  let negatedHit: string | null = null;
  for (const phrase of phrases) {
    const norm = normalize(phrase);
    const index = phraseWordIndex(words, norm);
    if (index < 0) continue;
    if (!isNegated(words, index)) return { hit: norm, negated: false };
    if (negatedHit === null) negatedHit = norm;
  }
  return negatedHit === null ? null : { hit: negatedHit, negated: true };
}

// ── Closed corpus vocabularies ───────────────────────────────────────────
// xwines_catalog.type and .body are closed sets (6 and 5 values). The phrase
// lists map how people actually ask onto the exact stored value. Order
// matters: the first entry whose phrase is present wins, so more specific
// phrases ("full bodied") precede the words they contain ("full").
//
// The plurals ("reds", "whites", "roses") are the search gazetteer's, added
// by hand rather than by importing its colour terms wholesale: that table
// also maps bare "dessert" and "sweet" to the Dessert type, and here bare
// "dessert" is a PAIRING ("a wine for dessert") — importing it would turn a
// food into a wine type. Demonyms and regional spellings, which carry no
// such ambiguity, ARE imported (see bestVocabularyMatch in assistant-query).

export const TYPE_PHRASES: ReadonlyArray<{ value: string; phrases: readonly string[] }> = [
  { value: "Dessert/Port", phrases: ["port", "tawny", "vintage port"] },
  { value: "Sparkling", phrases: ["sparkling", "champagne", "bubbles", "bubbly", "prosecco", "cava", "espumante"] },
  { value: "Rosé", phrases: ["rose", "roses", "rosado", "pink"] },
  { value: "Dessert", phrases: ["dessert wine", "sweet wine", "pudding wine"] },
  { value: "White", phrases: ["white", "whites", "blanc", "branco"] },
  { value: "Red", phrases: ["red", "reds", "tinto", "rouge"] },
];

export const BODY_PHRASES: ReadonlyArray<{ value: string; phrases: readonly string[] }> = [
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
export const PAIRING_PHRASES: ReadonlyArray<{ values: readonly string[]; phrases: readonly string[] }> = [
  { values: ["Beef"], phrases: ["beef", "steak", "ribeye", "sirloin", "burger"] },
  { values: ["Poultry"], phrases: ["poultry", "chicken", "turkey", "duck"] },
  { values: ["Lamb"], phrases: ["lamb", "mutton"] },
  { values: ["Pork"], phrases: ["pork", "ham", "bacon"] },
  { values: ["Veal"], phrases: ["veal"] },
  { values: ["Game Meat"], phrases: ["game meat", "game", "venison", "boar"] },
  { values: ["Cured Meat"], phrases: ["cured meat", "cured meats", "charcuterie", "salami", "prosciutto"] },
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
export const BLEND_PHRASES: readonly string[] = ["blend", "blends", "blended", "assemblage", "cuvee"];
// A bare "100" is DELIBERATELY not a phrase here: "$100" normalizes to the
// same digits (normalize() strips the "$"), so a bare number would read a
// price as a single-varietal signal — see SINGLE_VARIETAL_PERCENT in
// assistant-query.ts, which checks the RAW text for "100%" instead.
export const SINGLE_VARIETAL_PHRASES: readonly string[] = [
  "single varietal", "single variety", "varietal only", "pure", "straight",
];

// Words that carry no facet. Kept tight for the same reason
// voice-filter-intent's list is: under-stripping costs a stray "did not
// understand" chip, over-stripping hides that the query was misread.
export const FILLER_WORDS = new Set([
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
  "another", "too",
]);
