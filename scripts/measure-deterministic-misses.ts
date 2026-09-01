/**
 * Runs the deterministic-miss-corpus (fixtures/deterministic-miss-corpus.json,
 * 180 cases) through both deterministic parsers — parseSearchQuery (GET
 * /api/search) and parseAssistantQuery (GET /api/assistant) — via
 * measureCase(), prints the classification counts, and writes
 * docs/plans/2026-09-01-deterministic-miss-corpus.md: the evidence
 * docs/plans/2026-09-01-tier-2-struct-compile-ops-spec.md §6 decision 4 asks
 * for before deciding whether tier 2 struct-compile ships — "do steps 1-2,
 * measure what still misses, and decide tier 2 against that evidence".
 *
 * Read-only and offline: no network call, no database, no model. Every
 * number below is reproducible by re-running this script — the corpus, the
 * tenant vocabulary snapshot, and the parsers are all checked-in inputs.
 *
 * Usage:
 *   npx tsx scripts/measure-deterministic-misses.ts
 */
import { writeFileSync } from "node:fs";
import corpus from "../src/lib/wine-intelligence/fixtures/deterministic-miss-corpus.json";
import vocabularyFixture from "../src/lib/wine-intelligence/fixtures/demo-tenant-vocabulary.json";
import baseline from "../src/lib/wine-intelligence/fixtures/deterministic-coverage-baseline.json";
import {
  measureCase,
  type MissCorpusCase,
  type Classification,
  type MeasureResult,
} from "../src/lib/wine-intelligence/deterministic-coverage";
import type { AssistantVocabulary } from "../src/lib/wine-intelligence/assistant-query";
import { TYPE_PHRASES, PAIRING_PHRASES, normalize } from "../src/lib/wine-intelligence/assistant-lexicon";
import { COLOUR_INDEX, REGION_INDEX } from "../src/lib/unified-search/wine-gazetteer";

const vocabulary = vocabularyFixture.vocabulary as AssistantVocabulary;
const cases = corpus.cases as MissCorpusCase[];

type Bucket = Classification | "knownWrong";
type Row = { case: MissCorpusCase; result: MeasureResult; bucket: Bucket };

const rows: Row[] = cases.map((c) => {
  const result = measureCase(c, vocabulary);
  const bucket: Bucket = result.classification === "wrong" && c.knownWrong ? "knownWrong" : result.classification;
  return { case: c, result, bucket };
});

const BUCKET_ORDER: Bucket[] = ["answered", "partial", "tier2", "tier3", "missed", "knownWrong"];
const counts: Record<Bucket, number> = { answered: 0, partial: 0, tier2: 0, tier3: 0, missed: 0, wrong: 0, knownWrong: 0 };
for (const r of rows) counts[r.bucket] += 1;

// ── Print the table ────────────────────────────────────────────────────
console.log("Deterministic miss corpus — 180 cases, LOCAL SEED - Osteria Scala\n");
console.log("classification".padEnd(16), "count", "pct");
for (const b of BUCKET_ORDER) {
  console.log(b.padEnd(16), String(counts[b]).padEnd(6), `${((counts[b] / cases.length) * 100).toFixed(1)}%`);
}
console.log(`\nUnexcused wrong: ${counts.wrong} (must be 0). knownWrong (excused): ${counts.knownWrong}.`);

// ── Evidence-backed "cheap fix" detectors ──────────────────────────────
// Each checks GROUND TRUTH (the fixed vocabularies the parsers actually
// match against) rather than guessing from prose, so every case id listed
// below is a verified claim, not a hunch.

interface Recommendation {
  title: string;
  detail: string;
  ids: string[];
}

const ASSISTANT_TYPE_VALUES = new Set(TYPE_PHRASES.map((p) => p.value));
const SEARCH_TYPE_VALUES = new Set([...COLOUR_INDEX.values()].map((e) => e.canonical));
const GAZETTEER_REGIONS = new Set([...REGION_INDEX.values()].map((e) => e.canonical));

const nonAnswered = rows.filter((r) => r.bucket !== "answered" && r.bucket !== "tier3");

function missingField(r: Row, field: string): boolean {
  return r.case.expected[field as keyof MissCorpusCase["expected"]] !== undefined && !r.result.matched.includes(field);
}

const barePrice = nonAnswered.filter(
  (r) =>
    (missingField(r, "priceMin") || missingField(r, "priceMax")) &&
    !/\$/.test(r.case.query) &&
    /\b\d+\b/.test(r.case.query) &&
    /\b(under|over|less than|more than|cheaper than|nothing over|no more than|about|around)\b/i.test(r.case.query),
);

/** Whether the tenant's own grape vocabulary already holds `name` — either
 *  as an exact value ("Cabernet Sauvignon"), or as one whole word inside a
 *  compound value ("Shiraz" inside "Syrah/Shiraz", X-Wines' combined name
 *  for that grape). Either way, bestVocabularyMatch simply requires the
 *  exact phrase; a single-word everyday name for it is the gap, not the
 *  tenant's stock. */
function tenantHoldsGrape(name: string): boolean {
  const wanted = name.toLowerCase();
  return vocabulary.grape.some((g) => {
    const lower = g.toLowerCase();
    if (lower === wanted) return true;
    return lower.split(/[^a-z]+/).filter(Boolean).includes(wanted);
  });
}

const grapeAbbreviation = nonAnswered.filter(
  (r) => missingField(r, "grape") && tenantHoldsGrape(r.case.expected.grape ?? ""),
);

const grapeDataGap = nonAnswered.filter(
  (r) => missingField(r, "grape") && !tenantHoldsGrape(r.case.expected.grape ?? ""),
);

const regionSurfaceTermGap = nonAnswered.filter(
  (r) => missingField(r, "region") && GAZETTEER_REGIONS.has(r.case.expected.region ?? ""),
);

const regionMissingEntirely = nonAnswered.filter(
  (r) => missingField(r, "region") && !GAZETTEER_REGIONS.has(r.case.expected.region ?? ""),
);

const typeSynonymGap = nonAnswered.filter(
  (r) =>
    missingField(r, "type") &&
    (ASSISTANT_TYPE_VALUES.has(r.case.expected.type ?? "") || SEARCH_TYPE_VALUES.has(r.case.expected.type ?? "")),
);

const pairingPluralGap = nonAnswered.filter((r) => {
  const expectedPairing = r.case.expected.pairing;
  if (!expectedPairing) return false;
  const produced = new Set((r.result.assistantQuery.pairing ?? []).map((p) => p.toLowerCase()));
  const missingValues = expectedPairing.filter((v) => !produced.has(v.toLowerCase()));
  if (missingValues.length === 0) return false;
  const words = normalize(r.case.query).split(" ");
  return words.some(
    (w) =>
      w.endsWith("s") &&
      w.length > 3 &&
      PAIRING_PHRASES.some(
        ({ values, phrases }) => values.some((v) => missingValues.includes(v)) && phrases.includes(w.slice(0, -1)),
      ),
  );
});

const vintageRange = nonAnswered.filter(
  (r) => missingField(r, "vintages") && /\b\d{4}\s+to\s+\d{4}\b/.test(r.case.query),
);

const recommendations: Recommendation[] = [
  {
    title: 'Read a bare digit as a price when a comparator word is present, even with no "$"',
    detail:
      'parseAssistantQuery\'s parsePrice() only reads a number as a price when it is preceded by "$" or ' +
      'followed by "dollars"/"bucks"/"usd" — documented, current behaviour, not a bug. Every case below carries ' +
      'an explicit comparator word ("under", "over", "cheaper than", "about", …) immediately next to a digit ' +
      'sequence, which is as strong a signal as a currency mark. This is the single biggest recoverable group ' +
      'in the corpus. NOTE what this does NOT cover: a handful of other cases spell the number out ("under ' +
      'sixty", "under a hundred") — recovering those needs a words-to-numbers table, a materially bigger lift ' +
      "than dropping the \"$\" requirement, so they are left in \"What only tier 2 recovers\" below rather than " +
      "claimed here.",
    ids: barePrice.map((r) => r.case.id),
  },
  {
    title: "Match a single-word grape name onto the tenant's compound-name value",
    detail:
      "The tenant's own vocabulary (verified against demo-tenant-vocabulary.json) already holds the expected " +
      "grape — either that exact value, or as one whole word inside a compound value X-Wines stores as a " +
      'single string (e.g. "Shiraz" inside "Syrah/Shiraz") — but the query used a shorter, everyday form ' +
      "that bestVocabularyMatch (assistant-query.ts) requires as an exact phrase today. A small grape alias " +
      "table, the same shape countrySurfaceTerms/regionSurfaceTerms already are, would close this without " +
      "touching the matching engine.",
    ids: grapeAbbreviation.map((r) => r.case.id),
  },
  {
    title: "Grape names this tenant genuinely does not stock (data gap, not a lexicon gap)",
    detail:
      "The expected grape is not in the tenant's own vocabulary in any form — no lexicon change recovers " +
      "these, because the 250-wine demo cellar simply holds no bottling of that grape. Listed for " +
      "completeness, not as a fix candidate.",
    ids: grapeDataGap.map((r) => r.case.id),
  },
  {
    title: "Add an adjectival surface term for a region the gazetteer already knows",
    detail:
      'wine-gazetteer.ts\'s REGION_TERMS already maps "Tuscany" from "tuscany"/"toscana", but not from the ' +
      'adjective "Tuscan" people actually say ("Tuscan red", "a Tuscan bottle"). One surface term per region ' +
      "recovers the case regardless of whether any tenant stocks that region.",
    ids: regionSurfaceTermGap.map((r) => r.case.id),
  },
  {
    title: "Add a region the gazetteer has no entry for at all",
    detail:
      'Not a missing spelling of a known region — the canonical region itself ("Chianti") is absent from ' +
      "REGION_TERMS. A new entry, not a new surface term.",
    ids: regionMissingEntirely.map((r) => r.case.id),
  },
  {
    title: "Add a colloquial type synonym to an existing phrase list",
    detail:
      '"champers" (slang for Champagne/sparkling) and "port" (for the Fortified colour the search gazetteer ' +
      'already has a slot for) both name a TYPE_PHRASES/COLOUR_TERMS value that exists today; only the surface ' +
      "word is missing from its phrase list.",
    ids: typeSynonymGap.map((r) => r.case.id),
  },
  {
    title: "Add a plural to a singular-only pairing phrase",
    detail:
      'The same class of gap "cured meat"/"cured meats" was (fixed in this slice, assistant-lexicon.ts) — ' +
      'PAIRING_PHRASES\' Appetizer entry lists "appetizer" but not "appetizers".',
    ids: pairingPluralGap.map((r) => r.case.id),
  },
  {
    title: "Read a written-out vintage RANGE, not just the two literal years typed",
    detail:
      'parseVintages has no notion of a range: "2018 to 2020" reads as exactly the two numbers present ' +
      "(2018, 2020), silently missing the implied 2019 in between. This is a small feature, not a lexicon " +
      "entry — flagged here rather than fixed, since it needs its own design for what \"to\" means next to a " +
      "non-price number.",
    ids: vintageRange.map((r) => r.case.id),
  },
].filter((r) => r.ids.length > 0);

const cheapFixIds = new Set(recommendations.flatMap((r) => r.ids));
const tier2Only = nonAnswered.filter((r) => !cheapFixIds.has(r.case.id));

// ── Write the report ────────────────────────────────────────────────────
const lines: string[] = [];
const push = (s = "") => lines.push(s);

push("# Deterministic miss corpus — measured");
push();
push(
  `**Date:** 2026-09-01 · **Status:** RUN, evidence below · Feeds ` +
    "docs/plans/2026-09-01-tier-2-struct-compile-ops-spec.md §6 decision 4",
);
push();
push(
  "**Question:** with the two deterministic parsers as they stand today — parseSearchQuery (GET " +
    "/api/search, global gazetteer) and parseAssistantQuery (GET /api/assistant, this tenant's own " +
    "vocabulary) — what fraction of a realistic query corpus do they answer, and what does the residual " +
    "actually look like? This is the \"measure what still misses\" step the ops spec asks for before any " +
    "tier-2 provider call is built.",
);
push();
push(
  "**Method.** `src/lib/wine-intelligence/fixtures/deterministic-miss-corpus.json` (180 hand-written cases " +
    "across six lenses — sommelier-at-service, guest-at-table, buyer-manager, colloquial-typos, " +
    "occasion-comparative, multi-constraint — each with an `expected` struct a good deterministic parse " +
    "should produce) runs through both parsers via `measureCase()` " +
    "(`src/lib/wine-intelligence/deterministic-coverage.ts`), against " +
    "`src/lib/wine-intelligence/fixtures/demo-tenant-vocabulary.json` — the ACTUAL distinct country/region/" +
    `grape values of the "LOCAL SEED - Osteria Scala" demo tenant (${(vocabularyFixture as { wineCount: number }).wineCount} wines, ` +
    `${vocabulary.country.length} countries, ${vocabulary.region.length} regions, ${vocabulary.grape.length} grape values), ` +
    "built exactly the way `GET /api/assistant` builds it, measured on the local loopback stack. A field " +
    "counts as recovered if EITHER parser produces it — the two entry points cover different ground (search " +
    "matches a global gazetteer regardless of tenant stock; the assistant matches only what this tenant " +
    "actually holds), and the corpus measures the combined deterministic lane, not either parser alone. " +
    "Five real parser bugs turned up while building this corpus and are fixed in this same slice " +
    "(see \"Bugs found and fixed\" below); two could not be fixed safely here and are recorded as " +
    "`knownWrong` on their case with a reason, per the acceptance test's own rule.",
);
push();
push("Re-run: `npx tsx scripts/measure-deterministic-misses.ts`. Offline, deterministic, no network/DB/model call.");
push();
push("## Counts");
push();
push("| classification | count | % of 180 | meaning |");
push("|---|---|---|---|");
push(`| answered | ${counts.answered} | ${((counts.answered / 180) * 100).toFixed(1)}% | every expected field matched |`);
push(`| partial | ${counts.partial} | ${((counts.partial / 180) * 100).toFixed(1)}% | some but not all expected fields matched |`);
push(`| tier2 | ${counts.tier2} | ${((counts.tier2 / 180) * 100).toFixed(1)}% | paraphrase-only, nothing captured |`);
push(`| tier3 | ${counts.tier3} | ${((counts.tier3 / 180) * 100).toFixed(1)}% | occasion / comparative / open-question |`);
push(`| missed | ${counts.missed} | ${((counts.missed / 180) * 100).toFixed(1)}% | nothing captured, not paraphrase-only |`);
push(`| wrong (unexcused) | ${counts.wrong} | — | must be 0 — the acceptance test enforces it |`);
push(`| knownWrong (excused) | ${counts.knownWrong} | — | classifies wrong; reason recorded on the case |`);
push();
push(
  `Ratchet baseline (\`fixtures/deterministic-coverage-baseline.json\`): answered ${baseline.counts.answered} → ${counts.answered}, ` +
    `missed+tier2 ${baseline.counts.missed + baseline.counts.tier2} → ${counts.missed + counts.tier2}.`,
);
push();
push("## Bugs found and fixed in this slice");
push();
push(
  "Building the corpus surfaced real precision failures — a parser confidently asserting something the " +
    "query contradicted, the exact class §2.2 of the ops spec already flagged once for assistant-query.ts's " +
    "negation handling. Each is fixed with its own failing test, not patched around:",
);
push();
push(
  "1. **query-parse.ts had NO negation handling at all.** \"no reds tonight\" filtered TO reds — " +
    "`colours: [\"Red\"]`, `understood: true` — the inverse of the question, with total confidence. " +
    "assistant-query.ts got this fix already (§2.2); it had never been ported to the search parser. Fixed " +
    "by porting the same backward-lookback negation walk onto this module's own token model " +
    "(`query-parse.test.ts`, \"negation is never read as affirmation\").",
);
push(
  "2. **A trailing comma or period silently broke every match.** `foldTerm()` never stripped punctuation, " +
    'so "Rioja," and "2016," never matched their gazetteer/vintage patterns — `parseSearchQuery("Rioja, ' +
    'please")` returned an EMPTY parse, `understood: false`, for one of the most ordinary sommelier queries ' +
    "in the corpus. This was not a corpus-only artifact: it broke matching for every field this function " +
    'gates (country/region/colour/body AND the 4-digit vintage check), for any token immediately followed ' +
    "by punctuation — a common shape in real prose. Fixed in `foldTerm()` (wine-gazetteer.ts).",
);
push(
  "3. **\"$100\" was read as the \"100% single varietal\" idiom.** SINGLE_VARIETAL_PHRASES matched a bare " +
    '"100" unconditionally, so \"a blend from Priorat, over $100\" set `blend: false` from the PRICE digits, ' +
    'before the actual word \"blend\" a few tokens later was ever considered — because normalize() strips ' +
    'the "%" that would otherwise tell "100% Malbec" and "$100" apart. Fixed by checking the raw text for ' +
    'literal "100%" instead of matching a bare digit.',
);
push(
  '4. **"anything but another Malbec" and "nothin too full bodied" leaked their negation.** Two lexicon ' +
    'gaps in NEGATION_PHRASES/FILLER_WORDS: "another" and "too" are pass-through words with no facet of ' +
    'their own, but sat between a real negation trigger and its target, ending the backward walk one step ' +
    'short; "nothing"/"nothin" were never in NEGATION_PHRASES at all (only "no"/"not" were).',
);
push(
  '5. **"cured meats" (plural) fell through to the generic "meats" catch-all** instead of the specific ' +
    "Cured Meat pairing value — not false, just far less specific than asked. Added the plural to that " +
    "phrase's list.",
);
push();
push(
  "Two cases still classify `wrong` and are excused with `knownWrong` on the case (both real, both " +
    "deliberately deferred — see the field's own reason for detail):",
);
push();
push(
  "- **sas-18** — negation POSTPOSED across a relative clause (\"that Malbec they didn't love\"); the " +
    "negation-walk design only looks backward from a facet, and this negation trails it by several words. " +
    "Needs real clause-level parsing, not a lexicon fix.",
);
push(
  "- **occ-09** — parsePrice's upper/lower comparator regex tests the WHOLE normalized query, not a window " +
    'around the matched amount, so an unrelated "over" elsewhere in the sentence ("friends over for pasta ' +
    'night") hijacks a lone-figure price band. Real bug; the fix touches every price pattern parsePrice ' +
    "handles and needs its own dedicated test pass.",
);
push();
push("## Every non-answered case, by classification");

const label: Record<Bucket, string> = {
  answered: "answered",
  partial: "Partial — some fields matched, some missing",
  tier2: "Tier 2 — paraphrase-only, nothing captured",
  tier3: "Tier 3 — occasion / comparative / open-question",
  missed: "Missed — nothing captured, not paraphrase-only",
  wrong: "wrong",
  knownWrong: "Known wrong (excused, reason on the case)",
};

for (const b of ["partial", "tier2", "missed", "knownWrong", "tier3"] as Bucket[]) {
  const bucketRows = rows.filter((r) => r.bucket === b);
  if (bucketRows.length === 0) continue;
  push();
  push(`### ${label[b]} (${bucketRows.length})`);
  push();
  push("| id | lens | query | missing | unrecognized |");
  push("|---|---|---|---|---|");
  for (const r of bucketRows) {
    const missing = b === "knownWrong" ? r.result.wrong.join("; ") : r.result.missing.join(", ") || "—";
    const unrec = r.result.unrecognized.join(", ") || "—";
    push(`| ${r.case.id} | ${r.case.lens} | ${r.case.query.replace(/\|/g, "\\|")} | ${missing} | ${unrec} |`);
  }
}

push();
push("## What a cheap deterministic fix would recover");
push();
push(
  "Evidence, not opinion: each row below is a set of case ids computed straight from the measured results " +
    "above (see this script), grouped by the SAME underlying lexicon change. None of these are applied in " +
    "this slice except where already listed under \"Bugs found and fixed\" — this section is the input to " +
    "ops spec §6 decision 4, not a decision of its own.",
);
push();
for (const r of recommendations) {
  push(`### ${r.title} (${r.ids.length} case${r.ids.length === 1 ? "" : "s"})`);
  push();
  push(r.detail);
  push();
  push(`Cases: ${r.ids.join(", ")}`);
  push();
}

push("## What only tier 2 recovers");
push();
push(
  `${tier2Only.length} of the ${nonAnswered.length} non-answered, non-tier3 cases are not explained by any ` +
    "cheap fix above — genuine paraphrase, slang, or multi-clause phrasing outside any fixed phrase list, " +
    "which is tier 2's actual residual job per ops spec §2:",
);
push();
push("| id | lens | query | unrecognized |");
push("|---|---|---|---|");
for (const r of tier2Only) {
  push(`| ${r.case.id} | ${r.case.lens} | ${r.case.query.replace(/\|/g, "\\|")} | ${r.result.unrecognized.join(", ") || "—"} |`);
}

const reportPath = "docs/plans/2026-09-01-deterministic-miss-corpus.md";
writeFileSync(reportPath, lines.join("\n") + "\n");
console.log(`\nWrote ${reportPath}`);
