// The vocabulary the typed-search parser matches against (program plan D1).
//
// DELIBERATELY NOT src/lib/atlas/country-lookup.ts's country set. That one is
// keyed to the atlas map's 110m geometry and drops countries too small to
// draw (Malta, per its own comment) — a sensible rule for a map and a silent
// bug for a search box, where a dropped country simply stops being findable.
// Search gets its own list, chosen for wine rather than for cartography.
//
// DELIBERATELY NOT the tenant's own cellar values either, the way
// wine-intelligence/assistant-query.ts builds its vocabulary. That parser
// answers questions about wine the tenant OWNS, so a cellar-derived
// vocabulary is right there. This one also searches a 211k-row reference
// catalogue, where "Barolo" must parse whether or not the cellar holds one.
//
// The list is short on purpose. An unlisted place is not an error: it stays
// in the text needle and is searched as words, exactly as every query is
// searched today. Adding an entry turns a word into a filter — a strictly
// stronger claim — so entries earn their place one at a time.

/** Canonical country name -> the words that mean it, demonyms included. */
const COUNTRY_TERMS: Record<string, readonly string[]> = {
  France: ["france", "french"],
  Italy: ["italy", "italian"],
  Spain: ["spain", "spanish"],
  Portugal: ["portugal", "portuguese"],
  Germany: ["germany", "german"],
  Austria: ["austria", "austrian"],
  Australia: ["australia", "australian"],
  "New Zealand": ["new zealand"],
  "United States": ["united states", "usa", "us", "america", "american"],
  Argentina: ["argentina", "argentine", "argentinian"],
  Chile: ["chile", "chilean"],
  "South Africa": ["south africa", "south african"],
  Greece: ["greece", "greek"],
  Hungary: ["hungary", "hungarian"],
  Israel: ["israel", "israeli"],
  Lebanon: ["lebanon", "lebanese"],
  Georgia: ["georgia", "georgian"],
  Croatia: ["croatia", "croatian"],
  Slovenia: ["slovenia", "slovenian"],
  Romania: ["romania", "romanian"],
  Uruguay: ["uruguay", "uruguayan"],
  Brazil: ["brazil", "brazilian"],
  Canada: ["canada", "canadian"],
  Mexico: ["mexico", "mexican"],
  Switzerland: ["switzerland", "swiss"],
  England: ["england", "english"],
  Bulgaria: ["bulgaria", "bulgarian"],
  Moldova: ["moldova", "moldovan"],
  Turkey: ["turkey", "turkish"],
  Japan: ["japan", "japanese"],
  China: ["china", "chinese"],
  India: ["india", "indian"],
};

/**
 * Canonical region name -> the words that mean it.
 *
 * Regions here are the ones a person types INSTEAD of a producer — the
 * appellations famous enough to be a search in themselves. A region is not
 * mapped to its country: "Burgundy" filters on region, and saying it also
 * means France would be an inference the user did not make, which matters
 * the moment a New World producer names a wine after an Old World place.
 */
const REGION_TERMS: Record<string, readonly string[]> = {
  Bordeaux: ["bordeaux"],
  Burgundy: ["burgundy", "bourgogne"],
  Champagne: ["champagne"],
  Rhône: ["rhone", "rhône"],
  Loire: ["loire"],
  Alsace: ["alsace"],
  Provence: ["provence"],
  Beaujolais: ["beaujolais"],
  Piedmont: ["piedmont", "piemonte"],
  Tuscany: ["tuscany", "toscana"],
  Veneto: ["veneto"],
  Sicily: ["sicily", "sicilia"],
  Rioja: ["rioja"],
  "Ribera del Duero": ["ribera del duero"],
  "Priorat": ["priorat"],
  Douro: ["douro"],
  "Vinho Verde": ["vinho verde"],
  Alentejo: ["alentejo"],
  Mosel: ["mosel"],
  Rheingau: ["rheingau"],
  Pfalz: ["pfalz"],
  "Napa Valley": ["napa valley", "napa"],
  "Sonoma": ["sonoma"],
  "Willamette Valley": ["willamette valley", "willamette"],
  California: ["california", "californian"],
  Oregon: ["oregon"],
  "Barossa Valley": ["barossa valley", "barossa"],
  "Margaret River": ["margaret river"],
  "Marlborough": ["marlborough"],
  "Central Otago": ["central otago"],
  Mendoza: ["mendoza"],
  "Maipo Valley": ["maipo valley", "maipo"],
  Stellenbosch: ["stellenbosch"],
};

/** Canonical colour -> the words that mean it. */
const COLOUR_TERMS: Record<string, readonly string[]> = {
  Red: ["red", "reds"],
  White: ["white", "whites"],
  Rosé: ["rose", "rosé", "roses"],
  Sparkling: ["sparkling", "bubbles", "fizz"],
  Dessert: ["dessert", "sweet"],
  Fortified: ["fortified"],
};

/**
 * Canonical body -> the words that mean it.
 *
 * These are PREFERENCES, not filters (D1). "Crisp" describes how a wine
 * should taste, and the corpus records body for only a fraction of wines —
 * excluding everything else would answer "we have nothing crisp" when the
 * truth is "we don't know how most of these taste".
 */
const BODY_TERMS: Record<string, readonly string[]> = {
  "Light-bodied": ["light", "crisp", "delicate", "elegant", "lean"],
  "Medium-bodied": ["medium", "medium-bodied"],
  "Full-bodied": ["full", "bold", "full-bodied", "powerful", "rich"],
  "Very full-bodied": ["very full-bodied", "massive"],
};

/**
 * Words that carry no search meaning of their own. They are dropped from the
 * needle AND from the unmatched report — telling someone we did not
 * understand "from" would be noise, not honesty.
 */
export const FILLER_TERMS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "of", "from", "in", "with", "for", "to",
  "some", "any", "me", "my", "our", "please", "show", "find", "looking",
  "want", "need", "wine", "wines", "bottle", "bottles", "something",
  "anything", "that", "which", "is", "are", "like", "good", "nice",
]);

export type GazetteerEntry = {
  /** The canonical value a match resolves to. */
  canonical: string;
  /** Number of words in the phrase, so longer phrases can win. */
  length: number;
};

function buildIndex(
  groups: Record<string, readonly string[]>,
): ReadonlyMap<string, GazetteerEntry> {
  const index = new Map<string, GazetteerEntry>();
  for (const [canonical, terms] of Object.entries(groups)) {
    for (const term of terms) {
      const phrase = foldTerm(term);
      const existing = index.get(phrase);
      // First writer wins: a term listed under two canonicals is a data bug,
      // and silently taking the last one would hide it.
      if (existing === undefined) {
        index.set(phrase, { canonical, length: phrase.split(" ").length });
      }
    }
  }
  return index;
}

/** Case-fold and strip diacritics so "Rhône" and "rhone" are one key. */
export function foldTerm(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Every spelling the gazetteer knows for a canonical region.
 *
 * Needed because the corpora do not agree with each other: lwin_catalog has
 * 25,420 rows under "Burgundy" and none under "Bourgogne", while
 * xwines_catalog has 2,429 under "Bourgogne" and none under "Burgundy"
 * (measured 2026-09-01). A filter built from one canonical name reaches one
 * corpus and silently misses the other, so the filter is built from all of a
 * region's surface terms instead — the same terms that let a person's typing
 * find it.
 */
export function regionSurfaceTerms(canonical: string): readonly string[] {
  return REGION_TERMS[canonical] ?? [foldTerm(canonical)];
}

export const COUNTRY_INDEX = buildIndex(COUNTRY_TERMS);
export const REGION_INDEX = buildIndex(REGION_TERMS);
export const COLOUR_INDEX = buildIndex(COLOUR_TERMS);
export const BODY_INDEX = buildIndex(BODY_TERMS);

/** Longest phrase in any index, so the scanner knows how far to look ahead. */
export const MAX_PHRASE_WORDS = Math.max(
  ...[COUNTRY_INDEX, REGION_INDEX, COLOUR_INDEX, BODY_INDEX].flatMap((index) =>
    [...index.values()].map((entry) => entry.length),
  ),
);
