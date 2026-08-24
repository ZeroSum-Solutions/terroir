#!/usr/bin/env node
// P1 — deterministic "partner cellar" CSV fixture generator.
//
// Stands in for a business partner's real ~20,000-bottle collection export
// until the real file arrives. Everything here is pure and seeded: given the
// same seed and the same flags, this script produces byte-identical output
// every time. No Date.now()/Math.random() anywhere in the data path — the
// only place a Date object appears is formatting a value already computed
// from the seeded PRNG (--extras acquisition_date), never reading the
// system clock.
//
// The blueprint this implements treats UNIQUE WINE VARIANTS
// (producer|cuvee|vintage-or-NV|size_ml) as the number that matters, not
// the row count: repeat purchases of the same variant are legitimate
// duplicate rows, while near-duplicate SPELLINGS of the same variant are
// the dedup problem a later matching pass must catch. See the manifest
// written alongside the CSV for the full ground truth.
//
// Usage:
//   node scripts/fixtures/generate-partner-cellar.mjs                  full 20k fixture -> fixtures/generated/
//   node scripts/fixtures/generate-partner-cellar.mjs --sample-only    500-row golden sample -> fixtures/
//   node scripts/fixtures/generate-partner-cellar.mjs --extras         adds barcode/supplier/acquisition_date/purchase_price columns
//   node scripts/fixtures/generate-partner-cellar.mjs --dirty          appends 50 tagged-invalid rows after the clean rows
//   node scripts/fixtures/generate-partner-cellar.mjs --out-dir <dir>  override the output directory

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SEED = 20260823;
export const TOTAL_ROWS = 20000;
export const SAMPLE_ROWS = 500;
export const DIRTY_ROW_COUNT = 50;
export const TARGET_VARIANT_TOTAL = 4200;
// Real cellar exports sometimes write the literal text "NV" in the vintage
// column instead of leaving it blank. These variants are counted out of
// TARGET_VARIANT_TOTAL (not on top of it), so the headline unique-variant
// count is unaffected by this group's size.
export const NV_LITERAL_VARIANT_COUNT = 13;

const CANONICAL_HEADERS = [
  "producer",
  "name",
  "vintage",
  "varietal",
  "region",
  "country",
  "size_ml",
  "format",
  "currency",
  "quantity",
  "unit_cost",
  "bin",
  "section",
];

const EXTRA_HEADERS = ["barcode", "supplier", "acquisition_date", "purchase_price"];

const FORMAT_LABEL = {
  375: "Half Bottle",
  750: "Bottle",
  1500: "Magnum",
  3000: "Double Magnum",
};

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic, no external dependency.
// ---------------------------------------------------------------------------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    float(min, max) {
      return min + next() * (max - min);
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    chance(p) {
      return next() < p;
    },
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    },
  };
}

// ---------------------------------------------------------------------------
// Small pure helpers reused by both generation and tests.
// ---------------------------------------------------------------------------

/** Standard EAN-13 check digit (odd positions x1, even positions x3, 0-indexed). */
export function computeEan13CheckDigit(twelveDigits) {
  if (!/^\d{12}$/.test(twelveDigits)) {
    throw new Error(`computeEan13CheckDigit expects 12 digits, got: ${twelveDigits}`);
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(twelveDigits[i]);
    sum += i % 2 === 0 ? d : d * 3;
  }
  const mod = sum % 10;
  return mod === 0 ? 0 : 10 - mod;
}

/** Fold a string toward a dedup-comparable canonical form: strip accents
 * (NFKD + remove combining marks), fold case, merge a trailing possessive
 * into its host word, and collapse punctuation and whitespace to single
 * spaces. Used by tests to prove the spelling-noise groups this generator
 * injects really do converge under normalization while adjacent-vintage/
 * format-sibling variants do not.
 *
 * CRITICAL CROSS-PIECE CONTRACT (round-6): this function must stay
 * byte-for-byte behaviorally identical to P2's normalizeProducerOrCuvee in
 * src/domains/identity/normalize.ts (not editable from here — P2's
 * worktree, terroir-vw, branch feat/visual-wine-prototype). The possessive
 * rule below (`['’]s(?=\s|$)`) is copied verbatim, in the same pipeline
 * position (after case-folding, before the general non-alnum collapse),
 * from P2's commit c537d84 — see that file's own header comment and its
 * P2-ROUND-2-FIX note for the full "O'Brien's Vineyard" vs "O.S. Brien
 * Vineyard" over-merge history this closes. Confirmed (grep) that no
 * producer/name/altProducer/altName seed string in this file contains a
 * possessive apostrophe, so this rule does not change any of the 40
 * SPELLING_SEEDS golden vectors or the 20k fixture's bytes/sha256 — see
 * the adversarial-corpus agreement test in generate-partner-cellar.test.ts. */
export function normalizeForDedup(s) {
  const folded = s
    // Unicode NFKD does NOT decompose true ligature letters like œ/æ (they
    // are distinct letters, not compatibility-decomposable) — fold them by
    // hand before the accent-stripping pass below.
    .replace(/œ/gi, "oe")
    .replace(/æ/gi, "ae")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]s(?=\s|$)/g, "s")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  // Word-order-invariant: sorting tokens also converges producer-name
  // reorderings ("Domaine Jean Grivot" vs "Jean Grivot Domaine") without a
  // separate token-set/Jaccard comparison.
  return folded.split(" ").filter(Boolean).sort().join(" ");
}

export function variantKey(producer, name, vintage, sizeMl) {
  return `${producer}␟${name}␟${vintage ?? "NV"}␟${sizeMl}`;
}

function csvField(value) {
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Data pools
// ---------------------------------------------------------------------------

const SURNAME_POOLS = {
  french: [
    "Moreau", "Chapelle", "Bertrand", "Lefevre", "Girard", "Bonnet", "Rousseau",
    "Fabre", "Delacroix", "Perrin", "Riviere", "Aubert", "Fontaine", "Marchand",
  ],
  italian: [
    "Marchetti", "Colombo", "Ferraro", "Bianchi", "Romano", "Greco", "Villa",
    "Conti", "Moretti", "Ricci", "Barbieri", "Fontana",
  ],
  spanish: [
    "Ruiz", "Alvarez", "Castillo", "Mendez", "Navarro", "Delgado", "Reyes",
    "Campos", "Herrera", "Salinas", "Vidal", "Cano",
  ],
  english_newworld: [
    "Harrison", "Whitfield", "Sinclair", "Ashworth", "Caldwell", "Fairweather",
    "Sutherland", "Blackwood", "Ravenscroft", "Winslow", "Hartley", "Sawyer",
    "Holloway", "Prentice",
  ],
  german_austrian: [
    "Kessler", "Baumann", "Vogel", "Richter", "Brandt", "Falkenstein",
    "Hoffmann", "Steiner", "Wagner", "Kellermann",
  ],
  portuguese: ["Silva", "Ferreira", "Costa", "Pereira", "Rocha", "Nogueira"],
  south_african: ["Marais", "Botha", "du Plessis", "van der Merwe", "Joubert", "Fourie"],
  south_american: ["Fernandez", "Delgado", "Rivas", "Ibarra", "Contreras", "Aguirre"],
};

const PREFIX_BY_COUNTRY = {
  France: ["Chateau", "Domaine", "Clos", "Maison"],
  Italy: ["Tenuta", "Cantina", "Podere", "Fattoria"],
  Spain: ["Bodega", "Bodegas", "Finca"],
  Germany: ["Weingut"],
  Austria: ["Weingut"],
  Portugal: ["Quinta"],
  Argentina: ["Bodega", "Finca"],
  Chile: ["Bodega", "Vina", "Finca"],
};

const PREFIXLESS_SUFFIX_COUNTRIES = new Set(["United States", "Australia", "New Zealand", "South Africa"]);
const SUFFIX_WORDS = ["Estate", "Vineyards", "Cellars", "Winery", "Wines"];

const COUNTRY_TO_SURNAME_POOL = {
  France: "french",
  Italy: "italian",
  Spain: "spanish",
  "United States": "english_newworld",
  Australia: "english_newworld",
  "New Zealand": "english_newworld",
  Germany: "german_austrian",
  Austria: "german_austrian",
  Portugal: "portuguese",
  "South Africa": "south_african",
  Argentina: "south_american",
  Chile: "south_american",
};

const REGION_PROFILES = [
  { region: "Bordeaux", country: "France", varietals: ["Cabernet Sauvignon", "Merlot", "Cabernet Franc", "Bordeaux Blend"] },
  { region: "Burgundy", country: "France", varietals: ["Pinot Noir", "Chardonnay"] },
  { region: "Rhone Valley", country: "France", varietals: ["Syrah", "Grenache", "Rhone Blend"] },
  { region: "Loire Valley", country: "France", varietals: ["Chenin Blanc", "Sauvignon Blanc", "Cabernet Franc"] },
  { region: "Alsace", country: "France", varietals: ["Riesling", "Gewurztraminer", "Pinot Gris"] },
  { region: "Tuscany", country: "Italy", varietals: ["Sangiovese", "Cabernet Sauvignon"] },
  { region: "Piedmont", country: "Italy", varietals: ["Nebbiolo", "Barbera", "Dolcetto"] },
  { region: "Veneto", country: "Italy", varietals: ["Corvina", "Garganega"] },
  { region: "Sicily", country: "Italy", varietals: ["Nero d'Avola", "Grillo"] },
  { region: "Rioja", country: "Spain", varietals: ["Tempranillo", "Garnacha"] },
  { region: "Ribera del Duero", country: "Spain", varietals: ["Tempranillo"] },
  { region: "Priorat", country: "Spain", varietals: ["Garnacha", "Carinena"] },
  { region: "Rias Baixas", country: "Spain", varietals: ["Albarino"] },
  { region: "Napa Valley", country: "United States", varietals: ["Cabernet Sauvignon", "Merlot", "Chardonnay"] },
  { region: "Sonoma County", country: "United States", varietals: ["Pinot Noir", "Zinfandel", "Chardonnay"] },
  { region: "Willamette Valley", country: "United States", varietals: ["Pinot Noir", "Pinot Gris"] },
  { region: "Barossa Valley", country: "Australia", varietals: ["Shiraz", "Grenache"] },
  { region: "Margaret River", country: "Australia", varietals: ["Cabernet Sauvignon", "Chardonnay"] },
  { region: "Central Otago", country: "New Zealand", varietals: ["Pinot Noir"] },
  { region: "Marlborough", country: "New Zealand", varietals: ["Sauvignon Blanc"] },
  { region: "Mosel", country: "Germany", varietals: ["Riesling"] },
  { region: "Rheingau", country: "Germany", varietals: ["Riesling"] },
  { region: "Wachau", country: "Austria", varietals: ["Gruner Veltliner", "Riesling"] },
  { region: "Douro", country: "Portugal", varietals: ["Touriga Nacional"] },
  { region: "Stellenbosch", country: "South Africa", varietals: ["Cabernet Sauvignon", "Chenin Blanc"] },
  { region: "Mendoza", country: "Argentina", varietals: ["Malbec"] },
  { region: "Casablanca Valley", country: "Chile", varietals: ["Sauvignon Blanc", "Pinot Noir"] },
  { region: "Colchagua Valley", country: "Chile", varietals: ["Cabernet Sauvignon", "Carmenere"] },
];

const OLD_WORLD_COUNTRIES = new Set(["France", "Italy", "Spain", "Germany", "Austria", "Portugal"]);

const VINEYARD_NAMES = [
  "Clos des Cerisiers", "Les Fournaux", "La Combe aux Loups", "Clos Saint-Martin",
  "Les Terrasses", "Clos du Moulin", "La Croix Blanche", "Les Chaumes",
  "Clos de la Chapelle", "La Vigna Alta", "Podere del Sole", "Vigneto delle Rose",
  "Terra Bruna", "Colline d'Oro", "El Rincon", "Vina del Alto", "Ladera Antigua",
  "Cuesta del Rio", "Terrassenlage", "Steilhang Reserve", "Alte Reben",
  "Quinta da Serra", "Vale do Rio", "Encosta Dourada", "Les Grandes Vignes",
  "Le Clos Perdu", "La Petite Combe", "Vigna del Vento", "Costa Alta",
  "Ribera Alta", "Weinberg Reserve", "Sonnenlage", "Le Clos Fleuri",
];

// Build a fixed, deterministic pool of "standard" producers (no RNG — pure
// function of loop indices, so it never shifts the PRNG draw sequence).
function buildStandardProducerPool() {
  const pool = [];
  const PRODUCERS_PER_PROFILE = 8;
  REGION_PROFILES.forEach((profile, profileIndex) => {
    const poolKey = COUNTRY_TO_SURNAME_POOL[profile.country];
    const surnames = SURNAME_POOLS[poolKey];
    for (let i = 0; i < PRODUCERS_PER_PROFILE; i++) {
      const surname = surnames[(profileIndex * PRODUCERS_PER_PROFILE + i) % surnames.length];
      let producer;
      if (PREFIXLESS_SUFFIX_COUNTRIES.has(profile.country)) {
        const suffix = SUFFIX_WORDS[i % SUFFIX_WORDS.length];
        producer = `${surname} ${suffix}`;
      } else {
        const prefixes = PREFIX_BY_COUNTRY[profile.country];
        const prefix = prefixes[i % prefixes.length];
        producer = `${prefix} ${surname}`;
      }
      pool.push({ producer, region: profile.region, country: profile.country, varietals: profile.varietals });
    }
  });
  return pool;
}

const STANDARD_PRODUCER_POOL = buildStandardProducerPool();

const LONG_TAIL_ADJ = [
  "Hollow", "Thistledown", "Kestrel", "Windward", "Amber", "Copper", "Stonebridge",
  "Silent", "Crooked", "Half Moon", "Tin Roof", "Rusted", "Widows Peak",
  "Broken Wheel", "Sable", "Raven", "Marrow", "Whistling", "Iron Gate",
  "Sundown", "Fox Hollow", "Bridle", "Lantern", "Foggy Bend", "Granite", "Weathered",
];
const LONG_TAIL_NOUN = [
  "Creek", "Ridge", "Hollow", "Farms", "Orchard", "Hill", "Bend", "Crossing",
  "Meadows", "Gulch", "Bluff", "Draw", "Pass", "Rise", "Flat", "Bottom",
];
const LONG_TAIL_SUFFIX = ["Vineyard", "Vineyards", "Cellars", "Estate", "Wine Co.", "Winery"];

const NEW_WORLD_CUVEE_TEMPLATES = [
  (v) => v,
  (v) => `${v} Reserve`,
  (v) => `Estate ${v}`,
  (v) => `Old Vine ${v}`,
  (v) => `Single Vineyard ${v}`,
];

const CURRENCIES = [
  { code: "USD", weight: 0.8 },
  { code: "EUR", weight: 0.12 },
  { code: "GBP", weight: 0.08 },
];

const SUPPLIERS = [
  "Henderson Wine Imports", "Cellar Direct Distributors", "Old World Selections",
  "Vintners Alliance", "Riverside Wine Co.", "Global Cru Imports",
  "Heritage Wine Merchants", "Coastal Cellar Supply",
];

const RED_VARIETALS = new Set([
  "Cabernet Sauvignon", "Merlot", "Cabernet Franc", "Bordeaux Blend", "Pinot Noir",
  "Syrah", "Grenache", "Rhone Blend", "Sangiovese", "Nebbiolo", "Barbera",
  "Dolcetto", "Corvina", "Nero d'Avola", "Tempranillo", "Garnacha", "Carinena",
  "Zinfandel", "Shiraz", "Touriga Nacional", "Malbec", "Carmenere",
  "Super Tuscan Blend", "Tempranillo Blend", "Port Blend",
]);
const WHITE_VARIETALS = new Set([
  "Chardonnay", "Chenin Blanc", "Sauvignon Blanc", "Riesling", "Gewurztraminer",
  "Pinot Gris", "Garganega", "Albarino", "Gruner Veltliner", "Semillon-Sauvignon Blend",
  "Palomino",
]);

function sectionForVarietal(varietal, category) {
  if (category === "champagne") return "Sparkling";
  if (category === "sherry" || category === "port") return "Fortified";
  if (RED_VARIETALS.has(varietal)) return "Reds";
  if (WHITE_VARIETALS.has(varietal)) return "Whites";
  return "Cellar";
}

// ---------------------------------------------------------------------------
// Dedicated spelling-noise seeds (40 total: 10 per category).
// ---------------------------------------------------------------------------

function nfc(s) { return s.normalize("NFC"); }
function nfd(s) { return s.normalize("NFD"); }

const SPELLING_SEEDS = [
  // accent_stripped (10) — Chateau/Chateau, Domane/Domane, Senorio/Senorio
  { type: "accent_stripped", producer: "Château Belair-Vauban", altProducer: "Chateau Belair-Vauban", name: "Grand Vin", varies: "producer", varietal: "Bordeaux Blend", region: "Bordeaux", country: "France", vintage: 2016 },
  { type: "accent_stripped", producer: "Château Roquefeuille", altProducer: "Chateau Roquefeuille", name: "Cuvee Prestige", varies: "producer", varietal: "Bordeaux Blend", region: "Bordeaux", country: "France", vintage: 2015 },
  { type: "accent_stripped", producer: "Château Lévêque", altProducer: "Chateau Leveque", name: "Reserve", varies: "producer", varietal: "Bordeaux Blend", region: "Bordeaux", country: "France", vintage: 2014 },
  { type: "accent_stripped", producer: "Château Éperon", altProducer: "Chateau Eperon", name: "Grand Vin", varies: "producer", varietal: "Bordeaux Blend", region: "Bordeaux", country: "France", vintage: 2017 },
  { type: "accent_stripped", producer: "Domäne Falkenstein", altProducer: "Domane Falkenstein", name: "Gruner Veltliner Smaragd", varies: "producer", varietal: "Gruner Veltliner", region: "Wachau", country: "Austria", vintage: 2019 },
  { type: "accent_stripped", producer: "Domäne Wachtberg", altProducer: "Domane Wachtberg", name: "Riesling Federspiel", varies: "producer", varietal: "Riesling", region: "Wachau", country: "Austria", vintage: 2018 },
  { type: "accent_stripped", producer: "Domäne Höflein", altProducer: "Domane Hoflein", name: "Gruner Veltliner", varies: "producer", varietal: "Gruner Veltliner", region: "Wachau", country: "Austria", vintage: 2020 },
  { type: "accent_stripped", producer: "Señorío de Valdemoro", altProducer: "Senorio de Valdemoro", name: "Crianza", varies: "producer", varietal: "Tempranillo", region: "Rioja", country: "Spain", vintage: 2017 },
  { type: "accent_stripped", producer: "Señorío de Peñaflor", altProducer: "Senorio de Penaflor", name: "Reserva", varies: "producer", varietal: "Tempranillo", region: "Rioja", country: "Spain", vintage: 2015 },
  { type: "accent_stripped", producer: "Señorío de Íñigo", altProducer: "Senorio de Inigo", name: "Gran Reserva", varies: "producer", varietal: "Tempranillo", region: "Rioja", country: "Spain", vintage: 2012 },

  // nfc_nfd (10) — same visible producer string, NFC vs NFD codepoints
  ...[
    ["Domaine René Léveillé", "Reserve Bottling", 2016],
    ["Château Bélisle", "Estate Cuvee", 2015],
    ["Domaine Hélène Pérrier", "Vintage Selection", 2014],
    ["Clos Béatrice", "Grand Cru", 2013],
    ["Maison Frédéric Noël", "Cuvee Speciale", 2017],
    ["Domaine André Léger", "Premier Cru", 2018],
    ["Château Désiré", "Grand Vin", 2012],
    ["Domaine Céline Pêcheur", "Vieilles Vignes", 2016],
    ["Clos Théo Vérité", "Estate Reserve", 2019],
    ["Maison Irène Bélanger", "Cuvee Tradition", 2011],
  ].map(([producer, name, vintage]) => ({
    type: "nfc_nfd",
    producer: nfc(producer),
    altProducer: nfd(producer),
    name,
    varies: "producer",
    varietal: "Pinot Noir",
    region: "Burgundy",
    country: "France",
    vintage,
  })),

  // punctuation_spacing (10) — hyphen/space, ligature, abbreviation, double-space
  { type: "punctuation_spacing", producer: "Domaine du Clos", name: "Clos-de-Tart", altName: "Clos de Tart", varies: "name", varietal: "Pinot Noir", region: "Burgundy", country: "France", vintage: 2016 },
  { type: "punctuation_spacing", producer: "Domaine des Grands Crus", name: "Charmes-Chambertin", altName: "Charmes Chambertin", varies: "name", varietal: "Pinot Noir", region: "Burgundy", country: "France", vintage: 2015 },
  { type: "punctuation_spacing", producer: "Domaine des Grands Crus", name: "Ruchottes-Chambertin", altName: "Ruchottes Chambertin", varies: "name", varietal: "Pinot Noir", region: "Burgundy", country: "France", vintage: 2014 },
  { type: "punctuation_spacing", producer: "Maison Lefevre", name: "Pouilly-Fuisse", altName: "Pouilly Fuisse ", varies: "name", varietal: "Chardonnay", region: "Burgundy", country: "France", vintage: 2018 },
  { type: "punctuation_spacing", producer: "Domaine Perrin", name: "Cœur d'Alsace", altName: "Coeur d'Alsace", varies: "name", varietal: "Riesling", region: "Alsace", country: "France", vintage: 2017 },
  { type: "punctuation_spacing", producer: "Domaine Aubert", name: "Clos-Saint-Jacques", altName: "Clos Saint Jacques", varies: "name", varietal: "Pinot Noir", region: "Burgundy", country: "France", vintage: 2016 },
  { type: "punctuation_spacing", producer: "Domaine Fontaine", name: "En Caradeux", altName: "En  Caradeux", varies: "name", varietal: "Chardonnay", region: "Burgundy", country: "France", vintage: 2019 },
  { type: "punctuation_spacing", producer: "Chateau La Croix", name: "Cote-Rotie", altName: "Cote Rotie", varies: "name", varietal: "Syrah", region: "Rhone Valley", country: "France", vintage: 2015 },
  { type: "punctuation_spacing", producer: "Domaine Girard", name: "Clos-Vougeot", altName: "Clos Vougeot", varies: "name", varietal: "Pinot Noir", region: "Burgundy", country: "France", vintage: 2013 },
  { type: "punctuation_spacing", producer: "Maison Bonnet", name: "Meursault-Perrieres", altName: "Meursault Perrieres", varies: "name", varietal: "Chardonnay", region: "Burgundy", country: "France", vintage: 2017 },

  // producer_reorder (10) — "Domaine Firstname Lastname" vs "Firstname Lastname Domaine"
  { type: "producer_reorder", producer: "Domaine Jean Grivot", altProducer: "Jean Grivot Domaine", name: "Vosne-Romanee", varies: "producer", varietal: "Pinot Noir", region: "Burgundy", country: "France", vintage: 2016 },
  { type: "producer_reorder", producer: "Domaine Marc Colin", altProducer: "Marc Colin Domaine", name: "Saint-Aubin", varies: "producer", varietal: "Chardonnay", region: "Burgundy", country: "France", vintage: 2017 },
  { type: "producer_reorder", producer: "Domaine Anne Gros", altProducer: "Anne Gros Domaine", name: "Clos Vougeot", varies: "producer", varietal: "Pinot Noir", region: "Burgundy", country: "France", vintage: 2015 },
  { type: "producer_reorder", producer: "Domaine Henri Boillot", altProducer: "Henri Boillot Domaine", name: "Meursault", varies: "producer", varietal: "Chardonnay", region: "Burgundy", country: "France", vintage: 2018 },
  { type: "producer_reorder", producer: "Domaine Sylvain Cathiard", altProducer: "Sylvain Cathiard Domaine", name: "Vosne-Romanee Premier Cru", varies: "producer", varietal: "Pinot Noir", region: "Burgundy", country: "France", vintage: 2014 },
  { type: "producer_reorder", producer: "Domaine Georges Roumier", altProducer: "Georges Roumier Domaine", name: "Chambolle-Musigny", varies: "producer", varietal: "Pinot Noir", region: "Burgundy", country: "France", vintage: 2013 },
  { type: "producer_reorder", producer: "Domaine Louis Jadot", altProducer: "Louis Jadot Domaine", name: "Beaune", varies: "producer", varietal: "Pinot Noir", region: "Burgundy", country: "France", vintage: 2016 },
  { type: "producer_reorder", producer: "Domaine Pierre Morey", altProducer: "Pierre Morey Domaine", name: "Puligny-Montrachet", varies: "producer", varietal: "Chardonnay", region: "Burgundy", country: "France", vintage: 2019 },
  { type: "producer_reorder", producer: "Domaine Michel Gros", altProducer: "Michel Gros Domaine", name: "Vosne-Romanee Clos", varies: "producer", varietal: "Pinot Noir", region: "Burgundy", country: "France", vintage: 2012 },
  { type: "producer_reorder", producer: "Domaine Robert Groffier", altProducer: "Robert Groffier Domaine", name: "Bonnes-Mares", varies: "producer", varietal: "Pinot Noir", region: "Burgundy", country: "France", vintage: 2011 },
];

// ---------------------------------------------------------------------------
// Famous benchmark wines (25 vintage-dated families + 5 famous NV).
// ---------------------------------------------------------------------------

const FAMOUS_VINTAGES = [1996, 2005, 2010, 2015, 2018];

const FAMOUS_FAMILIES = [
  { producer: "Domaine de la Romanee-Conti", name: "Romanee-Conti", varietal: "Pinot Noir", region: "Burgundy", country: "France" },
  { producer: "Chateau Mouton Rothschild", name: "Grand Vin", varietal: "Bordeaux Blend", region: "Pauillac", country: "France" },
  { producer: "Chateau Latour", name: "Grand Vin", varietal: "Bordeaux Blend", region: "Pauillac", country: "France" },
  { producer: "Chateau Lafite Rothschild", name: "Grand Vin", varietal: "Bordeaux Blend", region: "Pauillac", country: "France" },
  { producer: "Chateau Margaux", name: "Grand Vin", varietal: "Bordeaux Blend", region: "Margaux", country: "France" },
  { producer: "Chateau Haut-Brion", name: "Grand Vin", varietal: "Bordeaux Blend", region: "Pessac-Leognan", country: "France" },
  { producer: "Chateau Petrus", name: "Petrus", varietal: "Merlot", region: "Pomerol", country: "France" },
  { producer: "Chateau Cheval Blanc", name: "Grand Vin", varietal: "Bordeaux Blend", region: "Saint-Emilion", country: "France" },
  { producer: "Chateau d'Yquem", name: "Grand Vin", varietal: "Semillon-Sauvignon Blend", region: "Sauternes", country: "France" },
  { producer: "Domaine Leroy", name: "Musigny", varietal: "Pinot Noir", region: "Burgundy", country: "France" },
  { producer: "Screaming Eagle", name: "Cabernet Sauvignon", varietal: "Cabernet Sauvignon", region: "Napa Valley", country: "United States" },
  { producer: "Harlan Estate", name: "Estate", varietal: "Cabernet Sauvignon", region: "Napa Valley", country: "United States" },
  { producer: "Opus One", name: "Opus One", varietal: "Bordeaux Blend", region: "Napa Valley", country: "United States" },
  { producer: "Colgin Cellars", name: "IX Estate", varietal: "Cabernet Sauvignon", region: "Napa Valley", country: "United States" },
  { producer: "Bond", name: "Vecina", varietal: "Cabernet Sauvignon", region: "Napa Valley", country: "United States" },
  { producer: "Ridge Vineyards", name: "Monte Bello", varietal: "Cabernet Sauvignon", region: "Santa Cruz Mountains", country: "United States" },
  { producer: "Vega Sicilia", name: "Unico", varietal: "Tempranillo Blend", region: "Ribera del Duero", country: "Spain" },
  { producer: "Gaja", name: "Barbaresco", varietal: "Nebbiolo", region: "Piedmont", country: "Italy" },
  { producer: "Tenuta San Guido", name: "Sassicaia", varietal: "Cabernet Sauvignon", region: "Tuscany", country: "Italy" },
  { producer: "Ornellaia", name: "Ornellaia", varietal: "Bordeaux Blend", region: "Tuscany", country: "Italy" },
  { producer: "Antinori", name: "Tignanello", varietal: "Super Tuscan Blend", region: "Tuscany", country: "Italy" },
  { producer: "Penfolds", name: "Grange", varietal: "Shiraz", region: "Barossa Valley", country: "Australia" },
  { producer: "Egon Muller", name: "Scharzhofberger", varietal: "Riesling", region: "Mosel", country: "Germany" },
  { producer: "Sine Qua Non", name: "Estate Cuvee", varietal: "Rhone Blend", region: "Central Coast", country: "United States" },
  { producer: "Chateau Cos d'Estournel", name: "Grand Vin", varietal: "Bordeaux Blend", region: "Saint-Estephe", country: "France" },
];

const FAMOUS_NV_SEEDS = [
  { producer: "Krug", name: "Grande Cuvee" },
  { producer: "Bollinger", name: "Special Cuvee" },
  { producer: "Veuve Clicquot", name: "Yellow Label Brut" },
  { producer: "Moet & Chandon", name: "Imperial Brut" },
  { producer: "Taittinger", name: "Brut Reserve" },
].map((s) => ({ ...s, varietal: "Champagne Blend", region: "Champagne", country: "France" }));

// ---------------------------------------------------------------------------
// NV (Champagne / Sherry / Port) generic pool.
// ---------------------------------------------------------------------------

const NV_KINDS = [
  {
    kind: "champagne", region: "Champagne", country: "France", varietal: "Champagne Blend",
    prefixes: ["Maison", "Caves", "Domaine"], surnamePool: "french",
    names: ["Brut Reserve", "Brut Rose NV", "Blanc de Blancs NV", "Blanc de Noirs NV", "Brut Tradition"],
  },
  {
    kind: "sherry", region: "Jerez", country: "Spain", varietal: "Palomino",
    prefixes: ["Bodega", "Bodegas", "Hacienda"], surnamePool: "spanish",
    names: ["Fino", "Manzanilla", "Amontillado", "Oloroso", "Cream Sherry", "Palo Cortado"],
  },
  {
    kind: "port", region: "Douro", country: "Portugal", varietal: "Port Blend",
    prefixes: ["Quinta da", "Quinta do", "Casa"], surnamePool: "portuguese",
    names: ["Ruby Port", "Tawny Port", "10 Year Tawny", "20 Year Tawny", "White Port", "Fine Ruby Reserve"],
  },
];

// ---------------------------------------------------------------------------
// Generation pipeline
// ---------------------------------------------------------------------------

function makeUniverse() {
  const globalKeys = new Set();

  function register(producer, name, vintage, sizeMl) {
    const key = variantKey(producer, name, vintage, sizeMl);
    if (globalKeys.has(key)) return null;
    globalKeys.add(key);
    return key;
  }

  return { register };
}

function pickUnique(universe, rng, buildFn, maxAttempts = 500) {
  for (let i = 0; i < maxAttempts; i++) {
    const seed = buildFn();
    const key = universe.register(seed.producer, seed.name, seed.vintage ?? null, seed.sizeMl ?? 750);
    if (key) return seed;
  }
  throw new Error("pickUnique: exhausted attempts without finding a fresh variant key");
}

function pickRegularSeed(rng, { forceLongTail = false } = {}) {
  const useLongTail = forceLongTail || rng.chance(0.15);
  if (useLongTail) {
    const profile = rng.pick(REGION_PROFILES);
    const producer = `${rng.pick(LONG_TAIL_ADJ)} ${rng.pick(LONG_TAIL_NOUN)} ${rng.pick(LONG_TAIL_SUFFIX)}`;
    const varietal = rng.pick(profile.varietals);
    const name = buildCuveeName(rng, profile, varietal);
    const vintage = rng.int(1975, 2023);
    return { producer, name, varietal, region: profile.region, country: profile.country, vintage, sizeMl: 750, longTail: true };
  }
  const entry = rng.pick(STANDARD_PRODUCER_POOL);
  const varietal = rng.pick(entry.varietals);
  const profile = { region: entry.region, country: entry.country };
  const name = buildCuveeName(rng, profile, varietal);
  const vintage = rng.int(1975, 2023);
  return { producer: entry.producer, name, varietal, region: entry.region, country: entry.country, vintage, sizeMl: 750, longTail: false };
}

function buildCuveeName(rng, profile, varietal) {
  if (OLD_WORLD_COUNTRIES.has(profile.country)) {
    const vineyard = rng.pick(VINEYARD_NAMES);
    return rng.chance(0.5) ? vineyard : `${vineyard} ${varietal}`;
  }
  const template = rng.pick(NEW_WORLD_CUVEE_TEMPLATES);
  return template(varietal);
}

function sampleQuantity(rng) {
  return Math.min(120, 1 + Math.floor(rng.next() * rng.next() * 130));
}

// Log-uniform in [8, 5000] — heavily weighted toward cheap bottles like a
// real cellar, approximating the requested "log-normal-ish" shape without
// needing mean/stdev parameters.
function sampleUnitCost(rng) {
  const logMin = Math.log(8);
  const logMax = Math.log(5000);
  return Math.round(Math.exp(rng.float(logMin, logMax)) * 100) / 100;
}

function sampleCurrency(rng) {
  const roll = rng.next();
  let acc = 0;
  for (const c of CURRENCIES) {
    acc += c.weight;
    if (roll < acc) return c.code;
  }
  return CURRENCIES[0].code;
}

function sampleBin(rng) {
  const zone = rng.pick(["A", "B", "C", "D", "R", "S"]);
  return `${zone}${rng.int(1, 40)}-${rng.int(1, 12)}`;
}

function sampleExtras(rng, unitCost) {
  const hasBarcode = rng.chance(0.2);
  let barcode = "";
  if (hasBarcode) {
    let twelve = "0";
    for (let i = 0; i < 11; i++) twelve += rng.int(0, 9);
    barcode = twelve + String(computeEan13CheckDigit(twelve));
  }
  const supplier = rng.pick(SUPPLIERS);
  const epochMs = Date.UTC(2015, 0, 1) + rng.int(0, 3650) * 86400000;
  const acquisitionDate = new Date(epochMs).toISOString().slice(0, 10);
  return { barcode, supplier, acquisitionDate, purchasePrice: unitCost.toFixed(2) };
}

const DIRTY_VINTAGE_TEXTS = ["NV", "MCMXCIX", "circa 1998", "'98", "202X", "not sure", "19-something"];

function buildVariants(rng, universe) {
  const variants = [];
  let nextId = 1;

  function push(seed, tags) {
    variants.push({ id: nextId++, ...seed, tags });
  }

  // Famous vintage-dated families.
  for (const fam of FAMOUS_FAMILIES) {
    for (const vintage of FAMOUS_VINTAGES) {
      const seed = pickUnique(universe, rng, () => ({ producer: fam.producer, name: fam.name, varietal: fam.varietal, region: fam.region, country: fam.country, vintage, sizeMl: 750 }));
      push(seed, { famous: true, nv: false, longTail: false, adjacentFamily: null, formatFamily: null, spellingGroupId: null, spellingType: null });
    }
  }

  // Famous NV.
  for (const fam of FAMOUS_NV_SEEDS) {
    const seed = pickUnique(universe, rng, () => ({ producer: fam.producer, name: fam.name, varietal: fam.varietal, region: fam.region, country: fam.country, vintage: null, sizeMl: 750 }));
    push(seed, { famous: true, nv: true, longTail: false, adjacentFamily: null, formatFamily: null, spellingGroupId: null, spellingType: null });
  }

  // Spelling-noise dedicated seeds.
  SPELLING_SEEDS.forEach((seed, i) => {
    const groupId = `sg-${String(i + 1).padStart(3, "0")}`;
    const canonical = pickUnique(universe, rng, () => ({ producer: seed.producer, name: seed.name, varietal: seed.varietal, region: seed.region, country: seed.country, vintage: seed.vintage, sizeMl: 750 }));
    const altSpelling = seed.varies === "producer"
      ? { producer: seed.altProducer, name: seed.name }
      : { producer: seed.producer, name: seed.altName };
    variants.push({
      id: nextId++,
      ...canonical,
      altSpelling,
      tags: { famous: false, nv: false, longTail: false, adjacentFamily: null, formatFamily: null, spellingGroupId: groupId, spellingType: seed.type },
    });
  });

  // Adjacent-vintage families (2014/2015/2016 as genuinely distinct variants).
  for (let f = 0; f < 30; f++) {
    const familyId = `av-${String(f + 1).padStart(3, "0")}`;
    // NB: `base` is only a producer/name/varietal template, not itself a
    // variant — it must NOT be registered in the uniqueness universe (that
    // would pre-consume one of the three vintage slots below and force a
    // guaranteed collision). Only the three constructed vintage variants are
    // registered, via the pickUnique calls inside this loop.
    const base = pickRegularSeed(rng);
    for (const vintage of [2014, 2015, 2016]) {
      const seed = pickUnique(universe, rng, () => ({ producer: base.producer, name: base.name, varietal: base.varietal, region: base.region, country: base.country, vintage, sizeMl: 750 }));
      push(seed, { famous: false, nv: false, longTail: base.longTail, adjacentFamily: familyId, formatFamily: null, spellingGroupId: null, spellingType: null });
    }
  }

  // Format-sibling families (375/750/1500/3000 as genuinely distinct variants).
  for (let f = 0; f < 25; f++) {
    const familyId = `fs-${String(f + 1).padStart(3, "0")}`;
    // Same rationale as the adjacent-vintage loop above: `base` is a
    // template only, not a variant — registering it would pre-consume the
    // 750ml slot and guarantee a collision when the size loop reaches 750.
    const base = pickRegularSeed(rng);
    for (const sizeMl of [375, 750, 1500, 3000]) {
      const seed = pickUnique(universe, rng, () => ({ producer: base.producer, name: base.name, varietal: base.varietal, region: base.region, country: base.country, vintage: base.vintage, sizeMl }));
      push(seed, { famous: false, nv: false, longTail: base.longTail, adjacentFamily: null, formatFamily: familyId, spellingGroupId: null, spellingType: null });
    }
  }

  // NV regular pool (255).
  for (let i = 0; i < 255; i++) {
    const seed = pickUnique(universe, rng, () => {
      const kind = NV_KINDS[i % NV_KINDS.length];
      const surnames = SURNAME_POOLS[kind.surnamePool];
      const surname = rng.pick(surnames);
      const prefix = rng.pick(kind.prefixes);
      const producer = `${prefix} ${surname}`;
      const name = rng.pick(kind.names);
      return { producer, name, varietal: kind.varietal, region: kind.region, country: kind.country, vintage: null, sizeMl: 750 };
    });
    push(seed, { famous: false, nv: true, longTail: false, adjacentFamily: null, formatFamily: null, spellingGroupId: null, spellingType: null });
  }

  // NV literal-text pool — same non-vintage wine styles as the pool above,
  // but tagged separately (nvLiteral) so the manifest and CSV rendering can
  // treat them as their own group: cleanRecordToCells writes the literal
  // text "NV" into the vintage column for these instead of leaving it
  // blank. The current row-validator (row-validator.ts) rejects non-numeric
  // vintage text, so every row in this group is a documented, tagged,
  // expected-invalid case under today's importer — not a blank/missing
  // vintage like the pool above.
  for (let i = 0; i < NV_LITERAL_VARIANT_COUNT; i++) {
    const seed = pickUnique(universe, rng, () => {
      const kind = NV_KINDS[i % NV_KINDS.length];
      const surnames = SURNAME_POOLS[kind.surnamePool];
      const surname = rng.pick(surnames);
      const prefix = rng.pick(kind.prefixes);
      const producer = `${prefix} ${surname}`;
      const name = rng.pick(kind.names);
      return { producer, name, varietal: kind.varietal, region: kind.region, country: kind.country, vintage: null, sizeMl: 750 };
    });
    push(seed, { famous: false, nv: false, nvLiteral: true, longTail: false, adjacentFamily: null, formatFamily: null, spellingGroupId: null, spellingType: null });
  }

  // Regular pool — fills the remainder up to TARGET_VARIANT_TOTAL.
  const consumedSoFar = variants.length;
  const regularCount = TARGET_VARIANT_TOTAL - consumedSoFar;
  for (let i = 0; i < regularCount; i++) {
    const seed = pickUnique(universe, rng, () => pickRegularSeed(rng));
    push(seed, { famous: false, nv: false, longTail: seed.longTail, adjacentFamily: null, formatFamily: null, spellingGroupId: null, spellingType: null });
  }

  return variants;
}

function assignRowCounts(variants, rng, { continueProb = 0.79, cap = 40 } = {}) {
  const minFor = (v) => (v.tags.spellingGroupId ? 4 : 1);
  const counts = variants.map((v) => {
    let c = 1;
    while (rng.chance(continueProb) && c < cap) c++;
    return Math.max(c, minFor(v));
  });
  let sum = counts.reduce((a, b) => a + b, 0);
  let delta = TOTAL_ROWS - sum;
  const n = counts.length;
  let i = 0;
  let guard = 0;
  while (delta !== 0 && guard < 50 * n) {
    guard++;
    const idx = i % n;
    if (delta > 0) {
      counts[idx]++;
      delta--;
    } else if (counts[idx] > minFor(variants[idx])) {
      counts[idx]--;
      delta++;
    }
    i++;
  }
  if (delta !== 0) throw new Error(`assignRowCounts: could not balance to ${TOTAL_ROWS} (off by ${delta})`);
  return counts;
}

function buildPurchaseRecords(variants, rowCounts, rng, extras) {
  const records = [];
  variants.forEach((v, idx) => {
    const count = rowCounts[idx];
    for (let k = 0; k < count; k++) {
      const category = (v.tags.nv || v.tags.nvLiteral) ? NV_KINDS.find((kk) => kk.varietal === v.varietal)?.kind ?? null : null;
      const quantity = sampleQuantity(rng);
      const unitCost = sampleUnitCost(rng);
      const currency = sampleCurrency(rng);
      const bin = sampleBin(rng);
      const section = sectionForVarietal(v.varietal, category);
      let spellingFormUsed = null;
      let producer = v.producer;
      let name = v.name;
      if (v.altSpelling) {
        const useAlt = rng.chance(0.45);
        spellingFormUsed = useAlt ? "alt" : "canonical";
        if (useAlt) {
          producer = v.altSpelling.producer;
          name = v.altSpelling.name;
        }
      }
      const record = { variant: v, producer, name, quantity, unitCost, currency, bin, section, spellingFormUsed };
      if (extras) record.extra = sampleExtras(rng, unitCost);
      records.push(record);
    }
  });

  // Guarantee both spelling forms are represented for every spelling group.
  for (const v of variants) {
    if (!v.altSpelling) continue;
    const recs = records.filter((r) => r.variant === v);
    const hasCanonical = recs.some((r) => r.spellingFormUsed === "canonical");
    const hasAlt = recs.some((r) => r.spellingFormUsed === "alt");
    if (!hasCanonical) {
      recs[0].spellingFormUsed = "canonical";
      recs[0].producer = v.producer;
      recs[0].name = v.name;
    }
    if (!hasAlt) {
      recs[recs.length - 1].spellingFormUsed = "alt";
      recs[recs.length - 1].producer = v.altSpelling.producer;
      recs[recs.length - 1].name = v.altSpelling.name;
    }
  }

  return records;
}

function buildDirtyRecords(rng) {
  const records = [];
  const perCategory = [
    { category: "bad_vintage_text", count: 17 },
    { category: "negative_quantity", count: 17 },
    { category: "oversized_field", count: 16 },
  ];
  let vintageTextIdx = 0;
  for (const { category, count } of perCategory) {
    for (let i = 0; i < count; i++) {
      const carrier = pickRegularSeed(rng);
      const quantity = sampleQuantity(rng);
      const unitCost = sampleUnitCost(rng);
      const currency = sampleCurrency(rng);
      const bin = sampleBin(rng);
      const section = sectionForVarietal(carrier.varietal, null);
      const record = {
        producer: carrier.producer,
        name: carrier.name,
        vintage: carrier.vintage,
        varietal: carrier.varietal,
        region: carrier.region,
        country: carrier.country,
        sizeMl: 750,
        quantity,
        unitCost,
        currency,
        bin,
        section,
        dirtyCategory: category,
      };
      if (category === "bad_vintage_text") {
        record.vintageOverride = DIRTY_VINTAGE_TEXTS[vintageTextIdx % DIRTY_VINTAGE_TEXTS.length];
        vintageTextIdx++;
        record.detail = `vintage set to non-numeric text: "${record.vintageOverride}"`;
      } else if (category === "negative_quantity") {
        record.quantityOverride = String(-rng.int(1, 60));
        record.detail = `quantity set to negative value: "${record.quantityOverride}"`;
      } else {
        // Guarantee > MAX_FIELD_LENGTH (2000) regardless of how short the
        // carrier producer name happens to be (a naive fixed repeat count
        // can undershoot for short names, e.g. "Cano Wines").
        const unit = `${carrier.producer} `;
        const repeatCount = Math.ceil(2200 / unit.length) + 1;
        record.producerOverride = unit.repeat(repeatCount).slice(0, 2200);
        record.detail = `producer field padded to ${record.producerOverride.length} chars (exceeds MAX_FIELD_LENGTH=2000)`;
      }
      records.push(record);
    }
  }
  return records;
}

function generateDataset({ seed = SEED, extras = false, dirty = false } = {}) {
  const rng = makeRng(seed);
  const universe = makeUniverse();
  const variants = buildVariants(rng, universe);
  const rowCounts = assignRowCounts(variants, rng);
  const records = buildPurchaseRecords(variants, rowCounts, rng, extras);
  rng.shuffle(records);
  records.forEach((r, i) => {
    r.rowIndex = i + 1;
  });

  let dirtyRecords = [];
  if (dirty) {
    dirtyRecords = buildDirtyRecords(rng);
    dirtyRecords.forEach((r, i) => {
      r.rowIndex = records.length + i + 1;
    });
  }

  return { variants, records, dirtyRecords, extras, dirty };
}

// ---------------------------------------------------------------------------
// CSV + manifest rendering
// ---------------------------------------------------------------------------

function headerRow(extras) {
  return extras ? [...CANONICAL_HEADERS, ...EXTRA_HEADERS] : [...CANONICAL_HEADERS];
}

function cleanRecordToCells(r, extras) {
  const v = r.variant;
  const cells = [
    r.producer,
    r.name,
    v.tags.nvLiteral ? "NV" : (v.vintage === null ? "" : String(v.vintage)),
    v.varietal,
    v.region,
    v.country,
    String(v.sizeMl),
    FORMAT_LABEL[v.sizeMl],
    r.currency,
    String(r.quantity),
    r.unitCost.toFixed(2),
    r.bin,
    r.section,
  ];
  if (extras) {
    cells.push(r.extra.barcode, r.extra.supplier, r.extra.acquisitionDate, r.extra.purchasePrice);
  }
  return cells;
}

function dirtyRecordToCells(r, extras) {
  const producer = r.dirtyCategory === "oversized_field" ? r.producerOverride : r.producer;
  const vintage = r.dirtyCategory === "bad_vintage_text" ? r.vintageOverride : (r.vintage === null ? "" : String(r.vintage));
  const quantity = r.dirtyCategory === "negative_quantity" ? r.quantityOverride : String(r.quantity);
  const cells = [
    producer,
    r.name,
    vintage,
    r.varietal,
    r.region,
    r.country,
    String(r.sizeMl),
    FORMAT_LABEL[r.sizeMl],
    r.currency,
    quantity,
    r.unitCost.toFixed(2),
    r.bin,
    r.section,
  ];
  if (extras) cells.push("", "", "", "");
  return cells;
}

function toCsvText(records, dirtyRecords, extras) {
  const lines = [headerRow(extras).map(csvField).join(",")];
  for (const r of records) lines.push(cleanRecordToCells(r, extras).map(csvField).join(","));
  for (const r of dirtyRecords) lines.push(dirtyRecordToCells(r, extras).map(csvField).join(","));
  return lines.join("\n") + "\n";
}

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildManifest(records, dirtyRecords, extras, csvText, universeVariantCount) {
  const presentVariantIds = new Set(records.map((r) => r.variant.id));
  const uniqueVariantsInFile = presentVariantIds.size;

  const byId = new Map();
  for (const r of records) {
    if (!byId.has(r.variant.id)) byId.set(r.variant.id, { variant: r.variant, rows: [] });
    byId.get(r.variant.id).rows.push(r);
  }

  const categoryTotals = { famous: 0, nv: 0, nvLiteral: 0, longTail: 0, adjacentVintage: 0, formatSibling: 0, spellingNoise: 0 };
  for (const { variant } of byId.values()) {
    if (variant.tags.famous) categoryTotals.famous++;
    if (variant.tags.nv) categoryTotals.nv++;
    if (variant.tags.nvLiteral) categoryTotals.nvLiteral++;
    if (variant.tags.longTail) categoryTotals.longTail++;
    if (variant.tags.adjacentFamily) categoryTotals.adjacentVintage++;
    if (variant.tags.formatFamily) categoryTotals.formatSibling++;
    if (variant.tags.spellingGroupId) categoryTotals.spellingNoise++;
  }

  // duplicate_spelling_groups
  const spellingGroupIds = [...new Set([...byId.values()].map((e) => e.variant.tags.spellingGroupId).filter(Boolean))];
  const duplicateSpellingGroups = spellingGroupIds.map((gid) => {
    const entry = [...byId.values()].find((e) => e.variant.tags.spellingGroupId === gid);
    const v = entry.variant;
    const canonicalRows = entry.rows.filter((r) => r.spellingFormUsed === "canonical").map((r) => r.rowIndex).sort((a, b) => a - b);
    const altRows = entry.rows.filter((r) => r.spellingFormUsed === "alt").map((r) => r.rowIndex).sort((a, b) => a - b);
    return {
      id: gid,
      type: v.tags.spellingType,
      canonical_form: { producer: v.producer, name: v.name },
      alt_form: v.altSpelling,
      vintage: v.vintage,
      size_ml: v.sizeMl,
      canonical_row_indexes: canonicalRows,
      alt_row_indexes: altRows,
    };
  });

  // adjacent_vintage_groups
  const adjacentFamilyIds = [...new Set([...byId.values()].map((e) => e.variant.tags.adjacentFamily).filter(Boolean))];
  const adjacentVintageGroups = adjacentFamilyIds.map((fid) => {
    const members = [...byId.values()].filter((e) => e.variant.tags.adjacentFamily === fid);
    members.sort((a, b) => a.variant.vintage - b.variant.vintage);
    const first = members[0].variant;
    return {
      id: fid,
      producer: first.producer,
      name: first.name,
      size_ml: first.sizeMl,
      vintages: members.map((m) => ({
        vintage: m.variant.vintage,
        variant_key: variantKey(m.variant.producer, m.variant.name, m.variant.vintage, m.variant.sizeMl),
        row_indexes: m.rows.map((r) => r.rowIndex).sort((a, b) => a - b),
      })),
    };
  });

  // format_sibling_groups
  const formatFamilyIds = [...new Set([...byId.values()].map((e) => e.variant.tags.formatFamily).filter(Boolean))];
  const formatSiblingGroups = formatFamilyIds.map((fid) => {
    const members = [...byId.values()].filter((e) => e.variant.tags.formatFamily === fid);
    members.sort((a, b) => a.variant.sizeMl - b.variant.sizeMl);
    const first = members[0].variant;
    return {
      id: fid,
      producer: first.producer,
      name: first.name,
      vintage: first.vintage,
      sizes: members.map((m) => ({
        size_ml: m.variant.sizeMl,
        format: FORMAT_LABEL[m.variant.sizeMl],
        variant_key: variantKey(m.variant.producer, m.variant.name, m.variant.vintage, m.variant.sizeMl),
        row_indexes: m.rows.map((r) => r.rowIndex).sort((a, b) => a - b),
      })),
    };
  });

  const nvVariants = [...byId.values()].filter((e) => e.variant.tags.nv).map((e) => ({
    producer: e.variant.producer,
    name: e.variant.name,
    varietal: e.variant.varietal,
    region: e.variant.region,
    country: e.variant.country,
    famous: e.variant.tags.famous,
    row_indexes: e.rows.map((r) => r.rowIndex).sort((a, b) => a - b),
  }));

  const famousVariants = [...byId.values()].filter((e) => e.variant.tags.famous).map((e) => ({
    producer: e.variant.producer,
    name: e.variant.name,
    vintage: e.variant.vintage,
    nv: e.variant.tags.nv,
    row_indexes: e.rows.map((r) => r.rowIndex).sort((a, b) => a - b),
  }));

  const longTailRowIndexes = [...byId.values()].filter((e) => e.variant.tags.longTail).flatMap((e) => e.rows.map((r) => r.rowIndex)).sort((a, b) => a - b);

  // nv_literal_rows — rows whose vintage cell is the literal text "NV".
  // Tagged as its own expected-invalid-under-current-importer group (see
  // row-validator.ts:86, which rejects non-numeric vintage text): a later
  // importer piece that special-cases the literal "NV" token must make
  // every one of these rows validate.
  const nvLiteralRows = [...byId.values()]
    .filter((e) => e.variant.tags.nvLiteral)
    .flatMap((e) =>
      e.rows.map((r) => ({
        row_index: r.rowIndex,
        producer: e.variant.producer,
        name: e.variant.name,
      })),
    )
    .sort((a, b) => a.row_index - b.row_index);

  let barcode = null;
  if (extras) {
    const withBarcode = records.filter((r) => r.extra.barcode);
    const allValid = withBarcode.every((r) => {
      const twelve = r.extra.barcode.slice(0, 12);
      const check = r.extra.barcode.slice(12);
      return String(computeEan13CheckDigit(twelve)) === check;
    });
    barcode = {
      enabled: true,
      rows_with_barcode: withBarcode.length,
      total_rows: records.length,
      coverage_pct: Math.round((withBarcode.length / records.length) * 1000) / 10,
      all_check_digits_valid: allValid,
    };
  }

  const dirtyRows = dirtyRecords.map((r) => ({
    row_index: r.rowIndex,
    category: r.dirtyCategory,
    detail: r.detail,
  }));

  return {
    generator_seed: SEED,
    generator_version: "1.0.0",
    flags: { extras, dirty: dirtyRecords.length > 0 },
    total_rows: records.length + dirtyRecords.length,
    clean_row_count: records.length,
    dirty_row_count: dirtyRecords.length,
    csv_sha256: sha256Hex(csvText),
    columns: headerRow(extras),
    expected_unique_variant_count: uniqueVariantsInFile,
    full_universe_variant_count: universeVariantCount,
    category_summary: {
      famous: categoryTotals.famous,
      nv: categoryTotals.nv,
      nv_literal_variants: categoryTotals.nvLiteral,
      long_tail: categoryTotals.longTail,
      adjacent_vintage_variants: categoryTotals.adjacentVintage,
      format_sibling_variants: categoryTotals.formatSibling,
      spelling_noise_variants: categoryTotals.spellingNoise,
    },
    duplicate_spelling_groups: duplicateSpellingGroups,
    adjacent_vintage_groups: adjacentVintageGroups,
    format_sibling_groups: formatSiblingGroups,
    nv_variants: nvVariants,
    famous_variants: famousVariants,
    long_tail_row_indexes: longTailRowIndexes,
    barcode,
    dirty_rows: dirtyRows,
    nv_literal_rows: nvLiteralRows,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { extras: false, dirty: false, sampleOnly: false, outDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--extras") args.extras = true;
    else if (a === "--dirty") args.dirty = true;
    else if (a === "--sample-only") args.sampleOnly = true;
    else if (a === "--out-dir") args.outDir = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataset = generateDataset({ seed: SEED, extras: args.extras, dirty: args.dirty });
  const universeVariantCount = dataset.variants.length;

  if (args.sampleOnly) {
    const sampleRecords = dataset.records.slice(0, SAMPLE_ROWS);
    const sampleDirty = dataset.dirtyRecords.map((r, i) => ({ ...r, rowIndex: sampleRecords.length + i + 1 }));
    const csvText = toCsvText(sampleRecords, sampleDirty, args.extras);
    const manifest = buildManifest(sampleRecords, sampleDirty, args.extras, csvText, universeVariantCount);
    const outDir = args.outDir ?? "fixtures";
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "partner-cellar-sample-500.csv"), csvText);
    writeFileSync(join(outDir, "partner-cellar-sample-500.manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Wrote ${outDir}/partner-cellar-sample-500.csv (${sampleRecords.length + sampleDirty.length} data rows) + manifest`);
  } else {
    const csvText = toCsvText(dataset.records, dataset.dirtyRecords, args.extras);
    const manifest = buildManifest(dataset.records, dataset.dirtyRecords, args.extras, csvText, universeVariantCount);
    const outDir = args.outDir ?? join("fixtures", "generated");
    mkdirSync(outDir, { recursive: true });
    // --extras gets its own filename (rather than overwriting the base
    // file) so a single run can produce both variants side by side — this
    // is what lets run-bulk-import-test.sh validate the extras/barcode
    // path in the same default invocation as the base file.
    const baseName = args.extras ? "partner-cellar-20k-extras" : "partner-cellar-20k";
    writeFileSync(join(outDir, `${baseName}.csv`), csvText);
    writeFileSync(join(outDir, `${baseName}.manifest.json`), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Wrote ${outDir}/${baseName}.csv (${dataset.records.length + dataset.dirtyRecords.length} data rows) + manifest`);
    console.log(`Unique variants: ${universeVariantCount}`);
  }
}

const isMain = process.argv[1] && (() => {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) main();

export { generateDataset, buildManifest, toCsvText, headerRow, FORMAT_LABEL };
