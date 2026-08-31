/**
 * The invented identities the production-shaped fixture is built from.
 *
 * Kept in its own module because two things need it and neither may import the
 * other: `seed-prodshape-tenant.mjs` writes these rows, and
 * `prodshape-corpus-miss-check.mjs` proves they reach nothing in
 * `xwines_catalog` — a check that would be worthless if it verified a
 * restatement of the generator instead of the generator itself.
 *
 * ── WHY EVERY NAME HERE IS MADE UP ─────────────────────────────────────────
 *
 * Production's `xwines_catalog` is empty; this checkout's has 100,646 rows and
 * the table has no tenant column, so both states cannot exist at once and the
 * local corpus must not be deleted (other suites read it). Inventing the
 * identities makes every corpus lookup for these wines MISS, which is what an
 * empty catalogue returns.
 *
 * Accents and an apostrophe are deliberate. Production's names carry them
 * ('Vosne-Romanée', 'Bérêche & Fils'), and text that only ever gets ASCII in a
 * fixture is text whose normalization, sorting and truncation were never
 * exercised. They sit in the CUVÉE rather than the producer because the
 * producer is what the corpus-miss gate has to keep clean.
 *
 * The register is deliberately the one this codebase has already measured.
 * `src/lib/wine-intelligence/producer-from-name.ts` and `wine-corpus-profile.ts`
 * both use the base seeder's invented producers ("Juniper Vale", "Hollow Hill")
 * as their negative set, measured at 0 accepted matches in 250. These extend
 * that set in the same key — and are re-verified by the gate rather than
 * trusted. Six first drafts were rejected by that gate and replaced: 'Canto
 * Verde', 'Fable & Stone', 'Trellis Road', 'Cobblestone Reach', 'Foxglove
 * Terrace' and 'Inkwell Ridge' all begin with a word that IS a real X-Wines
 * winery ('Canto', 'Fable', 'Trellis', 'Cobblestone', 'Foxglove', 'Inkwell'),
 * which is the one-word false-positive trap producer-from-name.ts documents.
 * The app's own two-word floor would have caught all six; relying on it would
 * have left this fixture one floor change away from growing pictures
 * production cannot have.
 */

export const WINE_COUNT = 400;

/** 93/400 = 23.25%, against production's 321/1,385 = 23.18%. */
export const BLANK_PRODUCER_COUNT = 93;

export const PRODUCERS = [
  "Aster House", "Beacon Ridge", "Verdant Mile", "Domaine du Marchand",
  "Eastfold Cellars", "Threadstone Cellars", "Granite Coast", "Hollow Hill",
  "Iris Bench", "Juniper Vale", "Kingfisher Estate", "Linden & Row",
  "Maison Orme", "Oro Vista", "Pillar & Thread", "Quartz Run",
  "Sable Crown", "Palisade Road", "Cinder Gate", "Larkspur Bench",
  "Umber Field", "Vellum Hollow", "Winterbourne Estate", "Ashgrove Cellars",
  "Bramblewick Vineyards", "Millrace Reach", "Duskwater Farm",
  "Elmshade Cellars", "Hedgerow Terrace", "Greyling Bay", "Harrowgate Vines",
  "Quillwood Ridge", "Jessamine Court", "Kestrel Hollow", "Marlpit Rise",
  "Nettlefold Vines",
];

/** [appellation, region, country, varietal, colour] */
export const APPELLATIONS = [
  ["Vosne-Romanée", "Burgundy", "France", "Pinot Noir", "red"],
  ["Gevrey-Chambertin", "Burgundy", "France", "Pinot Noir", "red"],
  ["Pauillac", "Bordeaux", "France", "Cabernet Blend", "red"],
  ["Saint-Émilion", "Bordeaux", "France", "Merlot Blend", "red"],
  ["Chablis", "Burgundy", "France", "Chardonnay", "white"],
  ["Barolo", "Piedmont", "Italy", "Nebbiolo", "red"],
  ["Barbaresco", "Piedmont", "Italy", "Nebbiolo", "red"],
  ["Brunello", "Tuscany", "Italy", "Sangiovese", "red"],
  ["Chianti", "Tuscany", "Italy", "Sangiovese", "red"],
  ["Rioja", "Rioja", "Spain", "Tempranillo", "red"],
  ["Ribera del Duero", "Castilla y León", "Spain", "Tempranillo", "red"],
  ["Priorat", "Catalonia", "Spain", "Garnacha", "red"],
  ["Mosel Riesling", "Mosel", "Germany", "Riesling", "white"],
  ["Rheingau Riesling", "Rheingau", "Germany", "Riesling", "white"],
  ["Sancerre", "Loire", "France", "Sauvignon Blanc", "white"],
  ["Pouilly-Fumé", "Loire", "France", "Sauvignon Blanc", "white"],
  ["Châteauneuf-du-Pape", "Rhône", "France", "Grenache Blend", "red"],
  ["Côte-Rôtie", "Rhône", "France", "Syrah", "red"],
  ["Hermitage", "Rhône", "France", "Syrah", "red"],
  ["Napa Cabernet", "Napa Valley", "United States", "Cabernet Sauvignon", "red"],
  ["Russian River Pinot", "Sonoma", "United States", "Pinot Noir", "red"],
  ["Willamette Pinot", "Willamette Valley", "United States", "Pinot Noir", "red"],
  ["Margaret River Chardonnay", "Margaret River", "Australia", "Chardonnay", "white"],
  ["Central Otago Pinot", "Central Otago", "New Zealand", "Pinot Noir", "red"],
  ["Douro Reserva", "Douro", "Portugal", "Touriga Nacional", "red"],
];

export const DESIGNATIONS = [
  "Vieilles Vignes", "Réserve", "Grand Cru", "Premier Cru", "Estate Bottling",
  "Single Vineyard", "Cuvée Prestige", "Vigne d'Or", "Selection", "Gran Reserva",
  "Classico", "Superiore", "Trocken", "Sur Lie", "Barrel Select",
  "Limited Release",
];

/**
 * Whether wine `i` (1-based) is one of the blank-producer rows.
 *
 * gcd(93, 400) = 1, so `(i * 93) % 400` visits every residue exactly once
 * across i = 1..400 and this is true for EXACTLY 93 of them — spread evenly
 * rather than as a contiguous block, so the blank rows are interleaved through
 * every page, sort order and filter the way production's are.
 */
export function isBlankProducer(i) {
  return (i * BLANK_PRODUCER_COUNT) % WINE_COUNT < BLANK_PRODUCER_COUNT;
}

/**
 * The (producer, name) pair for wine `i`.
 *
 * The cuvée is `APPELLATIONS[i % 25]` + `DESIGNATIONS[i % 16]`. gcd(25, 16) = 1,
 * so those 400 pairs are all distinct — which keeps every row clear of
 * `wines_dedup_idx` without a synthetic "Lot 001" suffix that would advertise
 * the row as a fixture.
 *
 * A blank row carries the shape production's CSV import left behind:
 * `producer = ''`, with the producer name run into the front of `name` and no
 * delimiter — "Benjamin Leroux Vosne-Romanée" (AGENTS.md § two identity
 * systems). Identity resolution is producer-first, so these rows get no spine
 * link, which is exactly why 321 of production's wines have none.
 */
export function wineIdentity(i) {
  const producer = PRODUCERS[i % PRODUCERS.length];
  const [appellation] = APPELLATIONS[i % APPELLATIONS.length];
  const designation = DESIGNATIONS[i % DESIGNATIONS.length];
  const cuvee = `${appellation} ${designation}`;
  return isBlankProducer(i)
    ? { producer: "", name: `${producer} ${cuvee}`, blank: true }
    : { producer, name: cuvee, blank: false };
}
